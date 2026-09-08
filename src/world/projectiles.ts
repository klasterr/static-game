import { TAU, clamp01, shortestAngle } from '../core/math';
import { PKind } from '../render/fx';
import { Tint } from '../render/lighting';
import { inRadius, moveCircle } from './collision';
import { applyBurn, applyDamage, applySlow, spawnPool } from './combat';
import type { GameCtx } from './ctx';
import { EKind, Flags, TEAM_HOSTILE, TEAM_PLAYER, type Entity, isTargetable } from './entities';

/**
 * Projectiles and lingering hazard volumes.
 *
 * Projectiles carry `team` and their damage in `payload` rather than a pointer
 * back to whoever fired them. That is deliberate: entities are pooled, so an
 * owner reference would dangle the moment the shooter died.
 */

export interface ProjectileSpec {
  speed: number;
  radius: number;
  damage: number;
  /** Lifetime in ms; also caps range. */
  life: number;
  color: string;
  /** Extra entities it passes through. 0 = stops on first hit. */
  pierce?: number;
  /** Degrees per second of homing. 0 = straight. */
  homing?: number;
  light?: number;
  tint?: number;
  knockback?: number;
  burnDps?: number;
  slowMul?: number;
  /** Leaves a pool where it lands. */
  pool?: { radius: number; dps: number; ms: number };
  /** Destroyable by player attacks (homing orbs are a nice target). */
  fragile?: boolean;
}

const ProjState = {
  Straight: 0,
  Lob: 1,
} as const;

export function spawnProjectile(
  ctx: GameCtx,
  x: number,
  y: number,
  dirX: number,
  dirY: number,
  spec: ProjectileSpec,
  fromPlayer: boolean,
): Entity {
  const e = ctx.world.spawn(EKind.Projectile, x, y, fromPlayer ? TEAM_PLAYER : TEAM_HOSTILE);
  const l = Math.sqrt(dirX * dirX + dirY * dirY) || 1;
  e.r = spec.radius;
  e.vx = (dirX / l) * spec.speed;
  e.vy = (dirY / l) * spec.speed;
  e.faceX = dirX / l;
  e.faceY = dirY / l;
  e.life = spec.life;
  e.hasLife = true;
  e.payload = spec.damage;
  e.tag = spec.color;
  e.bx = spec.pierce ?? 0;
  e.by = spec.homing ?? 0;
  e.light = spec.light ?? 0;
  e.lightTint = spec.tint ?? Tint.Warm;
  e.dmg = spec.knockback ?? 0;
  e.burnDps = spec.burnDps ?? 0;
  e.slowMul = spec.slowMul ?? 1;
  e.state = ProjState.Straight;
  if (spec.pool) {
    e.cd1 = spec.pool.dps;
    e.cd2 = spec.pool.radius;
    e.stateT = spec.pool.ms;
  }
  if (spec.fragile) {
    e.flags |= Flags.Damageable;
    e.hp = 1;
    e.hpMax = 1;
  }
  return e;
}

/**
 * A lobbed shell that lands at a fixed point after a fixed time.
 *
 * The telegraph is the whole point: the target circle is drawn on the ground
 * from the moment of firing, so a Cap Slinger volley is information rather than
 * an ambush. What it takes away is the option to stand still.
 */
export function spawnLob(
  ctx: GameCtx,
  x: number,
  y: number,
  targetX: number,
  targetY: number,
  travelMs: number,
  spec: ProjectileSpec,
): Entity {
  const e = ctx.world.spawn(EKind.Projectile, x, y, TEAM_HOSTILE);
  e.r = spec.radius;
  e.ax = targetX;
  e.ay = targetY;
  e.bx = x;
  e.by = y;
  e.life = travelMs;
  e.stateT = travelMs;
  e.hasLife = true;
  e.payload = spec.damage;
  e.tag = spec.color;
  e.light = spec.light ?? 0;
  e.lightTint = spec.tint ?? Tint.Green;
  e.state = ProjState.Lob;
  if (spec.pool) {
    e.cd1 = spec.pool.dps;
    e.cd2 = spec.pool.radius;
    e.aiT = spec.pool.ms;
  }
  return e;
}

export function isLob(e: Entity): boolean {
  return e.state === ProjState.Lob;
}

/** Height above the ground for a lobbed shell, for drawing the arc. */
export function lobHeight(e: Entity): number {
  const t = 1 - clamp01(e.life / Math.max(1, e.stateT));
  return Math.sin(t * Math.PI) * 46;
}

export function updateProjectiles(ctx: GameCtx, dt: number): void {
  const world = ctx.world;
  const map = ctx.map;

  for (let i = 0; i < world.ents.length; i++) {
    const e = world.ents[i];
    if (!e.alive || e.kind !== EKind.Projectile) continue;

    e.px = e.x;
    e.py = e.y;

    if (e.state === ProjState.Lob) {
      updateLob(ctx, e, dt);
      continue;
    }

    // Homing: turn toward the target at a bounded rate. Bounded turning is what
    // makes an orb dodgeable — perfect tracking is just delayed damage.
    if (e.by > 0) {
      const tgt = e.team === TEAM_HOSTILE ? ctx.target : world.nearestHostile(e.x, e.y, 420);
      if (tgt) {
        const want = Math.atan2(tgt.y - e.y, tgt.x - e.x);
        const cur = Math.atan2(e.vy, e.vx);
        const maxTurn = (e.by * Math.PI) / 180 * dt;
        const d = shortestAngle(cur, want);
        const next = cur + Math.max(-maxTurn, Math.min(maxTurn, d));
        const speed = Math.sqrt(e.vx * e.vx + e.vy * e.vy);
        e.vx = Math.cos(next) * speed;
        e.vy = Math.sin(next) * speed;
        e.faceX = Math.cos(next);
        e.faceY = Math.sin(next);
      }
    }

    const beforeX = e.x;
    const beforeY = e.y;
    moveCircle(map, e, e.vx * dt, e.vy * dt, true);

    // A tile stopped it: substepping in moveCircle means no tunnelling, so a
    // failed move is a genuine wall hit.
    const movedX = Math.abs(e.x - beforeX);
    const movedY = Math.abs(e.y - beforeY);
    const wanted = Math.abs(e.vx * dt) + Math.abs(e.vy * dt);
    if (wanted > 0.01 && movedX + movedY < wanted * 0.5) {
      impact(ctx, e, e.x, e.y);
      continue;
    }

    // Trail. Cheap, and it is what makes a fast projectile readable.
    ctx.fx.particle(e.x, e.y, 0, 0, e.tag, e.r * 0.8, 130, PKind.Dot, true, 0.02);

    if (checkProjectileHits(ctx, e)) continue;

    e.life -= dt * 1000;
    if (e.life <= 0) impact(ctx, e, e.x, e.y);
  }
}

function updateLob(ctx: GameCtx, e: Entity, dt: number): void {
  e.life -= dt * 1000;
  const t = 1 - clamp01(e.life / Math.max(1, e.stateT));
  e.x = e.bx + (e.ax - e.bx) * t;
  e.y = e.by + (e.ay - e.by) * t;

  if (e.life > 0) return;

  // Landing: burst damage at the impact point plus a lingering pool.
  const radius = e.cd2 > 0 ? e.cd2 : 42;
  const world = ctx.world;
  for (let j = 0; j < world.ents.length; j++) {
    const t2 = world.ents[j];
    if (!t2.alive) continue;
    if (t2.kind !== EKind.Player) continue;
    if (!inRadius(e.ax, e.ay, radius * 0.8, t2)) continue;
    applyDamage(ctx, t2, e.payload, { srcX: e.ax, srcY: e.ay, knockback: 120 });
  }

  ctx.fx.burst(e.ax, e.ay, {
    color: e.tag,
    count: 20,
    speed: [90, 300],
    size: [2, 4.4],
    life: [240, 520],
    additive: true,
  });
  ctx.fx.transientLight(e.ax, e.ay, radius * 2, 260, e.lightTint);

  if (e.cd1 > 0) {
    spawnPool(ctx, e.ax, e.ay, radius, e.cd1, e.aiT, e.tag, true);
  }
  ctx.world.kill(e);
}

function checkProjectileHits(ctx: GameCtx, e: Entity): boolean {
  const world = ctx.world;
  const hostileShot = e.team === TEAM_HOSTILE;

  for (let j = 0; j < world.ents.length; j++) {
    const t = world.ents[j];
    if (!t.alive) continue;

    if (hostileShot) {
      if (t.kind !== EKind.Player && t.kind !== EKind.Decoy) continue;
    } else if (!isTargetable(t)) {
      continue;
    }
    if (!inRadius(e.x, e.y, e.r, t)) continue;
    if (e.hitSet.has(t.id)) continue;
    e.hitSet.add(t.id);

    if (t.kind === EKind.Decoy) {
      ctx.world.kill(e);
      return true;
    }

    applyDamage(ctx, t, e.payload, {
      srcX: e.px,
      srcY: e.py,
      knockback: e.dmg,
      fromPlayer: !hostileShot,
      hitstop: hostileShot ? 0 : 40,
    });
    if (e.burnDps > 0) applyBurn(t, e.burnDps, 3000);
    if (e.slowMul < 1) applySlow(t, e.slowMul, 2000);

    if (e.bx > 0) {
      e.bx--;
    } else {
      impact(ctx, e, e.x, e.y);
      return true;
    }
  }
  return false;
}

function impact(ctx: GameCtx, e: Entity, x: number, y: number): void {
  ctx.fx.burst(x, y, {
    color: e.tag,
    count: 8,
    speed: [50, 190],
    size: [1.4, 3],
    life: [140, 320],
    kind: PKind.Spark,
    additive: true,
  });
  if (e.cd1 > 0 && e.cd2 > 0) {
    spawnPool(ctx, x, y, e.cd2, e.cd1, e.stateT, e.tag, e.team === TEAM_HOSTILE);
  }
  ctx.world.kill(e);
}

// -------------------------------------------------------- hazard entities

/**
 * Lingering volumes: acid pools, spore clouds, fire patches.
 *
 * `payload` is 1 when it hurts the player. Tick damage is deliberately quiet
 * (no flash, no hitstop) — a strobing enemy standing in acid is unreadable.
 */
export function updateHazardEntities(ctx: GameCtx, dt: number): void {
  const world = ctx.world;

  for (let i = 0; i < world.ents.length; i++) {
    const e = world.ents[i];
    if (!e.alive || e.kind !== EKind.Hazard) continue;

    e.life -= dt * 1000;
    if (e.life <= 0) {
      ctx.world.kill(e);
      continue;
    }

    // Emit a slow wisp so the volume reads as active rather than as a decal.
    if (Math.random() < 0.35) {
      const a = Math.random() * TAU;
      const rr = Math.sqrt(Math.random()) * e.r;
      ctx.fx.particle(
        e.x + Math.cos(a) * rr,
        e.y + Math.sin(a) * rr,
        0,
        -14 - Math.random() * 18,
        e.tag,
        1.6 + Math.random() * 1.8,
        500 + Math.random() * 400,
        PKind.Dot,
        true,
        0.4,
      );
    }

    e.cd0 -= dt * 1000;
    if (e.cd0 > 0) continue;
    e.cd0 = 250;

    for (let j = 0; j < world.ents.length; j++) {
      const t = world.ents[j];
      if (!t.alive) continue;
      const isPlayer = t.kind === EKind.Player;
      if (isPlayer) {
        if (e.payload !== 1) continue;
      } else if (!isTargetable(t)) {
        continue;
      } else if (e.payload === 1) {
        // Player-hostile pools also burn enemies; that is what makes shove
        // builds work and it is intentional.
        if (t.def?.tags.includes('fungal') && e.tag === '#a8f06e') continue;
      }
      if (!inRadius(e.x, e.y, e.r, t)) continue;
      applyDamage(ctx, t, e.dmg * 0.25, {
        srcX: e.x,
        srcY: e.y,
        isDot: true,
        quiet: true,
        showNumber: false,
        fromPlayer: e.payload !== 1,
      });
    }
  }
}

/**
 * Status effect ticks: burn and slow decay. Kept here so every timed effect
 * advances in one place.
 */
export function updateStatuses(ctx: GameCtx, dt: number): void {
  const world = ctx.world;
  const dtMs = dt * 1000;

  for (let i = 0; i < world.ents.length; i++) {
    const e = world.ents[i];
    if (!e.alive) continue;

    if (e.burnT > 0) {
      e.burnT -= dtMs;
      e.burnTick -= dtMs;
      if (e.burnTick <= 0 && e.kind === EKind.Enemy) {
        e.burnTick = 400;
        ctx.fx.particle(
          e.x + (Math.random() - 0.5) * e.r,
          e.y + (Math.random() - 0.5) * e.r,
          0,
          -30,
          '#ff7a1a',
          2,
          380,
          PKind.Dot,
          true,
          0.3,
        );
        // Burn is a DoT, so it bypasses directional shields and armour plates.
        // Discovering that is one of the better "aha" moments in the item pool.
        applyDamage(ctx, e, e.burnDps * 0.4, {
          srcX: e.x,
          srcY: e.y,
          isDot: true,
          quiet: true,
          showNumber: false,
          fromPlayer: true,
          numberColor: '#ff7a1a',
        });
      }
      if (e.burnT <= 0) {
        e.burnDps = 0;
        e.burnT = 0;
      }
    }

    if (e.slowT > 0) {
      e.slowT -= dtMs;
      if (e.slowT <= 0) {
        e.slowT = 0;
        e.slowMul = 1;
      }
    }
  }
}
