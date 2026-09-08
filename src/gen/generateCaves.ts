import type { Rng } from '../core/rng';
import type { GeneratorConfig } from '../content/types/biome';
import { Tile, Tilemap, WALKABLE } from '../world/tiles';
import type { FloorPlan } from '../systems/scaling';
import { carveTunnel, closestPair, labelRegions } from './connectivity';
import { detectChambers } from './distanceField';
import { fillVoid } from './generateRooms';
import type { CarveResult } from './generateRooms';
import { makeRoom, type Room } from './level';

/**
 * Cellular-automata cave generator.
 *
 * The point of having a second generator is that layout grammar is the
 * strongest anti-monotony lever available. Rooms-and-corridors produces
 * chokepoints and doorway fighting; caves produce open swarming and
 * cover-blob kiting. That is a genuinely different game feel out of one extra
 * function, and no palette swap can achieve it.
 *
 * Connectivity here is a *mechanism*, not a check: keep the largest region,
 * tunnel the big detached caverns back in, fill the small ones.
 */
export function carveCaves(rng: Rng, plan: FloorPlan, cfg: GeneratorConfig): CarveResult {
  const cc = cfg.caves;
  if (!cc) throw new Error('carveCaves called without a caves config');

  const map = new Tilemap(plan.w, plan.h, Tile.Wall);

  // 1. Random fill, with a two-tile solid border.
  for (let y = 2; y < plan.h - 2; y++) {
    for (let x = 2; x < plan.w - 2; x++) {
      map.set(x, y, rng.chance(cc.fillP) ? Tile.Wall : Tile.Floor);
    }
  }

  // 2. Smooth. The radius-2 rule on the first two passes kills isolated
  // single-tile speckle that would otherwise survive forever.
  for (let iter = 0; iter < cc.smoothIters; iter++) {
    smooth(map, iter < 2);
  }

  // 3. Largest-region keep.
  reconnectRegions(map, cc.reconnectMinSize);

  // 4. Reject a cave that smoothed itself into stringy nothing. Cheaper to
  // regenerate from a derived seed than to try to rescue it.
  const openTiles = map.countWalkable();
  if (openTiles < cc.minRegionFrac * plan.w * plan.h) {
    return { map, rooms: [], edges: [] };
  }

  // 5. Lakes and pools.
  carveLakes(rng, map, cc.lakeBlobs, cc.lakeSize);

  fillVoid(map);

  // 6. Chambers stand in for rooms. Relax the detector until there are enough
  // anchors for special-room placement to have something to work with — a
  // stringy cave still needs an entrance, an exit and a shrine somewhere.
  let rooms = detectChambers(map, 4, 8);
  if (rooms.length < 8) rooms = detectChambers(map, 3, 6);
  if (rooms.length < 6) rooms = detectChambers(map, 2, 5);
  reindex(rooms);

  return { map, rooms, edges: [] };
}

function smooth(map: Tilemap, killSpeckle: boolean): void {
  const snapshot = map.t.slice();
  const w = map.w;

  const walkableAt = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= map.w || y >= map.h) return false;
    return WALKABLE[snapshot[y * w + x]] === 1;
  };

  for (let y = 2; y < map.h - 2; y++) {
    for (let x = 2; x < map.w - 2; x++) {
      let walls = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (!walkableAt(x + dx, y + dy)) walls++;
        }
      }

      if (walls >= 5) map.set(x, y, Tile.Wall);
      else if (walls <= 3) map.set(x, y, Tile.Floor);

      if (killSpeckle) {
        let wide = 0;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            if (!walkableAt(x + dx, y + dy)) wide++;
          }
        }
        if (wide <= 2) map.set(x, y, Tile.Wall);
      }
    }
  }
}

/**
 * Keep the biggest cavern. Reconnect detached caverns of at least
 * `reconnectMinSize` with a width-2 tunnel — those are interesting side areas
 * worth preserving. Fill everything smaller.
 */
function reconnectRegions(map: Tilemap, reconnectMinSize: number): void {
  let regions = labelRegions(map);
  if (regions.length === 0) return;

  const main = regions[0];
  for (let i = 1; i < regions.length; i++) {
    const r = regions[i];
    if (r.size < reconnectMinSize) {
      for (const idx of r.tiles) map.t[idx] = Tile.Wall;
      continue;
    }
    const pair = closestPair(map, main, r);
    carveTunnel(map, pair.ax, pair.ay, pair.bx, pair.by, 2, Tile.Corridor);
  }

  // Tunnelling can leave new hairline pockets; sweep once more.
  regions = labelRegions(map);
  for (let i = 1; i < regions.length; i++) {
    for (const idx of regions[i].tiles) map.t[idx] = Tile.Wall;
  }
}

/** Blobs of shallow liquid in wide-open areas. */
function carveLakes(
  rng: Rng,
  map: Tilemap,
  blobRange: [number, number],
  sizeRange: [number, number],
): void {
  const blobs = rng.int(blobRange[0], blobRange[1]);
  for (let b = 0; b < blobs; b++) {
    const size = rng.int(sizeRange[0], sizeRange[1]);
    // Find a reasonably open seed by sampling.
    let sx = -1;
    let sy = -1;
    for (let attempt = 0; attempt < 60; attempt++) {
      const x = rng.int(4, map.w - 5);
      const y = rng.int(4, map.h - 5);
      if (map.at(x, y) !== Tile.Floor) continue;
      if (map.wallNeighbors8(x, y) > 0) continue;
      sx = x;
      sy = y;
      break;
    }
    if (sx < 0) continue;

    // Random walk blob growth: organic outline, no cost.
    let x = sx;
    let y = sy;
    for (let i = 0; i < size; i++) {
      if (map.at(x, y) === Tile.Floor) map.set(x, y, Tile.ShallowLiquid);
      const dir = rng.int(0, 3);
      if (dir === 0) x++;
      else if (dir === 1) x--;
      else if (dir === 2) y++;
      else y--;
      x = Math.max(3, Math.min(map.w - 4, x));
      y = Math.max(3, Math.min(map.h - 4, y));
    }
  }
}

function reindex(rooms: Room[]): void {
  for (let i = 0; i < rooms.length; i++) rooms[i].id = i;
}

/**
 * Stamp a literal rectangular room into a cave and connect it with a single
 * corridor.
 *
 * The contrast — a man-made vault embedded in an organic cavern — reads as
 * intentional rather than as a generator bug, and it looks good with
 * procedural rendering because the rectilinear mortar walls sit against blobby
 * cave walls.
 */
export function stampVault(
  map: Tilemap,
  rooms: Room[],
  anchor: Room,
  w: number,
  h: number,
  sealed: boolean,
): Room | null {
  const x = Math.round(anchor.cx - w / 2);
  const y = Math.round(anchor.cy - h / 2);
  if (x < 2 || y < 2 || x + w >= map.w - 2 || y + h >= map.h - 2) return null;

  // Ring of wall, floor interior.
  for (let ty = y - 1; ty <= y + h; ty++) {
    for (let tx = x - 1; tx <= x + w; tx++) {
      const inside = tx >= x && ty >= y && tx < x + w && ty < y + h;
      map.set(tx, ty, inside ? Tile.Floor : Tile.Wall);
    }
  }

  const room = makeRoom(rooms.length, x, y, w, h);
  room.degree = 1;
  rooms.push(room);

  // Punch one entrance on the side facing the most open space.
  const doorSide = pickDoorSide(map, x, y, w, h);
  const door = doorTiles(x, y, w, h, doorSide);
  for (const [dx, dy] of door) {
    map.set(dx, dy, sealed ? Tile.DoorSealed : Tile.DoorOpen);
  }

  // Tunnel outward from the door until it meets existing walkable space.
  const [ox, oy] = outwardStep(doorSide);
  let tx = door[0][0] + ox;
  let ty = door[0][1] + oy;
  for (let i = 0; i < 40; i++) {
    if (tx < 2 || ty < 2 || tx >= map.w - 2 || ty >= map.h - 2) break;
    if (WALKABLE[map.at(tx, ty)] === 1) break;
    map.set(tx, ty, Tile.Corridor);
    map.set(tx + (ox === 0 ? 1 : 0), ty + (oy === 0 ? 1 : 0), Tile.Corridor);
    tx += ox;
    ty += oy;
  }

  return room;
}

function pickDoorSide(map: Tilemap, x: number, y: number, w: number, h: number): 0 | 1 | 2 | 3 {
  // 0 = north, 1 = east, 2 = south, 3 = west. Pick whichever direction has the
  // most walkable tiles a few steps out.
  const probes: Array<[0 | 1 | 2 | 3, number, number]> = [
    [0, x + (w >> 1), y - 5],
    [1, x + w + 4, y + (h >> 1)],
    [2, x + (w >> 1), y + h + 4],
    [3, x - 5, y + (h >> 1)],
  ];
  let bestSide: 0 | 1 | 2 | 3 = 0;
  let bestScore = -1;
  for (const [side, px, py] of probes) {
    let score = 0;
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        if (WALKABLE[map.at(px + dx, py + dy)] === 1) score++;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestSide = side;
    }
  }
  return bestSide;
}

function doorTiles(
  x: number,
  y: number,
  w: number,
  h: number,
  side: 0 | 1 | 2 | 3,
): Array<[number, number]> {
  const mx = x + (w >> 1);
  const my = y + (h >> 1);
  switch (side) {
    case 0:
      return [
        [mx, y - 1],
        [mx + 1, y - 1],
      ];
    case 1:
      return [
        [x + w, my],
        [x + w, my + 1],
      ];
    case 2:
      return [
        [mx, y + h],
        [mx + 1, y + h],
      ];
    default:
      return [
        [x - 1, my],
        [x - 1, my + 1],
      ];
  }
}

function outwardStep(side: 0 | 1 | 2 | 3): [number, number] {
  switch (side) {
    case 0:
      return [0, -1];
    case 1:
      return [1, 0];
    case 2:
      return [0, 1];
    default:
      return [-1, 0];
  }
}
