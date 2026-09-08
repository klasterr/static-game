import type { Rng } from '../core/rng';
import type { GeneratorConfig } from '../content/types/biome';
import { Tile, Tilemap, WALKABLE } from '../world/tiles';
import type { FloorPlan } from '../systems/scaling';
import { candidateEdges, edgeKey, hopDistances, primMST, type Edge } from './connectivity';
import { makeRoom, roomsOverlap, type Room } from './level';

export interface CarveResult {
  map: Tilemap;
  rooms: Room[];
  edges: Edge[];
}

/**
 * Rooms-and-corridors generator.
 *
 * Random placement with rejection sampling rather than BSP: BSP's defining
 * artefact is that every room is axis-aligned and space-filling with no wasted
 * space, which reads as very regular and is the most monotonous option over
 * hundreds of floors. Rejection sampling gives irregular negative space for
 * free, and that negative space is what corridors turn into canyons.
 */
export function carveRooms(rng: Rng, plan: FloorPlan, cfg: GeneratorConfig): CarveResult {
  const rc = cfg.rooms;
  if (!rc) throw new Error('carveRooms called without a rooms config');

  const map = new Tilemap(plan.w, plan.h, Tile.Wall);
  const target = rng.int(plan.roomCount[0], plan.roomCount[1]);

  let rooms = placeRooms(rng, map, plan, rc, target, rc.margin);
  // If the map was too crowded to fit a usable number of rooms, retry once with
  // a tighter margin rather than throwing the whole floor away.
  if (rooms.length < 8) {
    map.t.fill(Tile.Wall);
    rooms = placeRooms(rng, map, plan, rc, target, Math.max(2, rc.margin - 1));
  }

  for (const r of rooms) carveRoomFloor(map, r);

  // Prim's MST: exactly n-1 edges over a complete graph, so the result is a
  // spanning tree and connectivity is proven by construction.
  const tree = primMST(rooms);
  const edges: Edge[] = tree.slice();

  // Loop edges. A dead-end corridor with eight chasers in it is not a fight,
  // it's a coin flip — so add the cheapest extra edges between rooms that are
  // far apart in the tree, which turns dead ends into circuits.
  const loopTarget = Math.round(rc.loopRatio * rooms.length);
  if (loopTarget > 0 && rooms.length > 3) {
    const hops = hopDistances(rooms.length, tree, 0);
    const taken = new Set(tree.map((e) => edgeKey(e.a, e.b)));
    let added = 0;
    for (const cand of candidateEdges(rooms, tree)) {
      if (added >= loopTarget) break;
      if (taken.has(edgeKey(cand.a, cand.b))) continue;
      // Endpoints at least 3 hops apart, so the loop actually shortens
      // something rather than doubling an existing link.
      if (Math.abs(hops[cand.a] - hops[cand.b]) < 3) continue;
      edges.push(cand);
      taken.add(edgeKey(cand.a, cand.b));
      added++;
    }
  }

  for (const e of edges) {
    const a = rooms[e.a];
    const b = rooms[e.b];
    // Width 2 is not negotiable. Width 1 breaks knockback, dodge-rolling and
    // any kind of flanking.
    carveL(map, a.cx, a.cy, b.cx, b.cy, rc.corridorWidth, rng.chance(0.5));
    a.neighbors.push(b.id);
    b.neighbors.push(a.id);
    a.degree++;
    b.degree++;
  }

  placeDoors(map);
  placeProps(map, rng, rooms, rc.propChance);
  fillVoid(map);

  return { map, rooms, edges };
}

function placeRooms(
  rng: Rng,
  map: Tilemap,
  plan: FloorPlan,
  rc: NonNullable<GeneratorConfig['rooms']>,
  target: number,
  margin: number,
): Room[] {
  const rooms: Room[] = [];
  const attempts = 300;

  for (let i = 0; i < attempts && rooms.length < target; i++) {
    // Odd dimensions make corridor centring exact and avoid one-tile seams.
    const w = rng.int(rc.w[0], rc.w[1]) | 1;
    const h = rng.int(rc.h[0], rc.h[1]) | 1;
    if (w + 6 >= plan.w || h + 6 >= plan.h) continue;
    const x = rng.int(2, plan.w - w - 3);
    const y = rng.int(2, plan.h - h - 3);
    const cand = makeRoom(rooms.length, x, y, w, h);

    let clash = false;
    for (const other of rooms) {
      if (roomsOverlap(cand, other, margin)) {
        clash = true;
        break;
      }
    }
    if (clash) continue;
    rooms.push(cand);
  }

  void map;
  return rooms;
}

function carveRoomFloor(map: Tilemap, r: Room): void {
  for (let ty = r.y; ty < r.y + r.h; ty++) {
    for (let tx = r.x; tx < r.x + r.w; tx++) {
      map.set(tx, ty, Tile.Floor);
    }
  }
}

/** L-shaped corridor: one leg horizontal, one vertical, elbow order randomised. */
function carveL(
  map: Tilemap,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  width: number,
  horizontalFirst: boolean,
): void {
  if (horizontalFirst) {
    carveSegment(map, x0, y0, x1, y0, width);
    carveSegment(map, x1, y0, x1, y1, width);
  } else {
    carveSegment(map, x0, y0, x0, y1, width);
    carveSegment(map, x0, y1, x1, y1, width);
  }
}

function carveSegment(
  map: Tilemap,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  width: number,
): void {
  const half = Math.floor(width / 2);
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  const sx = Math.sign(x1 - x0);
  const sy = Math.sign(y1 - y0);

  for (let i = 0; i <= steps; i++) {
    const x = x0 + sx * i;
    const y = y0 + sy * i;
    for (let dy = -half; dy < width - half; dy++) {
      for (let dx = -half; dx < width - half; dx++) {
        const tx = x + dx;
        const ty = y + dy;
        if (tx < 1 || ty < 1 || tx >= map.w - 1 || ty >= map.h - 1) continue;
        // Room floors keep their identity; only rock becomes corridor.
        if (WALKABLE[map.at(tx, ty)] === 1) continue;
        map.set(tx, ty, Tile.Corridor);
      }
    }
  }
}

/**
 * A threshold is a corridor tile that touches room floor on one side and rock
 * on another. Doors anchor the sealed-vault logic and the room-entry aggro
 * trigger, and they make a doorway read as a place rather than a gap.
 */
function placeDoors(map: Tilemap): void {
  const w = map.w;
  const h = map.h;
  const doors: number[] = [];

  for (let ty = 1; ty < h - 1; ty++) {
    for (let tx = 1; tx < w - 1; tx++) {
      if (map.at(tx, ty) !== Tile.Corridor) continue;
      let touchesRoom = false;
      let touchesRock = false;
      if (map.at(tx - 1, ty) === Tile.Floor || map.at(tx + 1, ty) === Tile.Floor ||
          map.at(tx, ty - 1) === Tile.Floor || map.at(tx, ty + 1) === Tile.Floor) {
        touchesRoom = true;
      }
      if (map.isSolid(tx - 1, ty) || map.isSolid(tx + 1, ty) ||
          map.isSolid(tx, ty - 1) || map.isSolid(tx, ty + 1)) {
        touchesRock = true;
      }
      if (touchesRoom && touchesRock) doors.push(ty * w + tx);
    }
  }

  for (const idx of doors) map.t[idx] = Tile.DoorOpen;
}

/**
 * Pillars in large rooms. Clustered into 2x2 or 1x3 runs rather than sprinkled,
 * because salt-and-pepper props look like noise and give no usable cover.
 */
function placeProps(map: Tilemap, rng: Rng, rooms: Room[], chance: number): void {
  for (const r of rooms) {
    if (r.w < 12 || r.h < 9) continue;
    const clusters = Math.round(r.w * r.h * chance * 0.02);
    for (let i = 0; i < clusters; i++) {
      if (!rng.chance(0.85)) continue;
      const cx = rng.int(r.x + 2, r.x + r.w - 4);
      const cy = rng.int(r.y + 2, r.y + r.h - 4);
      const vertical = rng.chance(0.5);
      const shape = rng.chance(0.5) ? [[0, 0], [1, 0], [0, 1], [1, 1]] :
        vertical ? [[0, 0], [0, 1], [0, 2]] : [[0, 0], [1, 0], [2, 0]];
      for (const [dx, dy] of shape) {
        const tx = cx + dx;
        const ty = cy + dy;
        // Never wall off the room's own perimeter ring.
        if (tx <= r.x || ty <= r.y || tx >= r.x + r.w - 1 || ty >= r.y + r.h - 1) continue;
        if (map.at(tx, ty) !== Tile.Floor) continue;
        map.set(tx, ty, Tile.Prop);
      }
    }
  }
}

/**
 * Wall tiles with no walkable neighbour at all become Void, which is never
 * drawn. On a 100x100 map this removes several thousand draw calls per frame.
 */
export function fillVoid(map: Tilemap): void {
  const snapshot = map.t.slice();
  for (let ty = 0; ty < map.h; ty++) {
    for (let tx = 0; tx < map.w; tx++) {
      const idx = ty * map.w + tx;
      if (snapshot[idx] !== Tile.Wall) continue;
      let touches = false;
      for (let dy = -1; dy <= 1 && !touches; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = tx + dx;
          const ny = ty + dy;
          if (nx < 0 || ny < 0 || nx >= map.w || ny >= map.h) continue;
          const n = snapshot[ny * map.w + nx];
          if (WALKABLE[n] === 1 || n === Tile.Pit) {
            touches = true;
            break;
          }
        }
      }
      if (!touches) map.t[idx] = Tile.Void;
    }
  }
}
