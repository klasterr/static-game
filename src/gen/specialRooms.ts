import type { Rng } from '../core/rng';
import { Tile, Tilemap } from '../world/tiles';
import { tileDistances } from './connectivity';
import { roomArea, type Room, type RoomKind } from './level';

export interface StairChoice {
  entrance: Room;
  exit: Room;
  /** Tile distance along walkable space. */
  pathLength: number;
}

/**
 * Pick the entrance/exit pair maximising walkable distance.
 *
 * All-pairs BFS is trivially cheap here (at most ~22 rooms), and using true
 * walkable distance rather than Euclidean matters: two rooms can be close on
 * the map but a long way apart through the corridors, which is exactly the
 * layout you want for a long main path.
 */
export function pickStairs(map: Tilemap, rooms: Room[]): StairChoice | null {
  if (rooms.length < 2) return null;

  let best: StairChoice | null = null;
  for (let i = 0; i < rooms.length; i++) {
    const a = rooms[i];
    if (!map.isWalkable(a.cx, a.cy)) continue;
    const dist = tileDistances(map, a.cx, a.cy);
    for (let j = 0; j < rooms.length; j++) {
      if (i === j) continue;
      const b = rooms[j];
      const d = dist[b.cy * map.w + b.cx];
      if (d < 0) continue;
      if (!best || d > best.pathLength) {
        best = { entrance: a, exit: b, pathLength: d };
      }
    }
  }
  return best;
}

/** Clear a walkable 3x3 so stairs and the arrival point are never cramped. */
export function clearPad(map: Tilemap, tx: number, ty: number, radius = 1): void {
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = tx + dx;
      const y = ty + dy;
      if (x < 1 || y < 1 || x >= map.w - 1 || y >= map.h - 1) continue;
      if (map.at(x, y) === Tile.Void) continue;
      if (!map.isWalkable(x, y)) map.set(x, y, Tile.Floor);
    }
  }
}

export interface AssignOptions {
  depth: number;
  /** Shops are guaranteed on floor 1 so the economy is legible immediately. */
  guaranteeShop: boolean;
}

/**
 * Assign special room kinds in priority order, each consuming a room.
 *
 * Degree-1 rooms (cul-de-sacs) are preferred for anything worth a detour:
 * putting the vault off the main path is what makes exploring a decision
 * rather than a formality.
 */
export function assignSpecialRooms(
  rng: Rng,
  map: Tilemap,
  rooms: Room[],
  entrance: Room,
  exit: Room,
  mainPath: number,
  opts: AssignOptions,
): void {
  entrance.kind = 'entrance';
  exit.kind = 'exit';

  const fromEntrance = tileDistances(map, entrance.cx, entrance.cy);
  const fromExit = tileDistances(map, exit.cx, exit.cy);

  let maxDist = 1;
  for (const r of rooms) {
    const d = fromEntrance[r.cy * map.w + r.cx];
    r.distFromEntrance = d < 0 ? 0 : d;
    if (r.distFromEntrance > maxDist) maxDist = r.distFromEntrance;
  }

  const onMainPath = (r: Room): boolean => {
    const a = fromEntrance[r.cy * map.w + r.cx];
    const b = fromExit[r.cy * map.w + r.cx];
    if (a < 0 || b < 0) return true;
    return a + b <= mainPath * 1.15;
  };

  const available = rooms.filter((r) => r.kind === 'normal');
  const claim = (room: Room | undefined, kind: RoomKind): void => {
    if (!room) return;
    room.kind = kind;
    const i = available.indexOf(room);
    if (i >= 0) available.splice(i, 1);
  };

  // Elite: biggest cul-de-sac, else the biggest room off the main path, else
  // just the biggest. An elite fight wants space.
  const eliteCandidates = available.filter((r) => r.degree <= 1);
  const elitePool = eliteCandidates.length > 0
    ? eliteCandidates
    : available.filter((r) => !onMainPath(r));
  const eliteRoom = biggest(elitePool.length > 0 ? elitePool : available);
  claim(eliteRoom, 'elite');

  // Treasure vault: the furthest cul-de-sac. Maximum reward for maximum detour.
  const vaultPool = available.filter((r) => r.degree <= 1);
  const vault = furthest(vaultPool.length > 0 ? vaultPool : available);
  claim(vault, 'treasure');

  // Shrine: a cul-de-sac at middling distance, so the choice arrives mid-floor
  // while you still have decisions left to make.
  const shrinePool = available.filter(
    (r) => r.distFromEntrance >= maxDist * 0.3 && r.distFromEntrance <= maxDist * 0.75,
  );
  const shrine = pickOne(rng, shrinePool.length > 0 ? shrinePool : available);
  claim(shrine, 'shrine');

  // Shop: nearest cul-de-sac. You want to SEE the shop early, so you can decide
  // whether it is worth farming for coin before you descend.
  if (opts.guaranteeShop || rng.chance(0.6)) {
    const shopPool = available.filter((r) => r.degree <= 1);
    const shop = nearest(shopPool.length > 0 ? shopPool : available);
    claim(shop, 'shop');
  }
}

function biggest(pool: Room[]): Room | undefined {
  let best: Room | undefined;
  for (const r of pool) {
    if (!best || roomArea(r) > roomArea(best)) best = r;
  }
  return best;
}

function furthest(pool: Room[]): Room | undefined {
  let best: Room | undefined;
  for (const r of pool) {
    if (!best || r.distFromEntrance > best.distFromEntrance) best = r;
  }
  return best;
}

function nearest(pool: Room[]): Room | undefined {
  let best: Room | undefined;
  for (const r of pool) {
    if (!best || r.distFromEntrance < best.distFromEntrance) best = r;
  }
  return best;
}

function pickOne(rng: Rng, pool: Room[]): Room | undefined {
  if (pool.length === 0) return undefined;
  return pool[rng.pickIndex(pool.length)];
}
