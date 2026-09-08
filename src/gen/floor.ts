import { TILE } from '../core/constants';
import { Stream, floorRng, type Rng } from '../core/rng';
import type { SaveData } from '../core/storage';
import { biomeForDepth } from '../content';
import { OSSUARY_CHOIR } from '../content/enemies/bosses';
import { MODIFIERS, NO_MODIFIER, modifierById, modifierChance } from '../content/modifiers';
import type { BiomeDef } from '../content/types/biome';
import type { ModifierDef } from '../content/modifiers';
import { Tile, Tilemap } from '../world/tiles';
import { BOSS_PLAN, floorPlan, isBossFloor, minMainPath } from '../systems/scaling';
import { poolsFor } from '../systems/loot';
import { Tint } from '../render/lighting';
import { accentSpecialRooms, placeEmitters, placeHazards } from './decorate';
import { sealSmallOrphans } from './connectivity';
import { bossSpawnPoint, generateBossFloor } from './generateBossFloor';
import { carveCaves } from './generateCaves';
import { carveRooms } from './generateRooms';
import { indexRooms, makeRoom, type Level, type Room } from './level';
import { populateFloor } from './populate';
import { assignSpecialRooms, clearPad, pickStairs } from './specialRooms';

/**
 * The floor generator.
 *
 * Pipeline, shared by both layout generators:
 *
 *   carve -> connectivity repair -> flood-fill assertion (regenerate if it
 *   fails) -> stairs -> special rooms -> hazards -> decoration -> population
 *
 * The regenerate loop exists as a safety net, not as the plan: Prim's MST and
 * largest-region-keep make the assertion pass on the first attempt essentially
 * always. It must never crash a run, so there is a hardcoded fallback at the end.
 */

export interface FloorRequest {
  depth: number;
  runSeed: number;
  save: SaveData;
  /** Class passive: extra relics per floor. */
  bonusRelics: number;
  /** Player arrived below 35% health — triggers the silent catch-up rule. */
  needsMercy: boolean;
  /** Last few modifier ids, so the same one never repeats too soon. */
  recentModifiers: readonly string[];
}

export interface FloorResult {
  level: Level;
  biome: BiomeDef;
  modifier: ModifierDef;
}

const MAX_ATTEMPTS = 5;
/** Orphan pockets at or below this size are just filled in. */
const ORPHAN_TOLERANCE = 30;

export function generateFloor(req: FloorRequest): FloorResult {
  const biome = biomeForDepth(req.depth);
  const modifier = pickModifier(req);

  if (isBossFloor(req.depth)) {
    return { level: buildBossFloor(req, biome, modifier), biome, modifier };
  }

  const plan = floorPlan(req.depth);
  let level: Level | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const rng = floorRng(req.runSeed, req.depth, Stream.Layout, `a${attempt}`);
    const candidate = tryBuild(req, biome, modifier, rng, plan, attempt);
    if (candidate) {
      level = candidate;
      break;
    }
  }

  if (!level) {
    // Five failures in a row means something is wrong with the parameters, not
    // with the seed. Ship a known-good ring so the run continues, and make the
    // failure loud in dev.
    if (import.meta.env?.DEV) {
      console.warn(`[gen] fell back to the emergency layout on floor ${req.depth}`);
    }
    level = buildFallback(req, biome, modifier);
  }

  populate(req, biome, modifier, level);
  return { level, biome, modifier };
}

function tryBuild(
  req: FloorRequest,
  biome: BiomeDef,
  modifier: ModifierDef,
  rng: Rng,
  plan: { w: number; h: number; roomCount: [number, number] },
  attempt: number,
): Level | null {
  const carve =
    biome.generator.kind === 'caves'
      ? carveCaves(rng, plan, biome.generator)
      : carveRooms(rng, plan, biome.generator);

  const { map, rooms } = carve;
  if (rooms.length < 3) return null;

  // Connectivity: fill the small pockets, bail on a big one.
  const anchor = rooms[0];
  if (!map.isWalkable(anchor.cx, anchor.cy)) return null;
  const largestOrphan = sealSmallOrphans(map, anchor.cx, anchor.cy, ORPHAN_TOLERANCE);
  if (largestOrphan > ORPHAN_TOLERANCE) return null;

  // Drop chambers that the seal pass just walled off.
  const live = rooms.filter((r) => map.isWalkable(r.cx, r.cy));
  if (live.length < 3) return null;
  for (let i = 0; i < live.length; i++) live[i].id = i;

  const stairs = pickStairs(map, live);
  if (!stairs) return null;
  if (stairs.pathLength < minMainPath(plan.w, plan.h) * 0.6) {
    // Well under target: the layout is too compact to be worth playing.
    return null;
  }

  clearPad(map, stairs.entrance.cx, stairs.entrance.cy, 1);
  clearPad(map, stairs.exit.cx, stairs.exit.cy, 1);
  map.set(stairs.entrance.cx, stairs.entrance.cy, Tile.StairsUp);
  map.set(stairs.exit.cx, stairs.exit.cy, Tile.StairsDown);

  assignSpecialRooms(rng, map, live, stairs.entrance, stairs.exit, stairs.pathLength, {
    depth: req.depth,
    guaranteeShop: req.depth === 1,
  });

  const entrance = {
    x: stairs.entrance.cx * TILE + TILE * 0.5,
    y: stairs.entrance.cy * TILE + TILE * 0.5,
  };
  const exit = {
    x: stairs.exit.cx * TILE + TILE * 0.5,
    y: stairs.exit.cy * TILE + TILE * 0.5,
  };

  const hazardRng = floorRng(req.runSeed, req.depth, Stream.Decoration, `haz${attempt}`);
  const hazards = req.depth >= 26 && biome.secondaryHazard
    ? [biome.hazard, biome.secondaryHazard]
    : [biome.hazard];
  placeHazards(
    hazardRng,
    map,
    hazards,
    biome.generator.hazardDensity,
    { tx: stairs.entrance.cx, ty: stairs.entrance.cy },
    { tx: stairs.exit.cx, ty: stairs.exit.cy },
  );

  const emitters = placeEmitters(hazardRng, map, live, biome, {
    tx: stairs.exit.cx,
    ty: stairs.exit.cy,
  });
  accentSpecialRooms(live, emitters);
  // Modifier light scaling (Darkened) applies to every emitter uniformly.
  if (modifier.lightMul !== 1) {
    for (const e of emitters) e.radius *= modifier.lightMul;
  }

  return {
    depth: req.depth,
    seed: req.runSeed,
    biomeId: biome.id,
    modifierId: modifier.id === 'none' ? null : modifier.id,
    map,
    rooms: live,
    entrance,
    exit,
    spawns: [],
    loot: [],
    emitters,
    mainPathLength: stairs.pathLength,
    roomAt: indexRooms(map, live),
    isBoss: false,
    attempts: attempt,
  };
}

function populate(
  req: FloorRequest,
  biome: BiomeDef,
  modifier: ModifierDef,
  level: Level,
): void {
  populateFloor({
    level,
    biome,
    modifier,
    depth: req.depth,
    popRng: floorRng(req.runSeed, req.depth, Stream.Population),
    lootRng: floorRng(req.runSeed, req.depth, Stream.Loot),
    pools: poolsFor(req.save),
    bonusRelics: req.bonusRelics,
    needsMercy: req.needsMercy,
  });
}

// --------------------------------------------------------------- boss floors

function buildBossFloor(
  req: FloorRequest,
  biome: BiomeDef,
  modifier: ModifierDef,
): Level {
  const rng = floorRng(req.runSeed, req.depth, Stream.Layout, 'boss');
  const layout = generateBossFloor(rng);
  const { map, rooms } = layout;

  const entranceTx = layout.antechamber.x + 2;
  const entranceTy = layout.antechamber.cy;
  const exitTx = layout.vault.x + layout.vault.w - 2;
  const exitTy = layout.vault.cy;

  const emitters = placeEmitters(rng, map, rooms, biome, { tx: exitTx, ty: exitTy });
  // Ring the arena so the fight is fully lit. A boss you cannot see is not
  // difficult, just annoying.
  emitters.push({
    x: (layout.arena.x + (layout.arena.w >> 1)) * TILE,
    y: (layout.arena.y + (layout.arena.h >> 1)) * TILE,
    radius: 620,
    tint: Tint.Warm,
    flickers: false,
  });

  const level: Level = {
    depth: req.depth,
    seed: req.runSeed,
    biomeId: biome.id,
    modifierId: null,
    map,
    rooms,
    entrance: { x: entranceTx * TILE + TILE * 0.5, y: entranceTy * TILE + TILE * 0.5 },
    exit: { x: exitTx * TILE + TILE * 0.5, y: exitTy * TILE + TILE * 0.5 },
    spawns: [],
    loot: [],
    emitters,
    mainPathLength: BOSS_PLAN.w,
    roomAt: indexRooms(map, rooms),
    isBoss: true,
    attempts: 0,
  };

  const boss = bossSpawnPoint(layout);
  level.spawns.push({
    enemyId: OSSUARY_CHOIR.id,
    x: boss.x,
    y: boss.y,
    elite: false,
    affix: '',
    roomId: layout.arena.id,
    boss: true,
  });

  // Antechamber support: a healing shrine and a shop, so arriving hurt is not a
  // dead end and the boss is always a choice you prepared for.
  level.loot.push({
    kind: 'shrine',
    id: 'mending',
    x: (layout.antechamber.x + 6) * TILE,
    y: (layout.antechamber.cy - 3) * TILE,
    roomId: layout.antechamber.id,
    rarityBoost: 0,
    price: 0,
  });

  const shopRng = floorRng(req.runSeed, req.depth, Stream.Shop, 'boss');
  const pools = poolsFor(req.save);
  for (let i = 0; i < 2; i++) {
    if (pools.relics.length === 0) break;
    level.loot.push({
      kind: 'shop',
      id: shopRng.pick(pools.relics),
      x: (layout.antechamber.x + 9 + i * 3) * TILE,
      y: (layout.antechamber.cy + 3) * TILE,
      roomId: layout.antechamber.id,
      rarityBoost: 0,
      price: Math.round(45 * (1 + req.depth * 0.06)),
      offer: 'relic',
    });
  }

  // Reward vault: a guaranteed high-tier chest for beating the boss.
  level.loot.push({
    kind: 'chest',
    id: '',
    x: (layout.vault.x + 3) * TILE,
    y: layout.vault.cy * TILE,
    roomId: layout.vault.id,
    rarityBoost: 2,
    price: 0,
  });

  void modifier;
  return level;
}

// ------------------------------------------------------------------ fallback

/**
 * A hardcoded five-room ring. Never seen in normal play; it exists so a
 * pathological parameter combination degrades into a playable floor instead of
 * an exception in the middle of someone's run.
 */
function buildFallback(
  req: FloorRequest,
  biome: BiomeDef,
  modifier: ModifierDef,
): Level {
  const w = 60;
  const h = 44;
  const map = new Tilemap(w, h, Tile.Wall);
  const rooms: Room[] = [];
  const positions: Array<[number, number]> = [
    [4, 4],
    [40, 4],
    [40, 28],
    [4, 28],
    [22, 16],
  ];

  positions.forEach(([x, y], i) => {
    const r = makeRoom(i, x, y, 15, 11);
    rooms.push(r);
    for (let ty = r.y; ty < r.y + r.h; ty++) {
      for (let tx = r.x; tx < r.x + r.w; tx++) map.set(tx, ty, Tile.Floor);
    }
  });

  for (let i = 0; i < rooms.length; i++) {
    const a = rooms[i];
    const b = rooms[(i + 1) % rooms.length];
    corridor(map, a.cx, a.cy, b.cx, a.cy);
    corridor(map, b.cx, a.cy, b.cx, b.cy);
    a.neighbors.push(b.id);
    b.neighbors.push(a.id);
    a.degree++;
    b.degree++;
  }

  rooms[0].kind = 'entrance';
  rooms[2].kind = 'exit';
  rooms[1].kind = 'elite';
  rooms[3].kind = 'shrine';
  rooms[4].kind = 'treasure';

  map.set(rooms[0].cx, rooms[0].cy, Tile.StairsUp);
  map.set(rooms[2].cx, rooms[2].cy, Tile.StairsDown);

  const rng = floorRng(req.runSeed, req.depth, Stream.Decoration, 'fallback');
  const emitters = placeEmitters(rng, map, rooms, biome, {
    tx: rooms[2].cx,
    ty: rooms[2].cy,
  });

  return {
    depth: req.depth,
    seed: req.runSeed,
    biomeId: biome.id,
    modifierId: modifier.id === 'none' ? null : modifier.id,
    map,
    rooms,
    entrance: { x: rooms[0].cx * TILE + TILE * 0.5, y: rooms[0].cy * TILE + TILE * 0.5 },
    exit: { x: rooms[2].cx * TILE + TILE * 0.5, y: rooms[2].cy * TILE + TILE * 0.5 },
    spawns: [],
    loot: [],
    emitters,
    mainPathLength: 80,
    roomAt: indexRooms(map, rooms),
    isBoss: false,
    attempts: MAX_ATTEMPTS,
  };
}

function corridor(map: Tilemap, x0: number, y0: number, x1: number, y1: number): void {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  const sx = Math.sign(x1 - x0);
  const sy = Math.sign(y1 - y0);
  for (let i = 0; i <= steps; i++) {
    const x = x0 + sx * i;
    const y = y0 + sy * i;
    for (let d = 0; d < 2; d++) {
      const tx = x + (sy !== 0 ? d : 0);
      const ty = y + (sx !== 0 ? d : 0);
      if (map.at(tx, ty) === Tile.Wall) map.set(tx, ty, Tile.Corridor);
    }
  }
}

// ----------------------------------------------------------------- modifiers

function pickModifier(req: FloorRequest): ModifierDef {
  if (isBossFloor(req.depth)) return NO_MODIFIER;

  const rng = floorRng(req.runSeed, req.depth, Stream.Modifier);
  if (!rng.chance(modifierChance(req.depth))) return NO_MODIFIER;

  // Never the same modifier within four floors. Without this, "Swarm" three
  // times in five floors reads as a broken generator rather than as variety.
  const banned = new Set(req.recentModifiers.slice(-4));
  const pool = MODIFIERS.filter((m) => !banned.has(m.id) && m.weight > 0);
  const usable = pool.length > 0 ? pool : MODIFIERS;
  return rng.weighted(usable.map((m) => ({ value: m, weight: m.weight })));
}

export { modifierById };
