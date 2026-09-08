import { TILE } from '../core/constants';
import type { Rng } from '../core/rng';
import type { BiomeDef, HazardBehavior } from '../content/types/biome';
import { Tint } from '../render/lighting';
import { Tile, Tilemap, WALKABLE } from '../world/tiles';
import { tileDistances } from './connectivity';
import type { EmitterRecord, Room } from './level';

/**
 * Hazard painting.
 *
 * Three hard rules, because a hazard that soft-locks a floor is far worse than
 * no hazard at all:
 *  1. Never within 5 tiles of either staircase.
 *  2. The exit must remain reachable with every path-blocking hazard treated as
 *     solid. If it isn't, punch a two-tile safe channel back through.
 *  3. Blobs, never speckle. A single hazard tile is invisible at speed; a blob
 *     is a piece of terrain you route around.
 */
export function placeHazards(
  rng: Rng,
  map: Tilemap,
  hazards: HazardBehavior[],
  density: number,
  entrance: { tx: number; ty: number },
  exit: { tx: number; ty: number },
): void {
  if (hazards.length === 0 || density <= 0) return;

  const walkable = map.countWalkable();
  let budget = Math.round(walkable * density);
  if (budget < 4) return;

  const safe = (tx: number, ty: number): boolean => {
    if (Math.abs(tx - entrance.tx) <= 5 && Math.abs(ty - entrance.ty) <= 5) return false;
    if (Math.abs(tx - exit.tx) <= 5 && Math.abs(ty - exit.ty) <= 5) return false;
    return true;
  };

  let guard = 0;
  while (budget > 0 && guard < 400) {
    guard++;
    const hazard = hazards[rng.pickIndex(hazards.length)];
    const blobSize = rng.int(hazard.blobTiles[0], hazard.blobTiles[1]);

    // Seed on plain floor, away from doorways so a threshold never becomes a
    // damage gate you cannot avoid.
    let sx = -1;
    let sy = -1;
    for (let attempt = 0; attempt < 50; attempt++) {
      const x = rng.int(2, map.w - 3);
      const y = rng.int(2, map.h - 3);
      const t = map.at(x, y);
      if (t !== Tile.Floor && t !== Tile.Corridor) continue;
      if (!safe(x, y)) continue;
      if (nearDoor(map, x, y)) continue;
      sx = x;
      sy = y;
      break;
    }
    if (sx < 0) continue;

    let x = sx;
    let y = sy;
    for (let i = 0; i < blobSize && budget > 0; i++) {
      const t = map.at(x, y);
      if ((t === Tile.Floor || t === Tile.Corridor) && safe(x, y) && !nearDoor(map, x, y)) {
        map.set(x, y, hazard.tile);
        budget--;
      }
      const dir = rng.int(0, 3);
      if (dir === 0) x++;
      else if (dir === 1) x--;
      else if (dir === 2) y++;
      else y--;
      x = Math.max(2, Math.min(map.w - 3, x));
      y = Math.max(2, Math.min(map.h - 3, y));
    }
  }

  if (hazards.some((h) => h.blocksPath)) {
    ensurePathClear(map, hazards, entrance, exit);
  }
}

function nearDoor(map: Tilemap, tx: number, ty: number): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const t = map.at(tx + dx, ty + dy);
      if (t === Tile.DoorOpen || t === Tile.DoorSealed || t === Tile.StairsDown ||
          t === Tile.StairsUp) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Verify reachability with blocking hazards treated as solid; if the exit is
 * cut off, clear a two-tile channel along the hazard-agnostic shortest path.
 */
function ensurePathClear(
  map: Tilemap,
  hazards: HazardBehavior[],
  entrance: { tx: number; ty: number },
  exit: { tx: number; ty: number },
): void {
  const blockingTiles = new Set<number>(
    hazards.filter((h) => h.blocksPath).map((h) => h.tile as number),
  );
  if (blockingTiles.size === 0) return;

  // Temporarily make blocking hazards non-walkable and re-run the BFS.
  const saved: number[] = [];
  for (const t of blockingTiles) {
    saved.push(t, WALKABLE[t]);
    WALKABLE[t] = 0;
  }
  const dist = tileDistances(map, entrance.tx, entrance.ty);
  const reachable = dist[exit.ty * map.w + exit.tx] >= 0;
  for (let i = 0; i < saved.length; i += 2) WALKABLE[saved[i]] = saved[i + 1];

  if (reachable) return;

  // Walk the hazard-agnostic path and clear a channel two tiles wide.
  const openDist = tileDistances(map, exit.tx, exit.ty);
  let x = entrance.tx;
  let y = entrance.ty;
  for (let step = 0; step < map.w * map.h; step++) {
    if (x === exit.tx && y === exit.ty) break;
    const here = openDist[y * map.w + x];
    if (here <= 0) break;
    let nx = x;
    let ny = y;
    let bestD = here;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const d = openDist[(y + dy) * map.w + (x + dx)];
      if (d >= 0 && d < bestD) {
        bestD = d;
        nx = x + dx;
        ny = y + dy;
      }
    }
    if (nx === x && ny === y) break;
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1]]) {
      const t = map.at(x + dx, y + dy);
      if (blockingTiles.has(t)) map.set(x + dx, y + dy, Tile.Floor);
    }
    x = nx;
    y = ny;
  }
}

/**
 * Torches.
 *
 * These are the only reliable long-range visual landmark in a dark dungeon, so
 * every room gets at least one and corridors get one every fourteen tiles.
 * Without that, navigating a 100x100 level by torchlight is genuinely
 * unpleasant.
 */
export function placeEmitters(
  rng: Rng,
  map: Tilemap,
  rooms: Room[],
  biome: BiomeDef,
  exit: { tx: number; ty: number },
): EmitterRecord[] {
  const out: EmitterRecord[] = [];
  const tint = biome.wallStyle === 'organic' ? Tint.Purple : Tint.Warm;
  const radius = biome.palette.lightRadius;

  const push = (tx: number, ty: number, r: number, tn: number, flickers: boolean): void => {
    out.push({
      x: tx * TILE + TILE * 0.5,
      y: ty * TILE + TILE * 0.5,
      radius: r,
      tint: tn,
      flickers,
    });
  };

  // Room torches: mounted on wall tiles that face the room interior.
  for (const r of rooms) {
    const spots: Array<[number, number]> = [];
    for (let tx = r.x; tx < r.x + r.w; tx++) {
      if (map.isSolid(tx, r.y - 1)) spots.push([tx, r.y]);
      if (map.isSolid(tx, r.y + r.h)) spots.push([tx, r.y + r.h - 1]);
    }
    for (let ty = r.y; ty < r.y + r.h; ty++) {
      if (map.isSolid(r.x - 1, ty)) spots.push([r.x, ty]);
      if (map.isSolid(r.x + r.w, ty)) spots.push([r.x + r.w - 1, ty]);
    }
    if (spots.length === 0) {
      push(r.cx, r.cy, radius * 0.8, tint, true);
      continue;
    }
    rng.shuffle(spots);
    const count = Math.max(1, Math.round(spots.length / 7));
    for (let i = 0; i < count && i < spots.length; i++) {
      const [tx, ty] = spots[i];
      if (!map.isWalkable(tx, ty)) continue;
      push(tx, ty, radius * rng.float(0.85, 1.05), tint, true);
    }
  }

  // Corridor torches, so the connective tissue is not pitch black.
  let sinceLast = 0;
  for (let ty = 1; ty < map.h - 1; ty++) {
    for (let tx = 1; tx < map.w - 1; tx++) {
      if (map.at(tx, ty) !== Tile.Corridor) continue;
      sinceLast++;
      if (sinceLast < 14) continue;
      sinceLast = 0;
      push(tx, ty, radius * 0.6, tint, true);
    }
  }

  // Cold steady glow on the exit. This is a pure usability light: without it,
  // finding the stairs in a large dark cave is tedious rather than tense.
  push(exit.tx, exit.ty, radius * 0.75, Tint.Cold, false);

  return out;
}

/** Special rooms get their own accent light so they read from the doorway. */
export function accentSpecialRooms(rooms: Room[], out: EmitterRecord[]): void {
  for (const r of rooms) {
    let tint = -1;
    switch (r.kind) {
      case 'treasure':
        tint = Tint.White;
        break;
      case 'shrine':
        tint = Tint.Cold;
        break;
      case 'elite':
        tint = Tint.Red;
        break;
      case 'shop':
        tint = Tint.Green;
        break;
      default:
        tint = -1;
    }
    if (tint < 0) continue;
    out.push({
      x: r.cx * TILE + TILE * 0.5,
      y: r.cy * TILE + TILE * 0.5,
      radius: 150,
      tint,
      flickers: false,
    });
  }
}
