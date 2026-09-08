import { KNOCKBACK_DECAY, KNOCKBACK_EPSILON, TILE } from '../core/constants';
import { TAU } from '../core/math';
import { PKind } from '../render/fx';
import type { EnemyDef } from '../content/types/enemy';
import { moveCircle, separate } from './collision';
import { applyDamage } from './combat';
import type { GameCtx } from './ctx';
import { EKind, Flags, TEAM_HOSTILE, type Entity } from './entities';
import type { EnemySpawnOpts } from './world';

/**
 * Enemy update: AI dispatch, locomotion integration, and separation.
 *
 * The AI itself lives in `content/enemies/*` as `EnemyDef.ai`; this file owns
 * the parts that are the same for everything and must not be reimplemented per
 * species.
 */

// ------------------------------------------------------------------ affixes

export interface AffixDef {
  id: string;
  name: string;
  desc: string;
  color: string;
  /** Applied once, at spawn. */
  onSpawn?(e: Entity): void;
}

/**
 * The cheapest variety multiplier in the whole design: four affixes across four
 * elite-capable species is sixteen distinct encounters for about forty lines
 * each, and each one demands a slightly different response.
 */
export const AFFIXES: AffixDef[] = [
  {
    id: 'volatile',
    name: 'Volatile',
    desc: 'Explodes on death',
    color: '#ff4d16',
    // The explosion is triggered from killEnemy so it fires however it died.
  },
  {
    id: 'warded',
    name: 'Warded',
    desc: 'Resists damage until hit 3 times quickly',
    color: '#a8e6ff',
    // Reduction handled in combat.applyDefensiveAffix.
  },
  {
    id: 'frenzied',
    name: 'Frenzied',
    desc: 'Attacks much faster, but frailer',
    color: '#ff7a1a',
    onSpawn(e) {
      e.hpMax = Math.max(1, Math.round(e.hpMax * 0.75));
      e.hp = e.hpMax;
      // Encoded as a speed bump plus shorter cooldowns; the AI reads `bx`.
      e.bx = 1.55;
    },
  },
  {
    id: 'hasted',
    name: 'Hasted',
    desc: 'Moves faster and ignores slows',
    color: '#ffd24a',
    onSpawn(e) {
      e.speed *= 1.3;
      e.knockbackResist = Math.min(1, e.knockbackResist + 0.2);
    },
  },
];

export const AFFIX_BY_ID = new Map(AFFIXES.map((a) => [a.id, a]));

/**
 * Spawn an enemy and run its `init`.
 *
 * Always go through this rather than `world.spawnEnemy` directly — `init` is
 * where bosses build their parts and where affix stat changes land.
 */
export function spawnEnemyIn(
  ctx: GameCtx,
  def: EnemyDef,
  x: number,
  y: number,
  opts: EnemySpawnOpts = {},
): Entity {
  const e = ctx.world.spawnEnemy(def, x, y, {
    hpMult: opts.hpMult ?? ctx.hpMult,
    dmgMult: opts.dmgMult ?? ctx.dmgMult,
    speedMult: opts.speedMult ?? ctx.speedMult,
    ...opts,
  });

  if (e.affix !== '') {
    AFFIX_BY_ID.get(e.affix)?.onSpawn?.(e);
  }
  def.init?.(e, ctx);
  return e;
}

/** Hasted ignores slows; everything else respects them. */
function slowFor(e: Entity): number {
  return e.affix === 'hasted' ? 1 : e.slowMul;
}

// ------------------------------------------------------------------- update

export function updateEnemies(ctx: GameCtx, dt: number): void {
  const world = ctx.world;
  const dtMs = dt * 1000;

  for (let i = 0; i < world.ents.length; i++) {
    const e = world.ents[i];
    if (!e.alive || e.kind !== EKind.Enemy) continue;

    e.px = e.x;
    e.py = e.y;

    // Timers. Every one of these counts down toward zero, everywhere.
    if (e.iframes > 0) e.iframes -= dtMs;
    if (e.flash > 0) e.flash -= dtMs;
    if (e.stun > 0) e.stun -= dtMs;
    if (e.cd0 > 0) e.cd0 -= dtMs;
    if (e.cd2 > 0) e.cd2 -= dtMs;

    if (e.hasLife) {
      e.life -= dtMs;
      if (e.life <= 0) {
        world.kill(e);
        continue;
      }
    }

    // Elite aura. Cheap, and it is the only cue that a Warden is a 2.6x Warden.
    if ((e.flags & Flags.Elite) !== 0 && Math.random() < 0.5) {
      const affix = AFFIX_BY_ID.get(e.affix);
      const a = Math.random() * TAU;
      ctx.fx.particle(
        e.x + Math.cos(a) * e.r * 1.3,
        e.y + Math.sin(a) * e.r * 1.3,
        Math.cos(a) * 12,
        Math.sin(a) * 12 - 16,
        affix?.color ?? '#ffd24a',
        1.8,
        420,
        PKind.Dot,
        true,
        0.5,
      );
    }

    // Stunned enemies cannot act or steer, but knockback still moves them —
    // that separation is why the two velocity channels exist.
    if (e.stun > 0) {
      e.vx *= 0.88;
      e.vy *= 0.88;
    } else if (e.def) {
      e.def.ai(e, ctx, dt);
    }

    integrate(ctx, e, dt);
  }

  separationPass(world.ents);
}

/** Shared movement integration: velocity + knockback, through tile collision. */
function integrate(ctx: GameCtx, e: Entity, dt: number): void {
  if ((e.flags & Flags.Immobile) !== 0) {
    e.vx = 0;
    e.vy = 0;
  }

  // Knockback decay is per-tick and exponential, which is why the fixed
  // timestep matters: at variable dt this would be framerate-dependent.
  const decay = Math.pow(KNOCKBACK_DECAY, dt * 60);
  e.kx *= decay;
  e.ky *= decay;
  if (Math.abs(e.kx) < KNOCKBACK_EPSILON) e.kx = 0;
  if (Math.abs(e.ky) < KNOCKBACK_EPSILON) e.ky = 0;

  const drag = ctx.map.dragAt(e.x, e.y);
  const slow = slowFor(e);
  const vx = e.vx * drag * slow + e.kx;
  const vy = e.vy * drag * slow + e.ky;
  if (vx === 0 && vy === 0) return;

  const flying = (e.flags & Flags.Flying) !== 0;
  const res = moveCircle(ctx.map, e, vx * dt, vy * dt, flying);
  // Cancel the knockback component that hit a wall, so nothing grinds against
  // geometry for the full decay curve.
  if (res.hitX) e.kx = 0;
  if (res.hitY) e.ky = 0;
}

/**
 * Entity-vs-entity separation, brute force.
 *
 * At eighty entities this is 3,160 pairs per tick — about 190k tests a second,
 * each a handful of arithmetic ops. Measured cost is under a twentieth of a
 * millisecond. A uniform grid here would be pure premature architecture, and it
 * brings its own bug class (entities straddling cells). Do not add one.
 *
 * If a profile ever shows this above 1.5ms, the answer is single-axis
 * sweep-and-prune (insertion-sort by x, which is O(n) on nearly-sorted data,
 * then break the inner loop early), not a grid.
 */
export function separationPass(ents: Entity[]): void {
  for (let i = 0; i < ents.length; i++) {
    const a = ents[i];
    if (!a.alive || (a.flags & Flags.Pushable) === 0) continue;

    for (let j = i + 1; j < ents.length; j++) {
      const b = ents[j];
      if (!b.alive || (b.flags & Flags.Pushable) === 0) continue;

      const rr = a.r + b.r;
      // Cheap axis reject before the multiplies.
      const dy = b.y - a.y;
      if (dy > rr || dy < -rr) continue;
      const dx = b.x - a.x;
      if (dx > rr || dx < -rr) continue;

      separate(a, b, 0.35);
    }
  }
}

/**
 * Tile hazards.
 *
 * Deliberately stateless: the activation phase comes from the floor clock plus
 * a per-tile hash, so hundreds of spike plates cost nothing and never all fire
 * in unison. Only tiles near an entity are ever evaluated.
 */
export function tileHazardPass(ctx: GameCtx, dt: number): void {
  const hazards = ctx.biome.secondaryHazard && ctx.depth >= 26
    ? [ctx.biome.hazard, ctx.biome.secondaryHazard]
    : [ctx.biome.hazard];

  const world = ctx.world;
  for (let i = 0; i < world.ents.length; i++) {
    const e = world.ents[i];
    if (!e.alive) continue;
    if (e.kind !== EKind.Player && e.kind !== EKind.Enemy) continue;
    if ((e.flags & Flags.Flying) !== 0) continue;

    const tx = Math.floor(e.x / TILE);
    const ty = Math.floor(e.y / TILE);
    const tile = ctx.map.at(tx, ty);

    for (const h of hazards) {
      if (tile !== h.tile) continue;
      const isPlayer = e.kind === EKind.Player;
      if (!isPlayer && !h.hitsEnemies) continue;
      if (isPlayer && ctx.player.player?.stats.hazardImmune) continue;

      const phase = hazardPhase(ctx, h, tx, ty);
      if (phase !== 'active') continue;

      // Hazards that hurt enemies are what turn knockback relics into
      // shove-them-into-the-spikes builds. That is intended.
      const mult = !isPlayer && ctx.player.player?.stats.hazardImmune ? 2 : 1;
      if (h.dps > 0) {
        applyDamage(ctx, e, h.dps * dt * mult, {
          srcX: e.x,
          srcY: e.y - 8,
          isDot: true,
          quiet: true,
          showNumber: false,
          fromPlayer: !isPlayer,
        });
      }
      if (h.burst > 0 && e.cd0 <= 0) {
        e.cd0 = h.period > 0 ? h.period * 0.9 : 600;
        applyDamage(ctx, e, h.burst * mult, {
          srcX: e.x,
          srcY: e.y - 8,
          fromPlayer: !isPlayer,
        });
      }
      if (h.slow < 1) {
        e.slowMul = Math.min(e.slowMul, h.slow);
        e.slowT = Math.max(e.slowT, 200);
      }
    }
  }
}

export type HazardPhase = 'idle' | 'warn' | 'active';

/** Where a given hazard tile is in its cycle right now. */
export function hazardPhase(
  ctx: GameCtx,
  h: { period: number; warn: number; active: number },
  tx: number,
  ty: number,
): HazardPhase {
  if (h.period <= 0) return 'active';
  // Per-tile offset from a coordinate hash, so neighbours are out of step.
  const offset = ((tx * 73856093) ^ (ty * 19349663)) % h.period;
  const t = (ctx.timeMs + offset + h.period) % h.period;
  if (t < h.warn) return 'warn';
  if (t < h.warn + h.active) return 'active';
  return 'idle';
}

/** Normalised 0..1 progress through the current cycle, for drawing. */
export function hazardCycle(
  ctx: GameCtx,
  h: { period: number },
  tx: number,
  ty: number,
): number {
  if (h.period <= 0) return 0;
  const offset = ((tx * 73856093) ^ (ty * 19349663)) % h.period;
  return ((ctx.timeMs + offset + h.period) % h.period) / h.period;
}

/** Hostiles counted for the HUD and the trickle spawner. */
export function countHostiles(ctx: GameCtx): number {
  let n = 0;
  const ents = ctx.world.ents;
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    if (e.alive && e.kind === EKind.Enemy && e.team === TEAM_HOSTILE) n++;
  }
  return n;
}
