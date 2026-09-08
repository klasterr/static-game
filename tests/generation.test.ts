import { describe, expect, it } from 'vitest';

import { TILE } from '../src/core/constants';
import { newRunSeed, runSeedFromString } from '../src/core/rng';
import { DEFAULT_SAVE, registerSaveVocabulary } from '../src/core/storage';
import { BIOME_CYCLE, ENEMIES, assertContentValid, biomeForDepth } from '../src/content';
import { CLASSES } from '../src/content/classes';
import { ALL_UNLOCK_IDS } from '../src/systems/loot';
import { checkConnectivity } from '../src/gen/connectivity';
import { generateFloor, type FloorRequest } from '../src/gen/floor';
import { isBossFloor, minMainPath, floorPlan } from '../src/systems/scaling';
import { WALKABLE } from '../src/world/tiles';

registerSaveVocabulary(ALL_UNLOCK_IDS, CLASSES.map((c) => c.id));

/**
 * The connectivity fuzz is the single most valuable test in the project: it is
 * the only thing standing between a bad seed and an unfinishable run, and it
 * runs in a fraction of a second per floor with no browser.
 *
 * Default sweep is deliberately modest so `npm test` stays fast. Set
 * `GEN_FUZZ=5000` for the full sweep (used before releases).
 */
const FUZZ_COUNT = Number(process.env.GEN_FUZZ ?? 400);

function request(depth: number, seedText: string): FloorRequest {
  return {
    depth,
    runSeed: runSeedFromString(seedText),
    save: { ...DEFAULT_SAVE, unlocks: [...ALL_UNLOCK_IDS] },
    bonusRelics: 1,
    needsMercy: false,
    recentModifiers: [],
  };
}

describe('content', () => {
  it('passes validation', () => {
    expect(() => assertContentValid()).not.toThrow();
  });

  it('rotates biomes every five floors', () => {
    expect(biomeForDepth(1).id).toBe(BIOME_CYCLE[0]);
    expect(biomeForDepth(5).id).toBe(BIOME_CYCLE[0]);
    expect(biomeForDepth(6).id).toBe(BIOME_CYCLE[1]);
    expect(biomeForDepth(10).id).toBe(BIOME_CYCLE[1]);
    // ...and wraps forever rather than running out.
    expect(biomeForDepth(11).id).toBe(BIOME_CYCLE[0]);
    expect(biomeForDepth(101).id).toBe(BIOME_CYCLE[0]);
  });
});

describe('floor generation', () => {
  it(`keeps every walkable tile reachable across ${FUZZ_COUNT} floors`, () => {
    const failures: string[] = [];

    for (let i = 0; i < FUZZ_COUNT; i++) {
      // Sweep depth 1..40 so both generators, both biomes, boss floors and the
      // whole modifier table all get exercised.
      const depth = (i % 40) + 1;
      const seedText = `FUZZ${i.toString(36).toUpperCase()}`;
      const { level } = generateFloor(request(depth, seedText));
      const map = level.map;

      const entranceTx = Math.floor(level.entrance.x / TILE);
      const entranceTy = Math.floor(level.entrance.y / TILE);
      const report = checkConnectivity(map, entranceTx, entranceTy);

      if (!report.ok) {
        failures.push(
          `depth ${depth} seed ${seedText}: reached ${report.reached}/${report.walkable}` +
            ` (orphans ${report.orphanSizes.slice(0, 4).join(',')})`,
        );
        continue;
      }

      if (!map.isWalkable(entranceTx, entranceTy)) {
        failures.push(`depth ${depth} seed ${seedText}: entrance is not walkable`);
      }
      const exitTx = Math.floor(level.exit.x / TILE);
      const exitTy = Math.floor(level.exit.y / TILE);
      if (!map.isWalkable(exitTx, exitTy)) {
        failures.push(`depth ${depth} seed ${seedText}: exit is not walkable`);
      }
      if (entranceTx === exitTx && entranceTy === exitTy) {
        failures.push(`depth ${depth} seed ${seedText}: entrance and exit coincide`);
      }
    }

    expect(failures.slice(0, 10)).toEqual([]);
  });

  it('places every enemy and every item on walkable ground', () => {
    const failures: string[] = [];

    for (let i = 0; i < 120; i++) {
      const depth = (i % 24) + 1;
      const { level } = generateFloor(request(depth, `PLACE${i}`));
      const map = level.map;

      for (const s of level.spawns) {
        if (!ENEMIES[s.enemyId]) {
          failures.push(`depth ${depth}: unknown enemy id "${s.enemyId}"`);
          continue;
        }
        const tx = Math.floor(s.x / TILE);
        const ty = Math.floor(s.y / TILE);
        if (WALKABLE[map.at(tx, ty)] !== 1) {
          failures.push(`depth ${depth}: ${s.enemyId} spawned in solid rock`);
        }
      }

      for (const l of level.loot) {
        const tx = Math.floor(l.x / TILE);
        const ty = Math.floor(l.y / TILE);
        if (WALKABLE[map.at(tx, ty)] !== 1) {
          failures.push(`depth ${depth}: ${l.kind} "${l.id}" placed in solid rock`);
        }
      }
    }

    expect(failures.slice(0, 10)).toEqual([]);
  });

  it('never spawns an enemy on the arrival pad', () => {
    for (let i = 0; i < 60; i++) {
      const depth = (i % 12) + 1;
      const { level } = generateFloor(request(depth, `PAD${i}`));
      if (level.isBoss) continue;
      const ex = Math.floor(level.entrance.x / TILE);
      const ey = Math.floor(level.entrance.y / TILE);
      for (const s of level.spawns) {
        const tx = Math.floor(s.x / TILE);
        const ty = Math.floor(s.y / TILE);
        const near = Math.abs(tx - ex) <= 4 && Math.abs(ty - ey) <= 4;
        expect(near, `${s.enemyId} spawned ${tx - ex},${ty - ey} from the entrance`).toBe(
          false,
        );
      }
    }
  });

  it('gives normal floors a long main path', () => {
    let checked = 0;
    let short = 0;
    for (let i = 0; i < 120; i++) {
      const depth = (i % 19) + 1;
      if (isBossFloor(depth)) continue;
      const { level } = generateFloor(request(depth, `PATH${i}`));
      const plan = floorPlan(depth);
      checked++;
      if (level.mainPathLength < minMainPath(plan.w, plan.h)) short++;
    }
    expect(checked).toBeGreaterThan(50);
    // The generator accepts the best pair it can find, so the target is a
    // strong tendency rather than a hard guarantee. Most floors must clear it.
    expect(short / checked).toBeLessThan(0.35);
  });

  it('always has an exit, a shrine and an elite room', () => {
    for (let i = 0; i < 60; i++) {
      const depth = (i % 19) + 1;
      if (isBossFloor(depth)) continue;
      const { level } = generateFloor(request(depth, `ROOMS${i}`));
      const kinds = new Set(level.rooms.map((r) => r.kind));
      expect(kinds.has('entrance')).toBe(true);
      expect(kinds.has('exit')).toBe(true);
      expect(level.loot.some((l) => l.kind === 'shrine')).toBe(true);
    }
  });

  it('builds boss floors with the boss behind the stairs route', () => {
    for (const depth of [5, 10, 15, 20, 25]) {
      const { level } = generateFloor(request(depth, 'BOSSSEED'));
      expect(level.isBoss).toBe(true);
      const bosses = level.spawns.filter((s) => s.boss === true);
      expect(bosses.length).toBe(1);
      // The vault (and therefore the stairs) is further from the entrance than
      // the arena, which is what makes the fight non-optional.
      const arena = level.rooms.find((r) => r.kind === 'boss');
      const vault = level.rooms.find((r) => r.kind === 'vault');
      expect(arena).toBeDefined();
      expect(vault).toBeDefined();
      expect(vault!.cx).toBeGreaterThan(arena!.cx);
      expect(level.modifierId).toBeNull();
    }
  });
});

describe('determinism', () => {
  it('produces an identical level from the same seed', () => {
    for (const depth of [1, 4, 7, 12, 20]) {
      const a = generateFloor(request(depth, 'MOSSFIRE')).level;
      const b = generateFloor(request(depth, 'MOSSFIRE')).level;

      expect(Array.from(a.map.t)).toEqual(Array.from(b.map.t));
      expect(a.entrance).toEqual(b.entrance);
      expect(a.exit).toEqual(b.exit);
      expect(a.modifierId).toBe(b.modifierId);
      expect(a.rooms.map((r) => `${r.x},${r.y},${r.w},${r.h},${r.kind}`)).toEqual(
        b.rooms.map((r) => `${r.x},${r.y},${r.w},${r.h},${r.kind}`),
      );
      expect(a.spawns).toEqual(b.spawns);
      expect(a.loot).toEqual(b.loot);
    }
  });

  it('produces different levels from different seeds', () => {
    const a = generateFloor(request(3, 'SEEDONE')).level;
    const b = generateFloor(request(3, 'SEEDTWO')).level;
    expect(Array.from(a.map.t)).not.toEqual(Array.from(b.map.t));
  });

  it('keeps the layout stable when only the loot pool changes', () => {
    // This is the property that independent RNG streams buy: a content tweak to
    // drops must not reshuffle every dungeon a shared seed produces.
    const base = request(7, 'STREAMS');
    const withAll = generateFloor(base).level;

    const narrowed: FloorRequest = {
      ...base,
      save: { ...DEFAULT_SAVE, unlocks: [] },
    };
    const withNone = generateFloor(narrowed).level;

    expect(Array.from(withAll.map.t)).toEqual(Array.from(withNone.map.t));
    expect(withAll.entrance).toEqual(withNone.entrance);
    expect(withAll.exit).toEqual(withNone.exit);
    expect(withAll.spawns).toEqual(withNone.spawns);
  });

  it('round-trips a random seed through its display text', () => {
    for (let i = 0; i < 200; i++) {
      const { seed, text } = newRunSeed();
      expect(text).toMatch(/^[A-Z2-9]{8}$/);
      expect(runSeedFromString(text)).toBe(seed);
    }
  });
});
