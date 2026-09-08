import { TILE } from '../core/constants';
import type { Tilemap } from './tiles';

/** The minimum a thing needs to collide. `Entity` structurally satisfies this. */
export interface Body {
  x: number;
  y: number;
  r: number;
}

export interface MassBody extends Body {
  mass: number;
}

export interface MoveResult {
  hitX: boolean;
  hitY: boolean;
}

/**
 * Nudge out of a wall by this much. Without it, floating point can leave the
 * circle exactly on the tile boundary, `Math.floor` flip-flops, and you get a
 * one-frame jitter against every wall. A real bug in every hand-rolled version
 * of this.
 */
const PUSH_EPSILON = 0.01;

const _result: MoveResult = { hitX: false, hitY: false };

/**
 * Move a circle through the tile grid, resolving each axis separately.
 *
 * Axis separation is what gives free wall-sliding (walk diagonally into a wall
 * and keep the tangential component) and it cannot produce the "pushed out
 * along the wrong normal at a corner" pop that a single-pass minimum
 * translation vector gives you.
 */
export function moveCircle(
  map: Tilemap,
  b: Body,
  dx: number,
  dy: number,
  flying = false,
): MoveResult {
  _result.hitX = false;
  _result.hitY = false;
  if (dx === 0 && dy === 0) return _result;

  // Substep so a fast mover cannot tunnel. Normal play is one substep; this
  // only kicks in for dashes and projectiles.
  const distance = Math.sqrt(dx * dx + dy * dy);
  const steps = distance > TILE * 0.5 ? Math.ceil(distance / (TILE * 0.5)) : 1;
  const sx = dx / steps;
  const sy = dy / steps;

  for (let s = 0; s < steps; s++) {
    if (sx !== 0) {
      b.x += sx;
      if (resolveAxis(map, b, 0, sx, flying)) _result.hitX = true;
    }
    if (sy !== 0) {
      b.y += sy;
      if (resolveAxis(map, b, 1, sy, flying)) _result.hitY = true;
    }
  }
  return _result;
}

/** Push the circle out of any overlapping solid tile, along one axis only. */
function resolveAxis(
  map: Tilemap,
  b: Body,
  axis: 0 | 1,
  step: number,
  flying: boolean,
): boolean {
  const r = b.r;
  const tx0 = Math.floor((b.x - r) / TILE);
  const tx1 = Math.floor((b.x + r) / TILE);
  const ty0 = Math.floor((b.y - r) / TILE);
  const ty1 = Math.floor((b.y + r) / TILE);
  let hit = false;

  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      if (!map.isBlocked(tx, ty, flying)) continue;

      // Closest point on the tile rect to the circle centre.
      const left = tx * TILE;
      const top = ty * TILE;
      const right = left + TILE;
      const bottom = top + TILE;
      const cx = b.x < left ? left : b.x > right ? right : b.x;
      const cy = b.y < top ? top : b.y > bottom ? bottom : b.y;
      const ddx = b.x - cx;
      const ddy = b.y - cy;
      if (ddx * ddx + ddy * ddy >= r * r) continue;

      if (axis === 0) {
        b.x = step > 0 ? left - r - PUSH_EPSILON : right + r + PUSH_EPSILON;
      } else {
        b.y = step > 0 ? top - r - PUSH_EPSILON : bottom + r + PUSH_EPSILON;
      }
      hit = true;
    }
  }
  return hit;
}

/**
 * Nearest non-blocked position to (x, y), searched outward in rings. Used when
 * something has to be placed or teleported somewhere legal (falling in a pit,
 * spawning, a boss warp).
 */
export function nearestFree(
  map: Tilemap,
  x: number,
  y: number,
  r: number,
  maxRings = 12,
): { x: number; y: number } {
  const startX = Math.floor(x / TILE);
  const startY = Math.floor(y / TILE);
  for (let ring = 0; ring <= maxRings; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        // Only the perimeter of each ring.
        if (ring > 0 && Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
        const tx = startX + dx;
        const ty = startY + dy;
        if (map.isBlocked(tx, ty)) continue;
        // Require the 4-neighbourhood to be open enough for the radius.
        if (r > TILE * 0.4) {
          if (
            map.isBlocked(tx - 1, ty) && map.isBlocked(tx + 1, ty) &&
            map.isBlocked(tx, ty - 1) && map.isBlocked(tx, ty + 1)
          ) {
            continue;
          }
        }
        return { x: tx * TILE + TILE * 0.5, y: ty * TILE + TILE * 0.5 };
      }
    }
  }
  return { x, y };
}

// ------------------------------------------------------- circle vs circle

export function overlap(a: Body, b: Body): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const rr = a.r + b.r;
  return dx * dx + dy * dy < rr * rr;
}

export function overlapPoint(a: Body, x: number, y: number, extra = 0): boolean {
  const dx = x - a.x;
  const dy = y - a.y;
  const rr = a.r + extra;
  return dx * dx + dy * dy < rr * rr;
}

/**
 * Push two overlapping circles apart, weighted by mass. `strength` in [0,1]
 * controls how much of the overlap is resolved this tick; a value below 1 makes
 * crowds feel soft rather than springy.
 */
export function separate(a: MassBody, b: MassBody, strength: number): void {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  let d2 = dx * dx + dy * dy;
  const rr = a.r + b.r;
  if (d2 >= rr * rr) return;

  // Exactly co-located (two things spawned on the same tile) — pick a direction.
  if (d2 < 1e-6) {
    dx = 0.5;
    dy = 0;
    d2 = 0.25;
  }

  const d = Math.sqrt(d2);
  const push = (rr - d) * strength;
  const nx = dx / d;
  const ny = dy / d;
  const total = a.mass + b.mass;
  const shareA = b.mass / total;
  const shareB = 1 - shareA;

  a.x -= nx * push * shareA;
  a.y -= ny * push * shareA;
  b.x += nx * push * shareB;
  b.y += ny * push * shareB;
}

// ---------------------------------------------------------------- melee cone

/**
 * Is `target` inside a cone at (ax, ay) facing (dirX, dirY)?
 *
 * `cosHalfArc` is precomputed by the caller (`Math.cos(halfArcRadians)`) so
 * there is no trig in the hot path. Called once per hostile per active tick:
 * 80 enemies x 4 ticks = 320 calls per swing, which is free.
 *
 * A cone rather than a swept circle because (1) it matches the arc that gets
 * drawn, so what the player sees is what hits, and (2) widening the arc is a
 * single generosity dial, which is how forgiveness gets tuned.
 */
export function coneHit(
  ax: number,
  ay: number,
  dirX: number,
  dirY: number,
  cosHalfArc: number,
  reach: number,
  target: Body,
): boolean {
  const dx = target.x - ax;
  const dy = target.y - ay;
  const rr = reach + target.r;
  const d2 = dx * dx + dy * dy;
  if (d2 > rr * rr) return false;
  // Overlapping the origin always connects, regardless of facing.
  if (d2 < target.r * target.r) return true;
  const inv = 1 / Math.sqrt(d2);
  return dx * inv * dirX + dy * inv * dirY >= cosHalfArc;
}

/** Circle-vs-circle for area effects: explosions, shockwaves, pools. */
export function inRadius(x: number, y: number, radius: number, target: Body): boolean {
  const dx = target.x - x;
  const dy = target.y - y;
  const rr = radius + target.r;
  return dx * dx + dy * dy < rr * rr;
}

/** Ring test with an inner cutoff, for expanding shockwaves. */
export function inRing(
  x: number,
  y: number,
  inner: number,
  outer: number,
  target: Body,
): boolean {
  const dx = target.x - x;
  const dy = target.y - y;
  const d2 = dx * dx + dy * dy;
  const lo = Math.max(0, inner - target.r);
  const hi = outer + target.r;
  return d2 >= lo * lo && d2 <= hi * hi;
}
