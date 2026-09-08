import {
  CONTACT_DAMAGE_CD,
  ENEMY_STUN_LIGHT,
  HITSTOP_PLAYER_HIT,
  HIT_FLASH_MS,
  IFRAME_ON_HIT,
  PLAYER_HIT_TIMESCALE,
  PLAYER_HIT_TIMESCALE_MS,
  TRAUMA_EXPLOSION,
  TRAUMA_HIT_DEALT,
  TRAUMA_HIT_TAKEN,
} from '../core/constants';
import { addTrauma } from '../render/camera';
import { PKind } from '../render/fx';
import { Tint } from '../render/lighting';
import type { DamageEvent } from '../content/types/enemy';
import { EKind, Flags, TEAM_HOSTILE, type Entity, isTargetable } from './entities';
import { inRadius } from './collision';
import type { GameCtx } from './ctx';

/**
 * Everything that hurts anything goes through this file.
 *
 * Having one choke point is what makes combat feel tunable: hitstop, flash,
 * knockback, damage numbers, screen shake, leech and on-hit relic effects all
 * live together, so changing "how a hit feels" is a change in one place rather
 * than fifteen.
 */

export interface DamageOpts {
  srcX: number;
  srcY: number;
  knockback?: number;
  isDot?: boolean;
  isCrit?: boolean;
  pierceShield?: boolean;
  hitstop?: number;
  stun?: number;
  /** Player-sourced damage triggers leech, chains and on-hit relics. */
  fromPlayer?: boolean;
  numberColor?: string;
  showNumber?: boolean;
  /** Suppresses the hit flash for tick damage, which would otherwise strobe. */
  quiet?: boolean;
}

const _event: DamageEvent = {
  amount: 0,
  srcX: 0,
  srcY: 0,
  isDot: false,
  isCrit: false,
  pierceShield: false,
};

/** Returns damage actually dealt (after shields and armour). */
export function applyDamage(
  ctx: GameCtx,
  target: Entity,
  amount: number,
  opts: DamageOpts,
): number {
  if (!target.alive || amount <= 0) return 0;
  if ((target.flags & Flags.Damageable) === 0) return 0;
  if ((target.flags & Flags.Invulnerable) !== 0) return 0;
  if (target.iframes > 0) return 0;

  if (target.kind === EKind.Player) {
    return damagePlayer(ctx, target, amount, opts);
  }

  // Directional shields and armour plates get first refusal.
  let incoming = amount;
  const def = target.def;
  if (def?.modifyIncoming) {
    _event.amount = amount;
    _event.srcX = opts.srcX;
    _event.srcY = opts.srcY;
    _event.isDot = opts.isDot === true;
    _event.isCrit = opts.isCrit === true;
    _event.pierceShield = opts.pierceShield === true;
    incoming = def.modifyIncoming(target, _event);
  }

  // Elite affixes that alter incoming damage.
  incoming = applyDefensiveAffix(target, incoming);

  if (incoming <= 0) {
    // Fully absorbed: give explicit feedback so the player learns the rule
    // rather than concluding their weapon is broken.
    ctx.fx.burst(opts.srcX, opts.srcY, {
      color: '#dfe7ef',
      count: 4,
      speed: [40, 110],
      size: [1.2, 2.4],
      life: [120, 240],
      kind: PKind.Spark,
      additive: true,
    });
    return 0;
  }

  let dealt = 0;

  // Ablative shell absorbs everything until it breaks. Breaking it staggers.
  if (target.shell > 0) {
    const absorbed = Math.min(target.shell, incoming);
    target.shell -= absorbed;
    incoming -= absorbed;
    dealt += absorbed;
    if (target.shell <= 0) {
      target.stun = Math.max(target.stun, 800);
      ctx.fx.burst(target.x, target.y, {
        color: '#a8e6ff',
        count: 16,
        speed: [80, 260],
        size: [2, 4.5],
        life: [280, 560],
        kind: PKind.Chunk,
        gravity: 240,
      });
      addTrauma(ctx.camera, 0.2);
    }
  }

  if (incoming > 0) {
    target.hp -= incoming;
    dealt += incoming;
  }

  if (!opts.quiet) {
    target.flash = HIT_FLASH_MS;
    target.stun = Math.max(target.stun, opts.stun ?? ENEMY_STUN_LIGHT);
  }

  if (opts.showNumber !== false) {
    ctx.fx.damageNumber(
      target.x,
      target.y - target.r - 4,
      dealt,
      opts.isCrit === true,
      opts.numberColor ?? (opts.isCrit ? '#ffd24a' : '#ffe9c2'),
    );
  }

  if (opts.knockback && (target.flags & Flags.KnockbackImmune) === 0) {
    applyKnockback(target, opts.srcX, opts.srcY, opts.knockback);
  }

  if (!opts.isDot) {
    ctx.fx.burst(
      target.x + (opts.srcX - target.x) * 0.35,
      target.y + (opts.srcY - target.y) * 0.35,
      {
        color: '#c2323c',
        count: 7,
        speed: [70, 250],
        size: [1.6, 3.4],
        life: [200, 420],
        gravity: 260,
        dirX: target.x - opts.srcX,
        dirY: target.y - opts.srcY,
        spread: 1.9,
      },
    );
  }

  if (opts.fromPlayer) {
    onPlayerHit(ctx, target, dealt, opts);
  }

  if (opts.hitstop) ctx.hitstopRequest = Math.max(ctx.hitstopRequest, opts.hitstop);
  if (!opts.isDot) addTrauma(ctx.camera, TRAUMA_HIT_DEALT);

  if (target.hp <= 0) killEnemy(ctx, target, opts);

  return dealt;
}

/** Affixes that reduce incoming damage. */
function applyDefensiveAffix(target: Entity, incoming: number): number {
  if (target.affix !== 'warded') return incoming;
  // 40% reduction until three hits land inside a two-second window. The counter
  // resets, so it rewards committing to a burst instead of poking.
  if (target.cd2 <= 0) target.wardHits = 0;
  target.wardHits++;
  target.cd2 = 2000;
  return target.wardHits >= 3 ? incoming : incoming * 0.6;
}

/** Player-sourced on-hit effects: leech, burn, chill, chain. */
function onPlayerHit(ctx: GameCtx, target: Entity, dealt: number, opts: DamageOpts): void {
  const p = ctx.player.player;
  if (!p) return;
  const s = p.stats;

  if (s.leech > 0 && dealt > 0 && !opts.isDot) {
    healPlayer(ctx, Math.max(1, dealt * s.leech));
  }

  if (s.burnDps > 0 && !opts.isDot) {
    applyBurn(target, s.burnDps, 3000);
  }

  if (s.chillChance > 0 && !opts.isDot && ctx.rng.chance(s.chillChance)) {
    applySlow(target, 0.6, 2000);
  }

  // Static Coil counts HITS, not swings. That distinction is the whole reason
  // fast multi-hit weapons pair with it.
  if (s.chainEvery > 0 && !opts.isDot) {
    p.hitStreak++;
    if (p.hitStreak >= s.chainEvery) {
      p.hitStreak = 0;
      chainFrom(ctx, target, s.chainTargets, dealt * 0.6);
    }
  }
}

export function applyKnockback(
  e: Entity,
  fromX: number,
  fromY: number,
  strength: number,
): void {
  const dx = e.x - fromX;
  const dy = e.y - fromY;
  const l = Math.sqrt(dx * dx + dy * dy);
  const scale = strength * (1 - e.knockbackResist);
  if (scale <= 0) return;
  if (l < 1e-4) {
    e.kx += scale;
    return;
  }
  e.kx += (dx / l) * scale;
  e.ky += (dy / l) * scale;
}

export function applyBurn(e: Entity, dps: number, ms: number): void {
  // Refresh and stack: a stronger source overwrites, the duration always resets.
  e.burnDps = Math.max(e.burnDps, dps);
  e.burnT = Math.max(e.burnT, ms);
}

export function applySlow(e: Entity, mul: number, ms: number): void {
  e.slowMul = Math.min(e.slowMul, mul);
  e.slowT = Math.max(e.slowT, ms);
}

// ------------------------------------------------------------------- player

function damagePlayer(ctx: GameCtx, player: Entity, amount: number, opts: DamageOpts): number {
  const p = player.player;
  if (!p) return 0;
  if (p.invisT > 0) return 0;

  let incoming = amount * p.stats.damageTakenMul;
  if (p.stats.hazardImmune && opts.isDot) return 0;
  if (incoming <= 0) return 0;

  // The kill-shield soaks first, so Gravebound's aggression actually pays off.
  if (p.shieldHp > 0) {
    const soak = Math.min(p.shieldHp, incoming);
    p.shieldHp -= soak;
    incoming -= soak;
    ctx.fx.burst(player.x, player.y, {
      color: '#9fb6d6',
      count: 8,
      speed: [60, 180],
      size: [1.5, 3],
      life: [180, 340],
      kind: PKind.Spark,
      additive: true,
    });
  }

  if (incoming <= 0) {
    player.iframes = Math.max(player.iframes, 260);
    return 0;
  }

  player.hp -= incoming;

  // Second Wind: survive a fatal hit at 1 HP with a moment of invulnerability.
  if (player.hp <= 0 && p.secondWindLeft > 0) {
    p.secondWindLeft--;
    player.hp = 1;
    player.iframes = 2000;
    ctx.fx.flash('#ffffff', 0.65, 4);
    ctx.fx.transientLight(player.x, player.y, 260, 600, Tint.White);
    ctx.fx.burst(player.x, player.y, {
      color: '#ffffff',
      count: 34,
      speed: [120, 420],
      size: [2, 4],
      life: [340, 700],
      kind: PKind.Streak,
      additive: true,
    });
    addTrauma(ctx.camera, 0.5);
  } else {
    player.iframes = IFRAME_ON_HIT + p.stats.iframeBonus;
  }

  player.flash = HIT_FLASH_MS;
  applyKnockback(player, opts.srcX, opts.srcY, 300);
  // Taking a hit cancels whatever you were doing. Committing to a swing and
  // eating a charge should cost you the swing.
  p.atk = 0;
  p.atkT = 0;
  p.combo = 0;

  ctx.fx.flash('#7a1020', 0.3, 7);
  ctx.fx.damageNumber(player.x, player.y - 20, incoming, false, '#ff6b6b');
  addTrauma(ctx.camera, TRAUMA_HIT_TAKEN);
  ctx.hitstopRequest = Math.max(ctx.hitstopRequest, HITSTOP_PLAYER_HIT);
  ctx.slowmoScale = PLAYER_HIT_TIMESCALE;
  ctx.slowmoMs = PLAYER_HIT_TIMESCALE_MS;

  // Vengeance Plate: a shockwave every time you get hit, which inverts the
  // entire dodge-based skill model for players who lean into it.
  if (p.stats.vengeanceDmg > 0) {
    explode(ctx, player.x, player.y, p.stats.vengeanceRadius, p.stats.vengeanceDmg, {
      color: '#c9d4e2',
      hurtPlayer: false,
      fromPlayer: true,
    });
  }

  if (player.hp <= 0) {
    player.hp = 0;
    ctx.playerDied = true;
  }

  return incoming;
}

export function healPlayer(ctx: GameCtx, amount: number): number {
  const player = ctx.player;
  if (!player.alive || amount <= 0) return 0;
  const before = player.hp;
  player.hp = Math.min(player.hpMax, player.hp + amount);
  const gained = player.hp - before;
  if (gained > 0.5) {
    ctx.fx.damageNumber(player.x, player.y - 22, gained, false, '#7ef2a1');
    ctx.fx.burst(player.x, player.y, {
      color: '#7ef2a1',
      count: 6,
      speed: [20, 70],
      size: [1.5, 3],
      life: [340, 620],
      additive: true,
      gravity: -60,
    });
  }
  return gained;
}

// -------------------------------------------------------------------- death

/** Registered by the run layer so combat can grant rewards without a cycle. */
export interface RewardHooks {
  onEnemyKilled(ctx: GameCtx, e: Entity): void;
}

let rewards: RewardHooks | null = null;

export function setRewardHooks(h: RewardHooks): void {
  rewards = h;
}

export function killEnemy(ctx: GameCtx, e: Entity, opts?: DamageOpts): void {
  if (!e.alive) return;

  const def = e.def;
  ctx.fx.burst(e.x, e.y, {
    color: '#8e2b2b',
    count: 14,
    speed: [60, 300],
    size: [2, 4.4],
    life: [280, 640],
    gravity: 320,
  });
  ctx.fx.decal(e.x, e.y + e.r * 0.4, e.r * 0.9, '#3a1218', 0.4);

  if ((e.flags & Flags.Elite) !== 0) {
    ctx.fx.transientLight(e.x, e.y, 200, 420, Tint.Red);
    addTrauma(ctx.camera, 0.24);
  }

  // Volatile affix: a parting explosion. Kills near a crowd become a liability.
  if (e.affix === 'volatile') {
    explode(ctx, e.x, e.y, 130, e.dmg * 0.6, { color: '#ff4d16', hurtPlayer: true });
  }

  // Escalation: from floor 41 a share of enemies leave a damaging pool.
  if (ctx.esc.deathPools && ctx.rng.chance(0.25)) {
    spawnPool(ctx, e.x, e.y, 58, e.dmg * 0.5, 2000, '#7a2a3a');
  }

  rewards?.onEnemyKilled(ctx, e);
  def?.onDeath?.(e, ctx);

  ctx.world.kill(e);
  void opts;
}

// ------------------------------------------------------------- area effects

export interface ExplodeOpts {
  color: string;
  hurtPlayer: boolean;
  fromPlayer?: boolean;
  knockback?: number;
  tint?: number;
}

export function explode(
  ctx: GameCtx,
  x: number,
  y: number,
  radius: number,
  damage: number,
  opts: ExplodeOpts,
): void {
  ctx.fx.burst(x, y, {
    color: opts.color,
    count: 26,
    speed: [120, 420],
    size: [2, 5],
    life: [260, 560],
    kind: PKind.Streak,
    additive: true,
  });
  ctx.fx.particle(x, y, 0, 0, opts.color, radius * 0.35, 320, PKind.Ring, true, 1, 0);
  ctx.fx.transientLight(x, y, radius * 1.6, 300, opts.tint ?? Tint.Warm);
  addTrauma(ctx.camera, TRAUMA_EXPLOSION * 0.5);

  const world = ctx.world;
  for (let i = 0; i < world.ents.length; i++) {
    const t = world.ents[i];
    if (!t.alive) continue;
    if (t.kind === EKind.Player) {
      if (!opts.hurtPlayer) continue;
    } else if (!isTargetable(t)) {
      continue;
    } else if (opts.fromPlayer !== true && t.team === TEAM_HOSTILE) {
      // Enemy explosions do not friendly-fire unless explicitly allowed.
      continue;
    }
    if (!inRadius(x, y, radius, t)) continue;
    applyDamage(ctx, t, damage, {
      srcX: x,
      srcY: y,
      knockback: opts.knockback ?? 260,
      fromPlayer: opts.fromPlayer,
    });
  }
}

/** A lingering damaging area, as a Hazard entity. */
export function spawnPool(
  ctx: GameCtx,
  x: number,
  y: number,
  radius: number,
  dps: number,
  ms: number,
  color: string,
  hurtPlayer = true,
): Entity {
  const e = ctx.world.spawn(EKind.Hazard, x, y, hurtPlayer ? TEAM_HOSTILE : 0);
  e.r = radius;
  e.dmg = dps;
  e.life = ms;
  e.hasLife = true;
  e.tag = color;
  e.payload = hurtPlayer ? 1 : 0;
  e.light = radius * 0.7;
  ctx.fx.decal(x, y, radius * 0.8, color, 0.3);
  return e;
}

/** Chain to nearby enemies. Used by Static Coil. */
export function chainFrom(
  ctx: GameCtx,
  origin: Entity,
  targets: number,
  damage: number,
): void {
  let from = origin;
  const hit = new Set<number>([origin.id]);
  for (let n = 0; n < targets; n++) {
    const next = nearestExcluding(ctx, from.x, from.y, 190, hit);
    if (!next) break;
    hit.add(next.id);
    ctx.fx.particle(
      (from.x + next.x) * 0.5,
      (from.y + next.y) * 0.5,
      (next.x - from.x) * 1.6,
      (next.y - from.y) * 1.6,
      '#7ec8f2',
      2.4,
      160,
      PKind.Streak,
      true,
      0.02,
    );
    ctx.fx.transientLight(next.x, next.y, 90, 160, Tint.Cold);
    applyDamage(ctx, next, damage, {
      srcX: from.x,
      srcY: from.y,
      fromPlayer: true,
      numberColor: '#7ec8f2',
      knockback: 60,
    });
    from = next;
  }
}

function nearestExcluding(
  ctx: GameCtx,
  x: number,
  y: number,
  maxDist: number,
  exclude: Set<number>,
): Entity | null {
  let best: Entity | null = null;
  let bestD2 = maxDist * maxDist;
  const world = ctx.world;
  for (let i = 0; i < world.ents.length; i++) {
    const e = world.ents[i];
    if (!isTargetable(e) || exclude.has(e.id)) continue;
    const dx = e.x - x;
    const dy = e.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = e;
    }
  }
  return best;
}

// ------------------------------------------------------- contact damage pass

/**
 * Enemies that hurt by touching. The per-enemy cooldown is what stops a swarm
 * of twelve from dealing sixty hits a second.
 */
export function contactDamagePass(ctx: GameCtx): void {
  const world = ctx.world;
  const player = ctx.player;
  if (!player.alive || player.iframes > 0) return;

  for (let i = 0; i < world.ents.length; i++) {
    const e = world.ents[i];
    if (!e.alive || e.kind !== EKind.Enemy) continue;
    if ((e.flags & Flags.ContactDamage) === 0) continue;
    if (e.cd0 > 0) continue;
    if (!inRadius(e.x, e.y, e.r, player)) continue;

    applyDamage(ctx, player, e.dmg, { srcX: e.x, srcY: e.y });
    e.cd0 = CONTACT_DAMAGE_CD;
    break;
  }
}
