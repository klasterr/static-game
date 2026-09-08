import { TILE } from '../core/constants';
import type { Rng } from '../core/rng';
import { ENEMIES } from '../content';
import { DEPTH_WRAITH } from '../content/enemies/bosses';
import type { BiomeDef } from '../content/types/biome';
import type { GameCtx } from '../world/ctx';
import { spawnEnemyIn } from '../world/enemies';
import { Tile } from '../world/tiles';
import type { Level, Room } from '../gen/level';
import { liveEnemyCap, trickleInterval } from './scaling';

/**
 * Floor pacing.
 *
 * A four-minute, hundred-by-hundred floor has one dominant failure mode: you
 * clear the left half, and then walk through an empty museum. Three devices fix
 * that, and all three ship in v1 because without them the "endless but not
 * monotonous" goal simply fails.
 *
 *  1. Trickle spawning, only into rooms you have ALREADY visited. This converts
 *     backtracking from dead time into running combat.
 *  2. The Depth Wraith at six minutes — a clock, not a fight. It stops a big
 *     floor being farmed and gives a long floor a rising third act.
 *  3. Optional descent (handled in the play scene): the stairs work the moment
 *     you find them, so the player authors their own floor length.
 */

export interface TrickleState {
  /** Seconds until the next trickle spawn. */
  timer: number;
  /** Milliseconds spent on this floor. */
  elapsedMs: number;
  wraithSpawned: boolean;
  spawned: number;
}

export const WRAITH_AFTER_MS = 6 * 60 * 1000;

export function blankTrickleState(depth: number): TrickleState {
  return {
    // A grace period on arrival: the first trickle is a full interval away, so
    // stepping onto a new floor is never immediately noisy.
    timer: trickleInterval(depth) * 1.5,
    elapsedMs: 0,
    wraithSpawned: false,
    spawned: 0,
  };
}

export function updateTrickle(
  ctx: GameCtx,
  state: TrickleState,
  level: Level,
  biome: BiomeDef,
  rng: Rng,
  dt: number,
): void {
  state.elapsedMs += dt * 1000;

  if (!state.wraithSpawned && state.elapsedMs > WRAITH_AFTER_MS && !level.isBoss) {
    spawnWraith(ctx, level);
    state.wraithSpawned = true;
  }

  // Boss floors are their own pacing structure; do not add pressure to them.
  if (level.isBoss) return;

  // Above 85% cleared the floor is winding down. Let it.
  if (ctx.world.clearFraction() >= 0.85) return;
  if (ctx.world.liveThreats() >= liveEnemyCap(ctx.depth)) return;

  state.timer -= dt;
  if (state.timer > 0) return;
  state.timer = trickleInterval(ctx.depth);

  const room = pickVisitedRoom(level, ctx, rng);
  if (!room) return;

  const roster = biome.roster.filter(
    (w) => (w.minFloor ?? 1) <= ctx.depth && w.weight > 0 &&
      !ENEMIES[w.id]?.tags.includes('immobile'),
  );
  if (roster.length === 0) return;

  const entry = rng.weighted(roster.map((w) => ({ value: w, weight: w.weight })));
  const def = ENEMIES[entry.id];
  if (!def) return;

  const spot = findSpot(ctx, room, rng);
  if (!spot) return;

  // Marked as trickle: no loot roll and 40% experience. This is PRESSURE, not a
  // farm — otherwise the optimal play becomes standing in a cleared room
  // waiting for spawns, which is the exact opposite of the intent.
  spawnEnemyIn(ctx, def, spot.x, spot.y, { roomId: room.id, trickle: true });
  state.spawned++;
}

/**
 * Only rooms the player has already been in, and never the one they are
 * standing in. Spawning behind you is tension; spawning on top of you is
 * cheating.
 */
function pickVisitedRoom(level: Level, ctx: GameCtx, rng: Rng): Room | null {
  const px = Math.floor(ctx.player.x / TILE);
  const py = Math.floor(ctx.player.y / TILE);
  const currentRoom = level.roomAt[py * level.map.w + px];

  const candidates = level.rooms.filter(
    (r) => r.visited && r.id !== currentRoom && r.kind !== 'shop' && r.kind !== 'shrine',
  );
  if (candidates.length === 0) return null;
  return candidates[rng.pickIndex(candidates.length)];
}

function findSpot(ctx: GameCtx, room: Room, rng: Rng): { x: number; y: number } | null {
  const map = ctx.map;
  for (let attempt = 0; attempt < 24; attempt++) {
    const tx = rng.int(room.x + 1, room.x + room.w - 2);
    const ty = rng.int(room.y + 1, room.y + room.h - 2);
    if (!map.isWalkable(tx, ty)) continue;
    if (map.at(tx, ty) === Tile.HazardStatic) continue;
    const x = tx * TILE + TILE * 0.5;
    const y = ty * TILE + TILE * 0.5;
    // Never within a screen's reach of the player.
    const dx = x - ctx.player.x;
    const dy = y - ctx.player.y;
    if (dx * dx + dy * dy < 260 * 260) continue;
    return { x, y };
  }
  return null;
}

function spawnWraith(ctx: GameCtx, level: Level): void {
  // Arrives at the entrance, so it always has to come and find you.
  const e = spawnEnemyIn(ctx, DEPTH_WRAITH, level.entrance.x, level.entrance.y, {
    hpMult: 1,
    dmgMult: ctx.dmgMult,
    speedMult: 1,
  });
  e.dmg = 40 * ctx.dmgMult;
  ctx.fx.flash('#b46cf0', 0.32, 3);
  ctx.wraithWarning = 3200;
}

/** Mark rooms as visited. Drives both the trickle spawner and the minimap. */
export function updateVisitedRooms(ctx: GameCtx, level: Level): number {
  const tx = Math.floor(ctx.player.x / TILE);
  const ty = Math.floor(ctx.player.y / TILE);
  if (tx < 0 || ty < 0 || tx >= level.map.w || ty >= level.map.h) return -1;
  const id = level.roomAt[ty * level.map.w + tx];
  if (id >= 0 && id < level.rooms.length) level.rooms[id].visited = true;
  return id;
}
