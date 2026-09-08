import {
  ATTACK_BUFFER_MS,
  DASH_CD,
  DASH_IFRAME_MS,
  DASH_MS,
  DASH_SPEED,
  KNOCKBACK_DECAY,
  KNOCKBACK_EPSILON,
  PLAYER_ACCEL,
  PLAYER_BASE_HP,
  PLAYER_FRICTION,
  TILE,
} from '../core/constants';
import { Action, Input } from '../core/input';
import { normalize, scratchA } from '../core/math';
import { addTrauma } from '../render/camera';
import { PKind } from '../render/fx';
import { Tint } from '../render/lighting';
import { classById } from '../content/classes';
import { CONSUMABLE_REGISTRY, RELIC_REGISTRY } from '../content';
import { perkById } from '../content/perks';
import { coneHit, moveCircle } from './collision';
import { Tile } from './tiles';
import { applyDamage } from './combat';
import type { GameCtx } from './ctx';
import {
  AtkPhase,
  EKind,
  Flags,
  blankStats,
  type Entity,
  isTargetable,
} from './entities';

/**
 * The player.
 *
 * The attack state machine is the highest-leverage code in the project, so the
 * two decisions that define how it feels are worth stating plainly:
 *
 *  - Facing is LATCHED at the Windup -> Active boundary, not sampled per tick.
 *    Letting the player re-aim mid-swing makes the arc feel like a vacuum
 *    cleaner and removes all sense of commitment.
 *  - Movement is throttled per phase rather than stopped. You can still
 *    reposition through a swing, just not escape one.
 */

// ------------------------------------------------------------ derived stats

/**
 * Rebuild the cached stat block from relics, perks, the class and any shrines
 * taken. Called whenever any of those change — never per frame.
 */
export function recomputeStats(player: Entity): void {
  const p = player.player;
  if (!p) return;

  const s = blankStats();
  const cls = classById(p.classId);

  for (const [id, stacks] of Object.entries(p.relics)) {
    if (stacks <= 0) continue;
    RELIC_REGISTRY[id]?.apply(s, stacks);
  }
  for (const id of p.perks) {
    perkById(id)?.apply(s);
  }

  // Shrines are run-permanent but are not stacks, so they fold in here rather
  // than being recomputable from an item list.
  s.dmgMul += p.shrineDmgBonus;
  s.moveMul *= p.shrineMoveMul;

  // Level-up contributions.
  const levels = p.level - 1;
  s.dmgMul += 0.03 * levels;

  p.stats = s;
  p.secondWindLeft = Math.min(p.secondWindLeft, s.secondWindMax);

  const base = cls.hp + 8 * levels + s.maxHpBonus + p.shrineHpBonus;
  const newMax = Math.max(10, Math.round(base * s.maxHpMul * p.shrineHpMul));
  const ratio = player.hpMax > 0 ? player.hp / player.hpMax : 1;
  player.hpMax = newMax;
  // Preserve the health FRACTION when max health changes. Otherwise picking up
  // a Glass Fang at full health would deal you damage, and picking up an Iron
  // Shard at 10% would feel like nothing happened.
  player.hp = Math.max(1, Math.min(newMax, Math.round(newMax * ratio)));
  player.speed = cls.speedMult * 180 * s.moveMul;
}

/** Add a relic and refresh the cache. */
export function grantRelic(ctx: GameCtx, id: string): boolean {
  const p = ctx.player.player;
  const def = RELIC_REGISTRY[id];
  if (!p || !def) return false;
  p.relics[id] = (p.relics[id] ?? 0) + 1;
  recomputeStats(ctx.player);
  def.onPickup?.(ctx.player, ctx, p.relics[id]);
  // Refill Second Wind charges the moment the relic is picked up rather than on
  // the next floor, so the safety net is never a floor late.
  p.secondWindLeft = p.stats.secondWindMax;
  return true;
}

export function relicStacks(player: Entity, id: string): number {
  return player.player?.relics[id] ?? 0;
}

// ----------------------------------------------------------------- the tick

export function updatePlayer(ctx: GameCtx, dt: number): void {
  const e = ctx.player;
  const p = e.player;
  if (!p || !e.alive) return;

  e.px = e.x;
  e.py = e.y;

  const dtMs = dt * 1000;
  if (e.iframes > 0) e.iframes -= dtMs;
  if (e.flash > 0) e.flash -= dtMs;
  if (e.stun > 0) e.stun -= dtMs;
  if (p.dashCd > 0) p.dashCd -= dtMs;
  if (p.buffAtkSpeedT > 0) p.buffAtkSpeedT -= dtMs;
  if (p.buffMoveT > 0) p.buffMoveT -= dtMs;
  if (p.invisT > 0) p.invisT -= dtMs;

  classById(p.classId).onTick?.(e, ctx, dt);

  updateAim(ctx, e, p);
  updateDash(ctx, e, p, dt);
  updateAttack(ctx, e, p, dt);
  updateLocomotion(ctx, e, p, dt);
  updateConsumables(ctx, e, p);
  magnetPickups(ctx, e, p, dt);
}

function updateAim(ctx: GameCtx, e: Entity, p: NonNullable<Entity['player']>): void {
  if (Input.aimSource === 'pointer') {
    // Recomputed from the stored screen position every tick rather than cached
    // on pointermove, so the aim stays correct while the camera moves.
    const wx = ctx.aimWorldX;
    const wy = ctx.aimWorldY;
    normalize(wx - e.x, wy - e.y, scratchA);
    if (scratchA.x !== 0 || scratchA.y !== 0) {
      p.aimX = scratchA.x;
      p.aimY = scratchA.y;
    }
  } else if (Input.aimX !== 0 || Input.aimY !== 0) {
    p.aimX = Input.aimX;
    p.aimY = Input.aimY;
  }

  // Touch aim assist: snap to the nearest hostile inside a narrow cone. Not
  // optional — freehand cone aiming with a thumb is miserable.
  if (Input.touchActive) {
    const target = ctx.world.nearestHostile(e.x, e.y, 180);
    if (target) {
      normalize(target.x - e.x, target.y - e.y, scratchA);
      if (scratchA.x * p.aimX + scratchA.y * p.aimY > Math.cos(0.61)) {
        p.aimX = scratchA.x;
        p.aimY = scratchA.y;
      }
    }
  }

  if (p.atk === AtkPhase.Idle || p.atk === AtkPhase.Windup) {
    e.faceX = p.aimX;
    e.faceY = p.aimY;
  }
}

function updateDash(
  ctx: GameCtx,
  e: Entity,
  p: NonNullable<Entity['player']>,
  dt: number,
): void {
  if (p.dashT > 0) {
    p.dashT -= dt * 1000;
    if (p.dashT <= 0) p.dashT = 0;
    ctx.fx.particle(
      e.x - p.dashDirX * 6,
      e.y - p.dashDirY * 6,
      -p.dashDirX * 60,
      -p.dashDirY * 60,
      '#d8cfae',
      3,
      220,
      PKind.Streak,
      true,
      0.1,
    );
    return;
  }

  const wants = Input.pressed(Action.Dash) || Input.dashBuffer > 0;
  if (!wants || p.dashCd > 0 || e.stun > 0) return;
  Input.consumeDashBuffer();

  // Dash in the movement direction if moving, otherwise where you are aiming.
  let dx = Input.moveX;
  let dy = Input.moveY;
  if (dx === 0 && dy === 0) {
    dx = p.aimX;
    dy = p.aimY;
  }
  normalize(dx, dy, scratchA);
  p.dashDirX = scratchA.x;
  p.dashDirY = scratchA.y;
  p.dashT = DASH_MS;
  p.dashCd = DASH_CD * p.stats.dodgeCdMul;
  // Dash-through-an-enemy is the core skill expression, so the i-frames cover
  // the whole dash plus a small forgiving tail.
  e.iframes = Math.max(e.iframes, DASH_IFRAME_MS);
  // Cancelling a committed swing into a dash is the feel-good option. Allow it.
  p.atk = AtkPhase.Idle;
  p.atkT = 0;

  ctx.fx.burst(e.x, e.y, {
    color: '#f0e6d2',
    count: 12,
    speed: [40, 130],
    size: [1.4, 3],
    life: [180, 340],
    dirX: -p.dashDirX,
    dirY: -p.dashDirY,
    spread: 1.6,
  });
}

// ------------------------------------------------------------ attack machine

/** Phase durations, after attack-speed scaling. */
function atkSpeed(p: NonNullable<Entity['player']>): number {
  const buff = p.buffAtkSpeedT > 0 ? 1.4 : 1;
  return p.stats.atkSpeedMul * buff;
}

function updateAttack(
  ctx: GameCtx,
  e: Entity,
  p: NonNullable<Entity['player']>,
  dt: number,
): void {
  const w = p.weapon;
  const speed = atkSpeed(p);
  p.atkT -= dt * 1000;

  switch (p.atk) {
    case AtkPhase.Windup: {
      if (p.atkT > 0) break;
      p.atk = AtkPhase.Active;
      p.atkT = w.active / speed;
      p.atkSlice = 0;
      // Latch the swing direction. Everything from here is committed.
      p.swingX = p.aimX;
      p.swingY = p.aimY;
      e.faceX = p.swingX;
      e.faceY = p.swingY;
      e.hitSet.clear();
      spawnSwingFx(ctx, e, p);
      break;
    }

    case AtkPhase.Active: {
      const total = w.active / speed;
      const sliceLen = total / w.hits;
      const elapsed = total - Math.max(0, p.atkT);
      const slice = Math.min(w.hits - 1, Math.floor(elapsed / sliceLen));
      if (slice !== p.atkSlice) {
        // A new damage instance: clearing the hit set is what lets Twin Fangs
        // land twice per swing without letting a single slice hit four times.
        p.atkSlice = slice;
        e.hitSet.clear();
        spawnSwingFx(ctx, e, p);
      }
      resolveSwing(ctx, e, p);
      if (p.atkT <= 0) {
        p.atk = AtkPhase.Recovery;
        p.atkT = w.recovery / speed;
      }
      break;
    }

    case AtkPhase.Recovery: {
      if (p.atkT > 0) break;
      // A press during recovery still fires. 150ms is long enough that being a
      // frame early still lands, short enough that you never get a phantom
      // swing after you stopped attacking.
      if (Input.consumeAttackBuffer()) {
        p.combo = (p.combo + 1) % 3;
        enterWindup(p, speed);
      } else {
        p.atk = AtkPhase.Idle;
        p.combo = 0;
      }
      break;
    }

    default: {
      if (e.stun > 0) break;
      const held = ctx.autoAttack && Input.held(Action.Attack);
      if (Input.attackBuffer > 0 || held) {
        Input.consumeAttackBuffer();
        p.combo = 0;
        enterWindup(p, speed);
      }
      break;
    }
  }
}

function enterWindup(p: NonNullable<Entity['player']>, speed: number): void {
  p.atk = AtkPhase.Windup;
  p.atkT = p.weapon.windup / speed;
}

function spawnSwingFx(ctx: GameCtx, e: Entity, p: NonNullable<Entity['player']>): void {
  const w = p.weapon;
  const reach = w.reach * p.stats.reachMul;
  const a = Math.atan2(p.swingY, p.swingX);
  const half = w.halfArc * p.stats.arcMul;
  for (let i = 0; i < 7; i++) {
    const t = i / 6 - 0.5;
    const ang = a + t * half * 2;
    ctx.fx.particle(
      e.x + Math.cos(ang) * reach * 0.85,
      e.y + Math.sin(ang) * reach * 0.85,
      Math.cos(ang) * 40,
      Math.sin(ang) * 40,
      w.color,
      2.2,
      110,
      PKind.Dot,
      true,
      0.05,
    );
  }
}

/** Cone test against every hostile, once per damage slice. */
function resolveSwing(ctx: GameCtx, e: Entity, p: NonNullable<Entity['player']>): void {
  const w = p.weapon;
  const s = p.stats;
  const reach = w.reach * s.reachMul;
  const half = w.halfArc * s.arcMul;
  const cosHalf = Math.cos(Math.min(Math.PI, half));
  const comboFinisher = p.combo === 2;

  const world = ctx.world;
  for (let i = 0; i < world.ents.length; i++) {
    const t = world.ents[i];
    if (!isTargetable(t)) continue;
    if (e.hitSet.has(t.id)) continue;
    const arc = comboFinisher ? Math.cos(Math.min(Math.PI, half * 1.3)) : cosHalf;
    if (!coneHit(e.x, e.y, p.swingX, p.swingY, arc, reach, t)) continue;

    e.hitSet.add(t.id);
    const dealt = strike(ctx, e, p, t, 1, comboFinisher);

    // Ricochet: bounce to nearby targets the swing did not reach.
    if (s.bounceTargets > 0 && dealt > 0) {
      bounce(ctx, e, p, t, s.bounceTargets);
    }
  }
}

function bounce(
  ctx: GameCtx,
  e: Entity,
  p: NonNullable<Entity['player']>,
  from: Entity,
  targets: number,
): void {
  let source = from;
  const world = ctx.world;
  for (let n = 0; n < targets; n++) {
    let best: Entity | null = null;
    let bestD2 = 150 * 150;
    for (let i = 0; i < world.ents.length; i++) {
      const t = world.ents[i];
      if (!isTargetable(t) || e.hitSet.has(t.id)) continue;
      const dx = t.x - source.x;
      const dy = t.y - source.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = t;
      }
    }
    if (!best) return;
    e.hitSet.add(best.id);
    ctx.fx.particle(
      (source.x + best.x) * 0.5,
      (source.y + best.y) * 0.5,
      (best.x - source.x) * 1.4,
      (best.y - source.y) * 1.4,
      '#f2f6fa',
      2.2,
      150,
      PKind.Streak,
      true,
      0.02,
    );
    strike(ctx, e, p, best, 0.55, false);
    source = best;
  }
}

/** One damage instance, with every player-side multiplier folded in. */
function strike(
  ctx: GameCtx,
  e: Entity,
  p: NonNullable<Entity['player']>,
  target: Entity,
  scale: number,
  finisher: boolean,
): number {
  const w = p.weapon;
  const s = p.stats;
  let dmg = w.dmg * s.dmgMul * scale;

  if (finisher) dmg *= 1.5;
  if (s.lowHpDamage > 0 && e.hp / e.hpMax < 0.4) dmg *= 1 + s.lowHpDamage;
  if (s.execBonus > 0 && target.hp / target.hpMax < 0.25) dmg *= 1 + s.execBonus;

  const critChance = s.critChance + w.critBonus;
  const isCrit = critChance > 0 && ctx.rng.chance(critChance);
  if (isCrit) dmg *= s.critMul;

  const knockback = w.knockback * (finisher ? 1.8 : 1) * scale;

  const dealt = applyDamage(ctx, target, dmg, {
    srcX: e.x,
    srcY: e.y,
    knockback,
    isCrit,
    pierceShield: w.pierceShield || s.pierceShield,
    hitstop: finisher ? w.hitstop + 30 : w.hitstop,
    stun: finisher ? 220 : undefined,
    fromPlayer: true,
  });

  if (finisher && dealt > 0) {
    // A small forward lunge on the finisher, so the third swing of a chain
    // reads as heavier than the first two.
    e.kx += p.swingX * 180;
    e.ky += p.swingY * 180;
    addTrauma(ctx.camera, 0.1);
  }
  return dealt;
}

// -------------------------------------------------------------- locomotion

function phaseMoveMul(p: NonNullable<Entity['player']>): number {
  switch (p.atk) {
    case AtkPhase.Windup:
      return p.weapon.windupMoveMul;
    case AtkPhase.Active:
      return p.weapon.activeMoveMul;
    case AtkPhase.Recovery:
      return p.weapon.recoveryMoveMul;
    default:
      return 1;
  }
}

function updateLocomotion(
  ctx: GameCtx,
  e: Entity,
  p: NonNullable<Entity['player']>,
  dt: number,
): void {
  // Knockback decays on its own channel so a stunned or mid-swing player still
  // gets pushed, and so walls stop knockback for free.
  const decay = Math.pow(KNOCKBACK_DECAY, dt * 60);
  e.kx *= decay;
  e.ky *= decay;
  if (Math.abs(e.kx) < KNOCKBACK_EPSILON) e.kx = 0;
  if (Math.abs(e.ky) < KNOCKBACK_EPSILON) e.ky = 0;

  if (p.dashT > 0) {
    e.vx = p.dashDirX * DASH_SPEED;
    e.vy = p.dashDirY * DASH_SPEED;
  } else if (e.stun > 0) {
    e.vx = 0;
    e.vy = 0;
  } else {
    const moveBuff = p.buffMoveT > 0 ? 1.2 : 1;
    const top = e.speed * phaseMoveMul(p) * moveBuff * e.slowMul;
    const wantX = Input.moveX * top;
    const wantY = Input.moveY * top;
    const accel = Input.moveX === 0 && Input.moveY === 0 ? PLAYER_FRICTION : PLAYER_ACCEL;
    const step = accel * dt;

    const dx = wantX - e.vx;
    const dy = wantY - e.vy;
    const l = Math.sqrt(dx * dx + dy * dy);
    if (l <= step || l < 1e-4) {
      e.vx = wantX;
      e.vy = wantY;
    } else {
      e.vx += (dx / l) * step;
      e.vy += (dy / l) * step;
    }
  }

  const drag = ctx.map.dragAt(e.x, e.y);
  const res = moveCircle(ctx.map, e, (e.vx * drag + e.kx) * dt, (e.vy * drag + e.ky) * dt);
  if (res.hitX) {
    e.kx = 0;
    if (p.dashT > 0) e.vx = 0;
  }
  if (res.hitY) {
    e.ky = 0;
    if (p.dashT > 0) e.vy = 0;
  }

  // Footstep dust. Cheap, and it does a lot of work selling weight.
  const speed = Math.sqrt(e.vx * e.vx + e.vy * e.vy);
  if (speed > 40 && Math.random() < 0.25) {
    ctx.fx.particle(
      e.x + (Math.random() - 0.5) * 8,
      e.y + e.r * 0.7,
      (Math.random() - 0.5) * 20,
      -8 - Math.random() * 12,
      '#8d8272',
      1.4 + Math.random(),
      280,
      PKind.Dot,
      false,
      0.3,
    );
  }
}

// -------------------------------------------------------------- consumables

function updateConsumables(
  ctx: GameCtx,
  e: Entity,
  p: NonNullable<Entity['player']>,
): void {
  if (Input.pressed(Action.Use1)) useSlot(ctx, e, p, 0);
  if (p.slotCount > 1 && Input.pressed(Action.Use2)) useSlot(ctx, e, p, 1);
}

function useSlot(
  ctx: GameCtx,
  e: Entity,
  p: NonNullable<Entity['player']>,
  index: 0 | 1,
): void {
  const slot = p.slots[index];
  if (!slot.id || slot.count <= 0) return;
  const def = CONSUMABLE_REGISTRY[slot.id];
  if (!def) return;
  if (!def.use(e, ctx)) return;
  slot.count--;
  if (slot.count <= 0) slot.id = null;
  ctx.fx.transientLight(e.x, e.y, 130, 200, Tint.White);
}

/** Put a consumable into the first slot that will take it. Returns false if full. */
export function giveConsumable(player: Entity, id: string): boolean {
  const p = player.player;
  const def = CONSUMABLE_REGISTRY[id];
  if (!p || !def) return false;

  for (let i = 0; i < p.slotCount; i++) {
    const slot = p.slots[i];
    if (slot.id === id && slot.count < def.maxStack) {
      slot.count++;
      return true;
    }
  }
  for (let i = 0; i < p.slotCount; i++) {
    const slot = p.slots[i];
    if (!slot.id) {
      slot.id = id;
      slot.count = 1;
      return true;
    }
  }
  return false;
}

// ------------------------------------------------------------------ pickups

/**
 * Pull nearby pickups in, then collect on contact.
 *
 * The magnet exists because stopping to walk over a coin in the middle of a
 * fight is exactly the kind of friction that makes an action game feel
 * administrative.
 */
function magnetPickups(
  ctx: GameCtx,
  e: Entity,
  p: NonNullable<Entity['player']>,
  dt: number,
): void {
  const radius = p.stats.pickupRadius;
  const r2 = radius * radius;
  const world = ctx.world;

  for (let i = 0; i < world.ents.length; i++) {
    const item = world.ents[i];
    if (!item.alive || item.kind !== EKind.Pickup) continue;
    if ((item.flags & Flags.Pickupable) === 0) continue;

    const dx = e.x - item.x;
    const dy = e.y - item.y;
    const d2 = dx * dx + dy * dy;

    if (d2 < r2) {
      const d = Math.sqrt(d2) || 1;
      const pull = 260 * (1 - d / radius) + 80;
      item.vx += (dx / d) * pull * dt * 6;
      item.vy += (dy / d) * pull * dt * 6;
    }

    item.vx *= Math.pow(0.9, dt * 60);
    item.vy *= Math.pow(0.9, dt * 60);
    item.x += item.vx * dt;
    item.y += item.vy * dt;

    const touch = e.r + item.r;
    if (d2 < touch * touch) ctx.collectPickup(ctx, item);
  }
}

/** The player's own torch. Radius scales with relics and the floor modifier. */
export function playerLight(ctx: GameCtx): number {
  const p = ctx.player.player;
  const base = ctx.biome.palette.lightRadius;
  return base * (p ? p.stats.lightMul : 1) * ctx.lightMul;
}

/** Whether the player is standing on the exit staircase. */
export function onStairs(ctx: GameCtx): boolean {
  const e = ctx.player;
  const tx = Math.floor(e.x / TILE);
  const ty = Math.floor(e.y / TILE);
  return ctx.map.at(tx, ty) === Tile.StairsDown;
}

export const PLAYER_START_HP = PLAYER_BASE_HP;
export const ATTACK_BUFFER = ATTACK_BUFFER_MS;
