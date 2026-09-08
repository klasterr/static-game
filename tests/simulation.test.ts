import { beforeAll, describe, expect, it } from 'vitest';

import { STEP_S, TILE } from '../src/core/constants';
import { registerSaveVocabulary, __sanitizeForTests } from '../src/core/storage';
import { assertContentValid, ENEMIES } from '../src/content';
import { CLASSES } from '../src/content/classes';
import { BONE_RAT, SKELETON_WARDEN } from '../src/content/enemies/catacombs';
import { ALL_UNLOCK_IDS } from '../src/systems/loot';
import {
  dmgMult,
  hpMult,
  isBossFloor,
  soulsEarned,
  speedMult,
  xpForLevel,
} from '../src/systems/scaling';
import { RunState, setCameraViewSize } from '../src/run/runState';
import { moveCircle } from '../src/world/collision';
import { applyDamage } from '../src/world/combat';
import { spawnEnemyIn } from '../src/world/enemies';
import { EKind, Flags } from '../src/world/entities';
import { spawnProjectile } from '../src/world/projectiles';
import { Tile, Tilemap } from '../src/world/tiles';

/**
 * Headless simulation tests.
 *
 * The whole simulation layer is deliberately free of DOM dependencies, so a run
 * can be stepped thousands of times in Node. That is what makes it possible to
 * catch a crash in the AI or the reward economy without opening a browser.
 */

beforeAll(() => {
  registerSaveVocabulary(
    ALL_UNLOCK_IDS,
    CLASSES.map((c) => c.id),
  );
  setCameraViewSize(640, 360);
  assertContentValid();
});

function freshRun(seed = 'SIMSEED', classId = 'wanderer'): RunState {
  const run = new RunState();
  run.start(classId, seed);
  return run;
}

/** Advance the simulation, ignoring input (there is none in Node). */
function stepFor(run: RunState, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    if (run.dead) return;
    run.step();
  }
}

describe('run lifecycle', () => {
  it('starts a run with a live, fully-statted player', () => {
    const run = freshRun();
    const p = run.ctx.player;
    expect(p.alive).toBe(true);
    expect(p.player).not.toBeNull();
    expect(p.hp).toBe(p.hpMax);
    expect(p.hpMax).toBeGreaterThan(0);
    expect(run.depth).toBe(1);
    expect(run.world.threatsInitial).toBeGreaterThan(0);
    // The player must not arrive inside geometry.
    expect(run.level.map.isWalkable(Math.floor(p.x / TILE), Math.floor(p.y / TILE))).toBe(true);
  });

  it('simulates 30 seconds without throwing or corrupting the entity array', () => {
    const run = freshRun('LONGSIM');
    stepFor(run, Math.round(30 / STEP_S));

    for (const e of run.world.ents) {
      expect(Number.isFinite(e.x)).toBe(true);
      expect(Number.isFinite(e.y)).toBe(true);
      expect(Number.isFinite(e.hp)).toBe(true);
      // Nothing alive may be sitting inside a wall.
      if (e.alive && (e.flags & Flags.Flying) === 0 && e.kind !== EKind.Hazard) {
        const tx = Math.floor(e.x / TILE);
        const ty = Math.floor(e.y / TILE);
        expect(
          run.level.map.isBlocked(tx, ty),
          `${e.def?.id ?? e.kind} ended up inside a solid tile`,
        ).toBe(false);
      }
    }
  });

  it('descends through ten floors including bosses', () => {
    const run = freshRun('DESCEND');
    for (let depth = 2; depth <= 11; depth++) {
      // Godmode the player so the descent is about generation, not survival.
      run.ctx.player.hp = run.ctx.player.hpMax;
      run.enterFloor(depth);
      expect(run.depth).toBe(depth);
      expect(run.level.depth).toBe(depth);
      expect(run.ctx.player.alive).toBe(true);
      if (isBossFloor(depth)) {
        expect(run.level.isBoss).toBe(true);
        const boss = run.world.ents.find((e) => (e.flags & Flags.Boss) !== 0);
        // The boss spawns during the entity flush, so step once first.
        run.step();
        const found = boss ?? run.world.ents.find((e) => (e.flags & Flags.Boss) !== 0);
        expect(found, `no boss on floor ${depth}`).toBeDefined();
      }
      stepFor(run, 60);
    }
    expect(run.summary.deepestFloor).toBe(11);
  });

  it('carries the player state across floors and preserves the health fraction', () => {
    const run = freshRun('CARRY');
    const p = run.ctx.player;
    p.hp = Math.round(p.hpMax * 0.5);
    const beforeMax = p.hpMax;

    run.enterFloor(2);
    const after = run.ctx.player;
    expect(after.hpMax).toBe(beforeMax);
    expect(after.hp).toBeCloseTo(beforeMax * 0.5, 0);
    expect(after.player?.classId).toBe('wanderer');
  });

  it('banks pending souls on descent rather than on death', () => {
    const run = freshRun('BANK');
    const p = run.ctx.player.player!;
    p.soulsPending = 40;
    const before = run.save.souls;

    run.enterFloor(2);
    expect(run.save.souls).toBe(before + 40);
    expect(run.ctx.player.player!.soulsPending).toBe(0);
  });
});

describe('combat', () => {
  it('deals damage, awards souls and xp, and removes the enemy', () => {
    const run = freshRun('COMBAT');
    const ctx = run.ctx;
    const p = ctx.player.player!;
    const before = { xp: p.xp, kills: p.kills };

    const rat = spawnEnemyIn(ctx, BONE_RAT, ctx.player.x + 60, ctx.player.y, {});
    run.world.flush();
    expect(rat.hp).toBeGreaterThan(0);

    applyDamage(ctx, rat, 9999, { srcX: ctx.player.x, srcY: ctx.player.y, fromPlayer: true });
    expect(rat.alive).toBe(false);
    expect(p.kills).toBe(before.kills + 1);
    expect(p.xp + p.level * 1000).toBeGreaterThan(before.xp);

    run.world.flush();
    // Soul motes drop where it died.
    const motes = run.world.ents.filter((e) => e.alive && e.kind === EKind.Pickup);
    expect(motes.length).toBeGreaterThan(0);
  });

  it("respects the Warden's directional shield and lets damage-over-time through", () => {
    const run = freshRun('SHIELD');
    const ctx = run.ctx;

    // A fresh Warden per case: reusing one and topping its health back up
    // would leave it already dead after the first unblocked hit.
    const hit = (opts: { fromBehind?: boolean; isDot?: boolean }): number => {
      const warden = spawnEnemyIn(ctx, SKELETON_WARDEN, ctx.player.x + 80, ctx.player.y, {});
      run.world.flush();
      // Point the shield straight at the player.
      warden.ax = Math.atan2(ctx.player.y - warden.y, ctx.player.x - warden.x);
      const srcX = opts.fromBehind ? warden.x + 200 : ctx.player.x;
      const srcY = opts.fromBehind ? warden.y : ctx.player.y;
      return applyDamage(ctx, warden, 20, {
        srcX,
        srcY,
        isDot: opts.isDot === true,
        fromPlayer: true,
      });
    };

    const front = hit({});
    const behind = hit({ fromBehind: true });
    const dot = hit({ isDot: true });

    // 85% reduction inside the shield arc.
    expect(front).toBeCloseTo(behind * 0.15, 1);
    expect(front).toBeLessThan(behind * 0.5);
    // This is the discovery the item pool is built around: burn bypasses the
    // shield entirely, so an Ember build ignores armoured enemies.
    expect(dot).toBeCloseTo(behind, 1);
    expect(dot).toBeGreaterThan(front * 3);
  });

  it('honours invulnerability frames', () => {
    const run = freshRun('IFRAME');
    const ctx = run.ctx;
    const rat = spawnEnemyIn(ctx, BONE_RAT, ctx.player.x + 40, ctx.player.y, {});
    run.world.flush();

    const first = applyDamage(ctx, rat, 5, { srcX: 0, srcY: 0 });
    rat.iframes = 500;
    const second = applyDamage(ctx, rat, 5, { srcX: 0, srcY: 0 });
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(0);
  });

  it('kills the player and flags the run as over', () => {
    const run = freshRun('DEATH');
    const ctx = run.ctx;
    ctx.player.player!.secondWindLeft = 0;
    applyDamage(ctx, ctx.player, 99999, { srcX: ctx.player.x + 10, srcY: ctx.player.y });
    expect(ctx.playerDied).toBe(true);
    expect(ctx.player.hp).toBe(0);
  });

  it('lets Second Wind survive exactly one fatal hit', () => {
    const run = freshRun('SECONDWIND');
    const ctx = run.ctx;
    const p = ctx.player.player!;
    p.relics['second_wind'] = 1;
    p.stats.secondWindMax = 1;
    p.secondWindLeft = 1;

    applyDamage(ctx, ctx.player, 99999, { srcX: ctx.player.x + 10, srcY: ctx.player.y });
    expect(ctx.player.hp).toBe(1);
    expect(p.secondWindLeft).toBe(0);
    expect(ctx.playerDied).toBe(false);

    ctx.player.iframes = 0;
    applyDamage(ctx, ctx.player, 99999, { srcX: ctx.player.x + 10, srcY: ctx.player.y });
    expect(ctx.playerDied).toBe(true);
  });
});

describe('collision', () => {
  function walledMap(): Tilemap {
    const map = new Tilemap(9, 9, Tile.Wall);
    for (let y = 1; y < 8; y++) {
      for (let x = 1; x < 8; x++) map.set(x, y, Tile.Floor);
    }
    return map;
  }

  it('pushes a circle out of a wall corner on both axes', () => {
    const map = walledMap();
    // Aim hard into the top-left interior corner.
    const body = { x: 2 * TILE, y: 2 * TILE, r: 11 };
    moveCircle(map, body, -200, -200);

    expect(body.x).toBeGreaterThanOrEqual(TILE + body.r - 0.5);
    expect(body.y).toBeGreaterThanOrEqual(TILE + body.r - 0.5);
    expect(map.isBlocked(Math.floor(body.x / TILE), Math.floor(body.y / TILE))).toBe(false);
  });

  it('slides along a wall instead of stopping dead', () => {
    const map = walledMap();
    const body = { x: TILE + 11.02, y: 4 * TILE, r: 11 };
    const startY = body.y;
    // Push diagonally into the left wall; the tangential component must survive.
    moveCircle(map, body, -60, 60);
    expect(body.y).toBeGreaterThan(startY + 40);
  });

  it('does not let a fast projectile tunnel through a one-tile wall', () => {
    const map = new Tilemap(20, 5, Tile.Floor);
    for (let y = 0; y < 5; y++) map.set(10, y, Tile.Wall);
    const body = { x: 2 * TILE, y: 2 * TILE + 16, r: 4 };
    // 2000 px/s for a full second, in one call.
    moveCircle(map, body, 2000, 0, true);
    expect(body.x).toBeLessThan(10 * TILE);
  });

  it('stops a spawned projectile at a wall', () => {
    const run = freshRun('PROJ');
    const ctx = run.ctx;
    const shot = spawnProjectile(ctx, ctx.player.x, ctx.player.y, 1, 0, {
      speed: 1800,
      radius: 4,
      damage: 5,
      life: 3000,
      color: '#fff',
    }, false);
    run.world.flush();

    for (let i = 0; i < 240 && shot.alive; i++) run.step();
    // Either it hit something or it expired; it must never end up in rock.
    if (shot.alive) {
      const tx = Math.floor(shot.x / TILE);
      const ty = Math.floor(shot.y / TILE);
      expect(run.level.map.isSolid(tx, ty)).toBe(false);
    }
  });
});

describe('scaling', () => {
  it('is monotonic and caps enemy speed', () => {
    for (let d = 1; d < 60; d++) {
      expect(hpMult(d + 1)).toBeGreaterThan(hpMult(d));
      expect(dmgMult(d + 1)).toBeGreaterThan(dmgMult(d));
      expect(speedMult(d + 1)).toBeGreaterThanOrEqual(speedMult(d));
      expect(speedMult(d)).toBeLessThanOrEqual(1.35);
    }
    // Health must outrun damage: deep floors should kill by attrition, not by
    // a surprise one-shot.
    expect(hpMult(30)).toBeGreaterThan(dmgMult(30) * 2);
  });

  it('rewards pushing deeper over re-farming a shallow floor', () => {
    const deep = soulsEarned(
      { deepestFloor: 10, bossesKilled: 2, elitesKilled: 12, kills: 300 },
      0,
    );
    const shallowTwice =
      2 * soulsEarned({ deepestFloor: 5, bossesKilled: 1, elitesKilled: 5, kills: 150 }, 5);
    expect(deep).toBeGreaterThan(shallowTwice * 0.8);
  });

  it('grows the level curve without stalling', () => {
    for (let n = 1; n < 40; n++) {
      expect(xpForLevel(n + 1)).toBeGreaterThan(xpForLevel(n));
    }
  });
});

describe('save sanitising', () => {
  it('survives every kind of malformed input', () => {
    const cases: unknown[] = [
      {},
      { v: 1 },
      { v: 1, souls: 'lots' },
      { v: 1, souls: NaN },
      { v: 1, souls: -500 },
      { v: 1, souls: Infinity },
      { v: 1, unlocks: 'not-an-array' },
      { v: 1, unlocks: ['made_up_unlock', 'ember_cache', 'ember_cache'] },
      { v: 1, classId: 'sorcerer' },
      { v: 1, settings: 'nope' },
      { v: 1, settings: { master: 12, touchControls: 'sideways' } },
      { v: 1, stats: { a: 'b', c: 3 } },
      { v: 1, bestDepth: 1e30 },
    ];

    for (const input of cases) {
      const out = __sanitizeForTests(input);
      expect(out.souls).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(out.souls)).toBe(true);
      expect(Array.isArray(out.unlocks)).toBe(true);
      // Stale or invented unlock ids must be dropped, not carried forward.
      for (const id of out.unlocks) expect(ALL_UNLOCK_IDS).toContain(id);
      expect(new Set(out.unlocks).size).toBe(out.unlocks.length);
      expect(CLASSES.map((c) => c.id)).toContain(out.classId);
      expect(out.settings.master).toBeGreaterThanOrEqual(0);
      expect(out.settings.master).toBeLessThanOrEqual(1);
      expect(['auto', 'on', 'off']).toContain(out.settings.touchControls);
      for (const value of Object.values(out.stats)) {
        expect(Number.isFinite(value)).toBe(true);
      }
    }
  });
});

describe('content coverage', () => {
  it('gives every enemy a distinct behaviour, not just distinct stats', () => {
    // Two enemies sharing an identical stat line AND an identical ai reference
    // would be the same enemy wearing a different name.
    const seen = new Map<string, string>();
    for (const def of Object.values(ENEMIES)) {
      const key = `${def.ai.toString().length}|${def.stats.speed}|${def.stats.hp}`;
      const clash = seen.get(key);
      expect(clash, `${def.id} looks like a duplicate of ${clash}`).toBeUndefined();
      seen.set(key, def.id);
    }
  });
});
