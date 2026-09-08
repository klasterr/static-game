/**
 * Seeded randomness.
 *
 * Two rules make the whole run reproducible from a seed string, and both are
 * load-bearing:
 *
 *  1. Every concern gets its OWN stream (see `Stream`). Adding a loot roll must
 *     not shift the dungeon layout, or every content tweak invalidates every
 *     shared seed and "same seed, different map" becomes unfindable.
 *  2. A seeded stream may never be advanced by a call whose occurrence or count
 *     depends on non-deterministic state: frame timing, player position, Map/Set
 *     iteration order, or promise ordering. Iterate rooms by `id`, never by
 *     hash-map order.
 *
 * Cosmetic randomness (particles, shake, hit-flash jitter, audio detune) should
 * use `Math.random` directly. It must NOT touch these streams.
 */

// --------------------------------------------------------------- primitives

/** Hash a string into four 32-bit seed words. */
export function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [
    (h1 ^ h2 ^ h3 ^ h4) >>> 0,
    (h2 ^ h1) >>> 0,
    (h3 ^ h1) >>> 0,
    (h4 ^ h1) >>> 0,
  ];
}

/** sfc32: 128 bits of state, passes PractRand far beyond anything a game needs. */
export function sfc32(a: number, b: number, c: number, d: number): () => number {
  let s0 = a >>> 0;
  let s1 = b >>> 0;
  let s2 = c >>> 0;
  let s3 = d >>> 0;
  return function next(): number {
    let t = (s0 + s1) | 0;
    s0 = s1 ^ (s1 >>> 9);
    s1 = (s2 + (s2 << 3)) | 0;
    s2 = (s2 << 21) | (s2 >>> 11);
    s3 = (s3 + 1) | 0;
    t = (t + s3) | 0;
    s2 = (s2 + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/** mulberry32: 32 bits of state. Fine for short-lived derived streams. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Mix a base seed with integer parts. Order-sensitive with good avalanche, so
 * `deriveSeed(s, 3, 1)` and `deriveSeed(s, 1, 3)` are unrelated.
 */
export function deriveSeed(base: number, ...parts: number[]): number {
  let h = base >>> 0;
  for (let i = 0; i < parts.length; i++) {
    h = Math.imul(h ^ (parts[i] >>> 0), 2654435761) >>> 0;
    h = (h ^ (h >>> 15)) >>> 0;
    h = Math.imul(h, 2246822519) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
  }
  return (h ^ (h >>> 16)) >>> 0;
}

// ------------------------------------------------------------------ streams

/**
 * One number per concern. Never renumber these — doing so silently changes
 * every existing seed.
 */
export const Stream = {
  Layout: 1,
  Population: 2,
  Loot: 3,
  Modifier: 4,
  Shrine: 5,
  Shop: 6,
  Event: 7,
  BossPattern: 8,
  Combat: 9,
  Decoration: 10,
  Perk: 11,
} as const;
export type StreamId = (typeof Stream)[keyof typeof Stream];

// -------------------------------------------------------------------- facade

export interface WeightedEntry<T> {
  value: T;
  weight: number;
}

/**
 * Never call a raw `() => number` from gameplay code — go through this, so call
 * counts stay auditable in the dev overlay and desyncs are findable.
 */
export interface Rng {
  readonly id: string;
  /** Number of values drawn so far. Dev diagnostics only. */
  calls: number;
  /** [0, 1) */
  next(): number;
  /** Integer in [min, max], both inclusive. */
  int(min: number, max: number): number;
  /** Float in [min, max). */
  float(min: number, max: number): number;
  chance(p: number): boolean;
  /** ±1 with equal probability. */
  sign(): 1 | -1;
  pick<T>(arr: readonly T[]): T;
  /** Draw an index; useful when you need the position too. */
  pickIndex(len: number): number;
  weighted<T>(entries: readonly WeightedEntry<T>[]): T;
  /** In-place Fisher-Yates. Returns the same array. */
  shuffle<T>(arr: T[]): T[];
  /** Normally distributed via Box-Muller. */
  gauss(mean: number, sd: number): number;
  /** A deterministic child stream. Independent of further draws on the parent. */
  fork(label: string): Rng;
}

class RngImpl implements Rng {
  readonly id: string;
  calls = 0;

  private readonly raw: () => number;
  private readonly seed: number;
  private spare: number | null = null;

  constructor(seed: number, id: string) {
    this.id = id;
    this.seed = seed >>> 0;
    const [a, b, c, d] = cyrb128(`${this.seed}`);
    this.raw = sfc32(a, b, c, d);
    // Discard a few values; sfc32's first outputs are weakly mixed for
    // low-entropy seeds, which shows up as correlated first rooms.
    for (let i = 0; i < 12; i++) this.raw();
  }

  next(): number {
    this.calls++;
    return this.raw();
  }

  int(min: number, max: number): number {
    if (max <= min) return min;
    return min + Math.floor(this.next() * (max - min + 1));
  }

  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  sign(): 1 | -1 {
    return this.next() < 0.5 ? -1 : 1;
  }

  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error(`rng.pick on empty array (stream ${this.id})`);
    return arr[Math.floor(this.next() * arr.length)];
  }

  pickIndex(length: number): number {
    if (length <= 0) return -1;
    return Math.floor(this.next() * length);
  }

  weighted<T>(entries: readonly WeightedEntry<T>[]): T {
    let total = 0;
    for (let i = 0; i < entries.length; i++) {
      const w = entries[i].weight;
      if (w > 0) total += w;
    }
    if (total <= 0) {
      throw new Error(`rng.weighted with no positive weights (stream ${this.id})`);
    }
    let roll = this.next() * total;
    for (let i = 0; i < entries.length; i++) {
      const w = entries[i].weight;
      if (w <= 0) continue;
      roll -= w;
      if (roll < 0) return entries[i].value;
    }
    // Float drift only; fall back to the last positive-weight entry.
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].weight > 0) return entries[i].value;
    }
    throw new Error('unreachable');
  }

  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  gauss(mean: number, sd: number): number {
    if (this.spare !== null) {
      const s = this.spare;
      this.spare = null;
      return mean + sd * s;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = this.next() * 2 - 1;
      v = this.next() * 2 - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    this.spare = v * mul;
    return mean + sd * u * mul;
  }

  fork(label: string): Rng {
    // Derived from the seed, not from the current state, so forking is stable
    // no matter how many values the parent has already produced.
    const [h] = cyrb128(label);
    return new RngImpl(deriveSeed(this.seed, h), `${this.id}/${label}`);
  }
}

export function makeRng(seed: number, id: string): Rng {
  return new RngImpl(seed, id);
}

/**
 * The per-floor, per-stream generator. Floor-indexed rather than sequential, so
 * a dev tool can jump straight to floor 40 and CI can fuzz thousands of floors
 * without simulating the ones before them.
 */
export function floorRng(runSeed: number, floor: number, stream: StreamId, label = ''): Rng {
  const seed = deriveSeed(runSeed, floor, stream, label.length);
  return makeRng(seed, `f${floor}/s${stream}${label ? `/${label}` : ''}`);
}

// -------------------------------------------------------------- seed strings

/**
 * Crockford-ish alphabet with I, O, 0 and 1 removed so a seed can be read aloud
 * and typed back without ambiguity.
 */
const SEED_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const SEED_LENGTH = 8;

/** Turn a user-typed seed string into a run seed. Any string is acceptable. */
export function runSeedFromString(s: string): number {
  const [a] = cyrb128(s.trim().toUpperCase());
  return a >>> 0;
}

/** Render a run seed as a typeable 8-character string. */
export function seedToString(seed: number): string {
  const r = mulberry32(seed >>> 0);
  let out = '';
  for (let i = 0; i < SEED_LENGTH; i++) {
    out += SEED_ALPHABET[Math.floor(r() * SEED_ALPHABET.length)];
  }
  return out;
}

/** A fresh random seed plus its display string. Uses `Math.random` by design. */
export function newRunSeed(): { seed: number; text: string } {
  const raw = (Math.random() * 4294967296) >>> 0;
  const text = seedToString(raw);
  // Round-trip through the text so what the player sees always reproduces the
  // run they actually played.
  return { seed: runSeedFromString(text), text };
}

/** Normalize a seed the player typed. Empty input yields a fresh random seed. */
export function parseSeedInput(input: string): { seed: number; text: string } {
  const cleaned = input.trim().toUpperCase();
  if (cleaned.length === 0) return newRunSeed();
  return { seed: runSeedFromString(cleaned), text: cleaned };
}
