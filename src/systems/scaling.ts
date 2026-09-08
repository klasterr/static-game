/**
 * The entire difficulty design lives in this file. Every balance conversation
 * will happen here, so the reasoning is written down next to the numbers.
 *
 * Stance: enemy power scales slightly faster than player power, so the player
 * always eventually loses. Meta-progression moves the INTERCEPT, not the slope.
 * That guarantees a finite run, gives a personal best to chase, and removes the
 * impossible problem of balancing floor 500.
 */

/**
 * HP scales fastest. HP is the "how long does this take" knob, and longer
 * fights mean more chances to make a mistake — the least frustrating form of
 * pressure there is.
 */
export function hpMult(depth: number): number {
  return Math.pow(1.115, depth - 1);
}

/**
 * Damage scales slower than HP. Damage is the "did I just get one-shot" knob
 * and it is the main source of feeling cheated. Because HP outruns it, deep
 * floors kill by attrition across a long fight rather than a surprise 90%
 * chunk — and attrition deaths feel like your own fault.
 */
export function dmgMult(depth: number): number {
  return Math.pow(1.075, depth - 1);
}

/**
 * Speed is CAPPED, hard, at 1.35x (reached around floor 36).
 *
 * Enemy speed is the most player-hostile stat in the game because it removes
 * the option to disengage. Past roughly 1.35x base you cannot kite anything and
 * the game is unfair regardless of build. Late-game pressure comes from
 * behaviour escalation instead (see `escalationFor` in world/ctx.ts).
 */
export function speedMult(depth: number): number {
  return Math.min(1.35, 1 + 0.01 * (depth - 1));
}

export function xpPerKill(depth: number): number {
  return 5 + 2 * depth;
}

/** Initial population budget, spent against `EnemyWeight.cost`. */
export function enemyBudget(depth: number, walkableTiles: number): number {
  const byDepth = Math.min(130, Math.round(45 + 3.5 * depth));
  const byDensity = Math.round(walkableTiles / 62);
  return Math.max(12, Math.round(Math.min(byDepth, byDensity * 1.25)));
}

/** Concurrent threat ceiling. The trickle spawner respects this. */
export function liveEnemyCap(depth: number): number {
  return Math.min(45, Math.round(22 + 0.8 * depth));
}

/** Seconds between trickle spawns. */
export function trickleInterval(depth: number): number {
  return Math.max(3.0, 7.0 - 0.12 * depth);
}

export function eliteCount(depth: number): number {
  return 1 + Math.floor(depth / 6);
}

/**
 * Boss HP sits deliberately ON the normal curve rather than above it. A boss
 * that is a stat wall is just a long fight; a boss that is a mechanics test at
 * ordinary durability is a fight you remember.
 */
export function bossHp(base: number, depth: number): number {
  return Math.round(base * hpMult(depth) * 1.06);
}

// ------------------------------------------------------------- floor shape

export interface FloorPlan {
  w: number;
  h: number;
  roomCount: [number, number];
}

/**
 * Floors are meaty on purpose: the main path is forced to be at least
 * 0.9*(W+H) tiles, which is roughly half a minute of uninterrupted walking, and
 * a completionist route through the shrine, vault, elite room and shop is about
 * three times that. Target clear time is 3.5-4.5 minutes.
 */
export function floorPlan(depth: number): FloorPlan {
  if (depth <= 3) return { w: 76, h: 76, roomCount: [10, 13] };
  if (depth <= 9) return { w: 88, h: 88, roomCount: [12, 16] };
  if (depth <= 19) return { w: 100, h: 100, roomCount: [14, 20] };
  return { w: 112, h: 112, roomCount: [16, 22] };
}

/**
 * Boss floors are a fixed, hand-shaped layout: antechamber, hall, arena, and a
 * reward vault BEHIND the arena. Putting the stairs behind the boss removes any
 * ambiguity about whether the fight is optional.
 */
export const BOSS_PLAN: FloorPlan = { w: 76, h: 48, roomCount: [4, 4] };

export function isBossFloor(depth: number): boolean {
  return depth % 5 === 0;
}

/**
 * Minimum acceptable entrance-to-exit tile distance.
 *
 * The design target was 0.9*(W+H), but that turned out to be unachievable:
 * rooms cannot sit in the literal corners (two tiles of border plus half a room
 * width), so the best pair on a 100x100 map tops out around 0.7*(W+H) and the
 * generator was rejecting two thirds of perfectly good floors. Measured against
 * 400 floors, 0.62 is the tightest value that virtually every layout clears.
 *
 * It still buys what the target was for: 124 tiles on a 100x100 map is ~4,000
 * world px, or roughly 22 seconds of uninterrupted walking on the main route,
 * and a completionist loop through the shrine, vault, elite room and shop is
 * about three times that.
 */
export function minMainPath(w: number, h: number): number {
  return Math.round(0.62 * (w + h));
}

// -------------------------------------------------------------- progression

/** Cumulative XP required to reach level `n`. */
export function xpForLevel(n: number): number {
  return Math.round(24 * Math.pow(n, 1.35));
}

export function xpToNext(level: number): number {
  return Math.max(10, xpForLevel(level + 1) - xpForLevel(level));
}

/** Every third level grants a choose-1-of-3 perk. */
export function grantsPerk(level: number): boolean {
  return level % 3 === 0;
}

export const HP_PER_LEVEL = 8;
export const DMG_PER_LEVEL = 0.03;

// ------------------------------------------------------------------- rarity

/**
 * Rarity roll weights, drifting out of Common as you descend. Legendary reaches
 * roughly 8% by floor 20.
 */
export function rarityWeights(depth: number): [number, number, number, number] {
  const drift = Math.min(0.34, 0.0035 * (depth - 1));
  const common = Math.max(0.2, 0.62 - drift * 3);
  const uncommon = 0.26 + drift * 1.2;
  const rare = 0.09 + drift * 1.2;
  const legendary = 0.03 + drift * 0.6;
  const total = common + uncommon + rare + legendary;
  return [common / total, uncommon / total, rare / total, legendary / total];
}

// -------------------------------------------------------------------- souls

export interface RunSummary {
  deepestFloor: number;
  bossesKilled: number;
  elitesKilled: number;
  kills: number;
}

/**
 * Sublinear in depth, with a large new-record bonus.
 *
 * The shape matters more than the constants: because pushing deeper always
 * beats re-farming an early floor, there is no optimal grind loop to discover,
 * so nobody ever feels stupid for just playing the game.
 */
export function soulsEarned(r: RunSummary, bestDepth: number): number {
  const d = Math.max(0, r.deepestFloor);
  const base = 6 * d + 0.9 * Math.pow(d, 1.6);
  const bosses = 15 * r.bossesKilled;
  const elites = 0.5 * r.elitesKilled;
  const record = d > bestDepth ? 25 * (d - bestDepth) : 0;
  return Math.round(base + bosses + elites + record);
}
