import { TILE } from '../../core/constants';
import { TAU, normalize, scratchA } from '../../core/math';
import { PKind } from '../../render/fx';
import { Tint } from '../../render/lighting';
import { coneHit, inRing, nearestFree } from '../../world/collision';
import { applyDamage, applyKnockback } from '../../world/combat';
import type { GameCtx } from '../../world/ctx';
import { Flags, type Entity } from '../../world/entities';
import { spawnLob, spawnProjectile, type ProjectileSpec } from '../../world/projectiles';
import type { DamageEvent } from '../types/enemy';

/**
 * Composable AI primitives.
 *
 * Seven distinct enemies is only affordable because each one's `ai` is five to
 * twenty lines of these. Anything that more than one enemy would want to do
 * belongs in here, tested once, rather than open-coded per species.
 *
 * Scratch field conventions on `Entity` (documented here because they are
 * shared by every behaviour below):
 *   state / stateT  attack or phase state machine
 *   aiT             primary cooldown
 *   cd1             secondary cooldown
 *   ax / ay         a remembered point (anchor, aim, shield angle)
 *   bx / by         spare scalars
 * `cd0` is reserved for the contact-damage cooldown and `cd2` for the Warded
 * affix window — do not reuse those.
 */

export const Phase = {
  Idle: 0,
  Windup: 1,
  Active: 2,
  Recover: 3,
} as const;
export type PhaseId = (typeof Phase)[keyof typeof Phase];

// ------------------------------------------------------------------- basics

export function distToTarget(e: Entity, ctx: GameCtx): number {
  const dx = ctx.target.x - e.x;
  const dy = ctx.target.y - e.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function faceTarget(e: Entity, ctx: GameCtx): void {
  const dx = ctx.target.x - e.x;
  const dy = ctx.target.y - e.y;
  const l = Math.sqrt(dx * dx + dy * dy);
  if (l < 1e-4) return;
  e.faceX = dx / l;
  e.faceY = dy / l;
}

export function hasLineOfSight(e: Entity, ctx: GameCtx): boolean {
  return ctx.map.rayClear(e.x, e.y, ctx.target.x, ctx.target.y);
}

/** Steer the locomotion velocity toward a desired vector with a lag. */
export function steer(e: Entity, dt: number, wantVx: number, wantVy: number, lag: number): void {
  const k = lag <= 0 ? 1 : 1 - Math.exp(-dt / lag);
  e.vx += (wantVx - e.vx) * k;
  e.vy += (wantVy - e.vy) * k;
}

/** Effective speed after slows and stuns. */
export function effSpeed(e: Entity, base: number): number {
  if (e.stun > 0) return 0;
  return base * e.slowMul;
}

/**
 * Aim point that accounts for target velocity. Gated on
 * `ctx.esc.leadShots` (floor 11+) — leading is a real difficulty increase and
 * it should arrive as a noticeable change rather than being there from the
 * start.
 */
export function leadPoint(
  e: Entity,
  ctx: GameCtx,
  projectileSpeed: number,
  out: { x: number; y: number },
): void {
  const t = ctx.target;
  out.x = t.x;
  out.y = t.y;
  if (!ctx.esc.leadShots || projectileSpeed <= 0) return;
  const dx = t.x - e.x;
  const dy = t.y - e.y;
  const travel = Math.sqrt(dx * dx + dy * dy) / projectileSpeed;
  out.x += t.vx * travel * 0.8;
  out.y += t.vy * travel * 0.8;
}

// --------------------------------------------------------------- locomotion

const _dir = { x: 0, y: 0 };

/**
 * Pursue the target.
 *
 * Close in, steer straight at them so the final approach looks intentional.
 * Further out, follow the flow field so corners and corridors are navigated
 * without any per-enemy pathfinding.
 */
export function chase(
  e: Entity,
  ctx: GameCtx,
  dt: number,
  speed: number,
  lag = 0.15,
): void {
  const dist = distToTarget(e, ctx);
  let dx: number;
  let dy: number;

  const closeEnough = dist < TILE * 3.5 && hasLineOfSight(e, ctx);
  if (closeEnough || !ctx.flow.dirAt(ctx.map, e.x, e.y, _dir)) {
    normalize(ctx.target.x - e.x, ctx.target.y - e.y, scratchA);
    dx = scratchA.x;
    dy = scratchA.y;
  } else {
    dx = _dir.x;
    dy = _dir.y;
  }

  // Flanking (floor 36+): a share of chasers aim for the rear arc instead of
  // walking into your face. `seed` decides which ones, consistently.
  if (ctx.esc.flanking && dist > TILE * 2.5 && (e.seed & 7) < 3) {
    const t = ctx.target;
    const bx = -(t.player?.aimX ?? t.faceX);
    const by = -(t.player?.aimY ?? t.faceY);
    const gx = t.x + bx * TILE * 2.2;
    const gy = t.y + by * TILE * 2.2;
    normalize(gx - e.x, gy - e.y, scratchA);
    dx = dx * 0.35 + scratchA.x * 0.65;
    dy = dy * 0.35 + scratchA.y * 0.65;
  }

  const s = effSpeed(e, speed);
  steer(e, dt, dx * s, dy * s, lag);
  if (s > 0) faceVelocity(e);
}

export function faceVelocity(e: Entity): void {
  const l = Math.sqrt(e.vx * e.vx + e.vy * e.vy);
  if (l < 6) return;
  e.faceX = e.vx / l;
  e.faceY = e.vy / l;
}

/**
 * Hold a distance band. Retreat when crowded, advance when too far, drift
 * sideways when comfortable so the enemy never looks parked.
 */
export function kite(
  e: Entity,
  ctx: GameCtx,
  dt: number,
  speed: number,
  band: [number, number],
): void {
  const dist = distToTarget(e, ctx);
  normalize(ctx.target.x - e.x, ctx.target.y - e.y, scratchA);
  const tx = scratchA.x;
  const ty = scratchA.y;
  const s = effSpeed(e, speed);

  if (dist < band[0]) {
    // Back away, but along the flow field in reverse so it does not reverse
    // into a wall and get stuck there.
    steer(e, dt, -tx * s, -ty * s, 0.18);
  } else if (dist > band[1]) {
    chase(e, ctx, dt, speed, 0.22);
    return;
  } else {
    const side = (e.seed & 1) === 0 ? 1 : -1;
    steer(e, dt, -ty * s * 0.45 * side, tx * s * 0.45 * side, 0.25);
  }
  faceTarget(e, ctx);
}

/** Orbit the target at a radius. Wide banking arcs, not tight circles. */
export function strafeArc(
  e: Entity,
  ctx: GameCtx,
  dt: number,
  speed: number,
  radius: number,
  dir: 1 | -1,
): void {
  const t = ctx.target;
  const dx = e.x - t.x;
  const dy = e.y - t.y;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = dx / dist;
  const ny = dy / dist;
  // Tangent plus a radial correction toward the desired orbit radius.
  const tangX = -ny * dir;
  const tangY = nx * dir;
  const pull = (dist - radius) / radius;
  const wx = tangX - nx * pull * 1.2;
  const wy = tangY - ny * pull * 1.2;
  normalize(wx, wy, scratchA);
  const s = effSpeed(e, speed);
  steer(e, dt, scratchA.x * s, scratchA.y * s, 0.2);
  faceTarget(e, ctx);
}

/** Run away. Used by the summoner, which never fights. */
export function fleeFrom(
  e: Entity,
  ctx: GameCtx,
  dt: number,
  speed: number,
  range: number,
): boolean {
  const dist = distToTarget(e, ctx);
  if (dist > range) return false;
  normalize(e.x - ctx.target.x, e.y - ctx.target.y, scratchA);
  const s = effSpeed(e, speed);
  steer(e, dt, scratchA.x * s, scratchA.y * s, 0.2);
  faceVelocity(e);
  return true;
}

/** Drift on a sine so a floating enemy never looks pinned to the grid. */
export function bob(e: Entity, ctx: GameCtx, amplitude: number): number {
  return Math.sin((ctx.timeMs + e.seed * 13) * 0.003) * amplitude;
}

// ---------------------------------------------------------------- attacking

export interface ChargeCfg {
  windup: number;
  speed: number;
  duration: number;
  recover: number;
  cooldown: number;
  triggerRange: number;
  /** Damage dealt by running into the player mid-charge. */
  damage: number;
  /** Self-damage on slamming into a wall. */
  wallDamage?: number;
  color: string;
}

/**
 * Approach, telegraph, commit to a straight line, overshoot, recover.
 *
 * The charge CANNOT turn once committed, and the recovery is a free damage
 * window. That combination is what makes it a timing check — sidestep at the
 * right moment and you get a punish — rather than an unavoidable hit.
 */
export function telegraphedCharge(
  e: Entity,
  ctx: GameCtx,
  dt: number,
  cfg: ChargeCfg,
): PhaseId {
  e.stateT -= dt * 1000;

  switch (e.state) {
    case Phase.Windup: {
      e.vx *= 0.86;
      e.vy *= 0.86;
      faceTarget(e, ctx);
      if (e.stateT <= 0) {
        e.state = Phase.Active;
        e.stateT = cfg.duration;
        // Latch the direction NOW. Everything after this is committed.
        e.ax = e.faceX;
        e.ay = e.faceY;
        e.vx = e.ax * cfg.speed;
        e.vy = e.ay * cfg.speed;
        e.hitSet.clear();
      }
      return Phase.Windup;
    }

    case Phase.Active: {
      e.vx = e.ax * cfg.speed;
      e.vy = e.ay * cfg.speed;
      ctx.fx.particle(
        e.x - e.ax * e.r,
        e.y - e.ay * e.r,
        -e.ax * 40,
        -e.ay * 40,
        cfg.color,
        2.6,
        260,
        PKind.Streak,
        true,
        0.2,
      );

      const t = ctx.target;
      if (!e.hitSet.has(t.id)) {
        const dx = t.x - e.x;
        const dy = t.y - e.y;
        const rr = e.r + t.r;
        if (dx * dx + dy * dy < rr * rr) {
          e.hitSet.add(t.id);
          applyDamage(ctx, t, cfg.damage, { srcX: e.x, srcY: e.y });
        }
      }

      // Wall slam: stop early, take self-damage, and extend the punish window.
      const blocked = Math.abs(e.vx) + Math.abs(e.vy) > 1 &&
        ctx.map.isBlocked(
          Math.floor((e.x + e.ax * e.r * 1.2) / TILE),
          Math.floor((e.y + e.ay * e.r * 1.2) / TILE),
        );
      if (blocked) {
        e.state = Phase.Recover;
        e.stateT = cfg.recover * 1.5;
        e.vx = 0;
        e.vy = 0;
        e.stun = Math.max(e.stun, cfg.recover);
        if (cfg.wallDamage) {
          applyDamage(ctx, e, cfg.wallDamage, { srcX: e.x, srcY: e.y, quiet: false });
        }
        ctx.fx.burst(e.x + e.ax * e.r, e.y + e.ay * e.r, {
          color: cfg.color,
          count: 12,
          speed: [80, 260],
          size: [2, 4],
          life: [180, 380],
          kind: PKind.Spark,
          additive: true,
        });
        return Phase.Recover;
      }

      if (e.stateT <= 0) {
        e.state = Phase.Recover;
        e.stateT = cfg.recover;
      }
      return Phase.Active;
    }

    case Phase.Recover: {
      e.vx *= 0.82;
      e.vy *= 0.82;
      if (e.stateT <= 0) {
        e.state = Phase.Idle;
        e.aiT = cfg.cooldown;
      }
      return Phase.Recover;
    }

    default: {
      e.aiT -= dt * 1000;
      if (e.aiT <= 0 && distToTarget(e, ctx) < cfg.triggerRange && hasLineOfSight(e, ctx)) {
        e.state = Phase.Windup;
        e.stateT = cfg.windup;
      }
      return Phase.Idle;
    }
  }
}

export interface SwingCfg {
  windup: number;
  active: number;
  recover: number;
  cooldown: number;
  arcDeg: number;
  reach: number;
  damage: number;
  knockback?: number;
  color: string;
}

/**
 * A telegraphed melee arc. Cone test with a per-swing hit set, exactly like the
 * player's — sharing the rule means enemy attacks are as readable and as
 * dodgeable as your own.
 */
export function meleeSwing(e: Entity, ctx: GameCtx, dt: number, cfg: SwingCfg): PhaseId {
  e.stateT -= dt * 1000;

  switch (e.state) {
    case Phase.Windup:
      faceTarget(e, ctx);
      if (e.stateT <= 0) {
        e.state = Phase.Active;
        e.stateT = cfg.active;
        e.hitSet.clear();
      }
      return Phase.Windup;

    case Phase.Active: {
      const cosHalf = Math.cos(((cfg.arcDeg * 0.5) * Math.PI) / 180);
      const t = ctx.target;
      if (!e.hitSet.has(t.id) &&
          coneHit(e.x, e.y, e.faceX, e.faceY, cosHalf, cfg.reach, t)) {
        e.hitSet.add(t.id);
        applyDamage(ctx, t, cfg.damage, {
          srcX: e.x,
          srcY: e.y,
          knockback: cfg.knockback ?? 180,
        });
      }
      if (e.stateT <= 0) {
        e.state = Phase.Recover;
        e.stateT = cfg.recover;
      }
      return Phase.Active;
    }

    case Phase.Recover:
      if (e.stateT <= 0) {
        e.state = Phase.Idle;
        e.aiT = cfg.cooldown;
      }
      return Phase.Recover;

    default:
      e.aiT -= dt * 1000;
      if (e.aiT <= 0 && distToTarget(e, ctx) < cfg.reach * 1.15 && hasLineOfSight(e, ctx)) {
        e.state = Phase.Windup;
        e.stateT = cfg.windup;
      }
      return Phase.Idle;
  }
}

export interface ShootCfg {
  cooldown: number;
  /** Aim time before release. The visible draw is the fairness guarantee. */
  windup: number;
  spec: ProjectileSpec;
  /** Fan of N shots across this arc, in degrees. */
  fan?: { count: number; spreadDeg: number };
  /** Fire even while retreating (escalation from floor 26). */
  requireStill?: boolean;
}

const _aim = { x: 0, y: 0 };

export function shootAt(e: Entity, ctx: GameCtx, dt: number, cfg: ShootCfg): PhaseId {
  e.stateT -= dt * 1000;

  if (e.state === Phase.Windup) {
    faceTarget(e, ctx);
    if (cfg.requireStill && !ctx.esc.fireWhileRetreating) {
      e.vx *= 0.8;
      e.vy *= 0.8;
    }
    if (e.stateT > 0) return Phase.Windup;

    leadPoint(e, ctx, cfg.spec.speed, _aim);
    normalize(_aim.x - e.x, _aim.y - e.y, scratchA);
    const baseAngle = Math.atan2(scratchA.y, scratchA.x);
    const muzzle = e.r + cfg.spec.radius + 2;

    if (cfg.fan) {
      const spread = (cfg.fan.spreadDeg * Math.PI) / 180;
      for (let i = 0; i < cfg.fan.count; i++) {
        const t = cfg.fan.count === 1 ? 0.5 : i / (cfg.fan.count - 1);
        const a = baseAngle + (t - 0.5) * spread;
        spawnProjectile(
          ctx,
          e.x + Math.cos(a) * muzzle,
          e.y + Math.sin(a) * muzzle,
          Math.cos(a),
          Math.sin(a),
          cfg.spec,
          false,
        );
      }
    } else {
      spawnProjectile(
        ctx,
        e.x + scratchA.x * muzzle,
        e.y + scratchA.y * muzzle,
        scratchA.x,
        scratchA.y,
        cfg.spec,
        false,
      );
    }

    ctx.fx.transientLight(e.x, e.y, 70, 140, cfg.spec.tint ?? Tint.Warm);
    e.state = Phase.Idle;
    e.aiT = cfg.cooldown;
    return Phase.Active;
  }

  e.aiT -= dt * 1000;
  if (e.aiT <= 0 && hasLineOfSight(e, ctx)) {
    e.state = Phase.Windup;
    e.stateT = cfg.windup;
  }
  return Phase.Idle;
}

export interface LobCfg {
  cooldown: number;
  windup: number;
  travel: number;
  spec: ProjectileSpec;
  range: number;
}

export function lobAtTarget(e: Entity, ctx: GameCtx, dt: number, cfg: LobCfg): PhaseId {
  e.stateT -= dt * 1000;

  if (e.state === Phase.Windup) {
    faceTarget(e, ctx);
    if (e.stateT > 0) return Phase.Windup;
    // Predict where they will be when it lands, always — a shell aimed at where
    // you already are would be free to ignore.
    const t = ctx.target;
    const tx = t.x + t.vx * (cfg.travel / 1000) * 0.85;
    const ty = t.y + t.vy * (cfg.travel / 1000) * 0.85;
    spawnLob(ctx, e.x, e.y - 8, tx, ty, cfg.travel, cfg.spec);
    e.state = Phase.Idle;
    e.aiT = cfg.cooldown;
    return Phase.Active;
  }

  e.aiT -= dt * 1000;
  if (e.aiT <= 0 && distToTarget(e, ctx) < cfg.range) {
    e.state = Phase.Windup;
    e.stateT = cfg.windup;
  }
  return Phase.Idle;
}

/** Teleport to a legal tile at a distance band from the target. */
export function blinkNear(e: Entity, ctx: GameCtx, minR: number, maxR: number): boolean {
  const t = ctx.target;
  for (let attempt = 0; attempt < 24; attempt++) {
    const a = Math.random() * TAU;
    const r = minR + Math.random() * (maxR - minR);
    const x = t.x + Math.cos(a) * r;
    const y = t.y + Math.sin(a) * r;
    if (ctx.map.isBlocked(Math.floor(x / TILE), Math.floor(y / TILE))) continue;

    ctx.fx.burst(e.x, e.y, {
      color: '#cfe6ff',
      count: 12,
      speed: [40, 150],
      size: [1.5, 3],
      life: [200, 420],
      additive: true,
    });
    const spot = nearestFree(ctx.map, x, y, e.r);
    e.x = spot.x;
    e.y = spot.y;
    // Reset interpolation, or the wisp visibly streaks across the room.
    e.px = e.x;
    e.py = e.y;
    e.vx = 0;
    e.vy = 0;
    ctx.fx.burst(e.x, e.y, {
      color: '#cfe6ff',
      count: 14,
      speed: [40, 170],
      size: [1.5, 3.2],
      life: [220, 460],
      additive: true,
    });
    ctx.fx.transientLight(e.x, e.y, 120, 240, Tint.Cold);
    return true;
  }
  return false;
}

export interface RingCfg {
  windup: number;
  cooldown: number;
  maxRadius: number;
  expandMs: number;
  damage: number;
  knockback: number;
  color: string;
}

/**
 * Expanding shockwave. Dodging outward works, dodging sideways does not — which
 * is a different reflex from everything else in the roster.
 */
export function expandingRing(e: Entity, ctx: GameCtx, dt: number, cfg: RingCfg): PhaseId {
  e.stateT -= dt * 1000;

  if (e.state === Phase.Windup) {
    e.vx *= 0.8;
    e.vy *= 0.8;
    if (e.stateT <= 0) {
      e.state = Phase.Active;
      e.stateT = cfg.expandMs;
      e.bx = 0;
      e.hitSet.clear();
    }
    return Phase.Windup;
  }

  if (e.state === Phase.Active) {
    const prev = e.bx;
    const t = 1 - Math.max(0, e.stateT) / cfg.expandMs;
    e.bx = t * cfg.maxRadius;

    const target = ctx.target;
    if (!e.hitSet.has(target.id) && inRing(e.x, e.y, prev, e.bx, target)) {
      e.hitSet.add(target.id);
      applyDamage(ctx, target, cfg.damage, {
        srcX: e.x,
        srcY: e.y,
        knockback: cfg.knockback,
      });
    }

    if (e.stateT <= 0) {
      e.state = Phase.Idle;
      e.aiT = cfg.cooldown;
      e.bx = 0;
    }
    return Phase.Active;
  }

  e.aiT -= dt * 1000;
  if (e.aiT <= 0 && distToTarget(e, ctx) < cfg.maxRadius * 1.3) {
    e.state = Phase.Windup;
    e.stateT = cfg.windup;
  }
  return Phase.Idle;
}

export interface OrbitCfg {
  count: number;
  radius: number;
  revPerSec: number;
  damage: number;
  color: string;
}

/**
 * Bolts orbiting the enemy. Melee entry becomes a timing problem: you have to
 * come in through the gap. Directly counters mindless swing-spam.
 */
export function orbitBolts(e: Entity, ctx: GameCtx, dt: number, cfg: OrbitCfg): void {
  e.ax += cfg.revPerSec * TAU * dt;
  if (e.ax > TAU) e.ax -= TAU;

  const t = ctx.target;
  const canHit = e.cd1 <= 0;
  e.cd1 -= dt * 1000;

  for (let i = 0; i < cfg.count; i++) {
    const a = e.ax + (i / cfg.count) * TAU;
    const bxp = e.x + Math.cos(a) * cfg.radius;
    const byp = e.y + Math.sin(a) * cfg.radius;
    ctx.fx.particle(bxp, byp, 0, 0, cfg.color, 4.5, 90, PKind.Dot, true, 0.02);

    if (!canHit) continue;
    const dx = t.x - bxp;
    const dy = t.y - byp;
    const rr = 7 + t.r;
    if (dx * dx + dy * dy < rr * rr) {
      applyDamage(ctx, t, cfg.damage, { srcX: bxp, srcY: byp, knockback: 200 });
      e.cd1 = 700;
    }
  }
}

export interface SummonCfg {
  every: number;
  /** Called to actually spawn; keeps this file free of the enemy registry. */
  spawn(ctx: GameCtx, x: number, y: number): Entity | null;
  max: number;
  /** Tag used to count existing minions. */
  minionId: string;
  color: string;
}

export function summonOn(e: Entity, ctx: GameCtx, dt: number, cfg: SummonCfg): void {
  e.aiT -= dt * 1000;
  // Charge-up visual: the intake inflates across the whole cycle, so the pop is
  // predictable and the player can choose to interrupt.
  const charge = 1 - Math.max(0, e.aiT) / cfg.every;
  e.bx = charge;

  if (e.aiT > 0) return;
  e.aiT = cfg.every;

  let live = 0;
  const world = ctx.world;
  for (let i = 0; i < world.ents.length; i++) {
    const o = world.ents[i];
    if (o.alive && o.def?.id === cfg.minionId) live++;
  }
  if (live >= cfg.max) return;

  const a = Math.random() * TAU;
  const spot = nearestFree(ctx.map, e.x + Math.cos(a) * 28, e.y + Math.sin(a) * 28, 6);
  const minion = cfg.spawn(ctx, spot.x, spot.y);
  if (!minion) return;

  ctx.fx.burst(spot.x, spot.y, {
    color: cfg.color,
    count: 14,
    speed: [60, 200],
    size: [1.6, 3.2],
    life: [200, 420],
    additive: true,
  });
  ctx.fx.transientLight(spot.x, spot.y, 110, 220, Tint.Warm);
}

// ------------------------------------------------------------ damage filters

/**
 * Frontal shield: damage arriving inside `arcDeg` of the shield facing is cut
 * by `reduction`.
 *
 * `e.ax` holds the shield angle, and the enemy is expected to rotate it toward
 * the player with a LAG. That lag is the entire fight: a fast strafe beats the
 * shield, which turns "armoured enemy" from a stat check into a skill check.
 */
export function directionalShield(
  e: Entity,
  dmg: DamageEvent,
  arcDeg: number,
  reduction: number,
): number {
  if (dmg.isDot || dmg.pierceShield) return dmg.amount;
  const dx = dmg.srcX - e.x;
  const dy = dmg.srcY - e.y;
  const l = Math.sqrt(dx * dx + dy * dy);
  if (l < 1e-4) return dmg.amount;
  const cosHalf = Math.cos(((arcDeg * 0.5) * Math.PI) / 180);
  const dot = (dx / l) * Math.cos(e.ax) + (dy / l) * Math.sin(e.ax);
  return dot >= cosHalf ? dmg.amount * (1 - reduction) : dmg.amount;
}

/** Shove everything nearby away. Used on boss phase changes. */
export function shoveAll(ctx: GameCtx, x: number, y: number, radius: number, force: number): void {
  const world = ctx.world;
  for (let i = 0; i < world.ents.length; i++) {
    const e = world.ents[i];
    if (!e.alive || (e.flags & Flags.KnockbackImmune) !== 0) continue;
    const dx = e.x - x;
    const dy = e.y - y;
    if (dx * dx + dy * dy > radius * radius) continue;
    applyKnockback(e, x, y, force);
  }
}
