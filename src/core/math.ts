/**
 * Allocation-free math helpers. Functions that would naturally return a vector
 * write into a caller-supplied out-param or a module scratch instead, because
 * anything here can be called tens of thousands of times per second.
 */

export const TAU = Math.PI * 2;

export interface Vec2 {
  x: number;
  y: number;
}

/** Shared scratch vectors. Read the result immediately; never hold onto one. */
export const scratchA: Vec2 = { x: 0, y: 0 };
export const scratchB: Vec2 = { x: 0, y: 0 };

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function invLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : (v - a) / (b - a);
}

/**
 * Framerate-independent exponential approach. `rate` is roughly "how many
 * e-foldings per second"; 8 is a snappy camera, 2 is a lazy one.
 */
export function expDecay(cur: number, target: number, rate: number, dt: number): number {
  return cur + (target - cur) * (1 - Math.exp(-rate * dt));
}

/** Move `cur` toward `target` by at most `maxDelta`. */
export function moveToward(cur: number, target: number, maxDelta: number): number {
  const d = target - cur;
  if (d > maxDelta) return cur + maxDelta;
  if (d < -maxDelta) return cur - maxDelta;
  return target;
}

export function len(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return Math.sqrt(dx * dx + dy * dy);
}

export function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

/** Normalize into `out`. Zero-length input yields (0, 0) and returns 0. */
export function normalize(x: number, y: number, out: Vec2): number {
  const l = Math.sqrt(x * x + y * y);
  if (l < 1e-9) {
    out.x = 0;
    out.y = 0;
    return 0;
  }
  out.x = x / l;
  out.y = y / l;
  return l;
}

/** Smallest signed delta from angle `a` to angle `b`, in (-PI, PI]. */
export function shortestAngle(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** Interpolate between angles the short way round. `t` is clamped to [0,1]. */
export function angleLerp(a: number, b: number, t: number): number {
  return a + shortestAngle(a, b) * clamp01(t);
}

/** Rotate `a` toward `b` by at most `maxDelta` radians. */
export function angleToward(a: number, b: number, maxDelta: number): number {
  const d = shortestAngle(a, b);
  if (d > maxDelta) return a + maxDelta;
  if (d < -maxDelta) return a - maxDelta;
  return b;
}

export function smoothstep(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

export function easeOutCubic(t: number): number {
  const x = 1 - clamp01(t);
  return 1 - x * x * x;
}

export function easeInQuad(t: number): number {
  const x = clamp01(t);
  return x * x;
}

/**
 * Deterministic integer hash of two coordinates -> [0, 2^32). Used for per-tile
 * visual variation, so it must be stable across frames and across reloads.
 */
export function hash2(x: number, y: number): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1)) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 0x2545f491) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  return h >>> 0;
}

/** `hash2` reduced to [0, 1). */
export function hash2f(x: number, y: number): number {
  return hash2(x, y) / 4294967296;
}

/** Nearest multiple of `step`. */
export function snap(v: number, step: number): number {
  return Math.round(v / step) * step;
}

/** True if `v` is a usable finite number. */
export function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
