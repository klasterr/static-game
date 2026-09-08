import { Tile, Tilemap, WALKABLE } from '../world/tiles';
import type { Room } from './level';

/**
 * Connectivity.
 *
 * Two mechanisms, one per generator:
 *  - Rooms use Prim's MST over room centres, which makes connectivity a
 *    STRUCTURAL guarantee (exactly n-1 edges, spanning tree) rather than
 *    something you hope for and then check.
 *  - Caves use largest-region-keep, reconnecting big detached caverns and
 *    filling small ones.
 *
 * The flood-fill assertion below then runs in both cases as a safety net and as
 * an invariant that CI can fuzz over thousands of seeds.
 */

export interface Region {
  size: number;
  /** One representative tile index, for tunnelling. */
  seed: number;
  tiles: number[];
}

/** Label every walkable connected component. */
export function labelRegions(map: Tilemap): Region[] {
  const w = map.w;
  const h = map.h;
  const seen = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  const regions: Region[] = [];

  for (let start = 0; start < seen.length; start++) {
    if (seen[start] === 1) continue;
    if (WALKABLE[map.t[start]] !== 1) continue;

    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    const tiles: number[] = [];

    while (head < tail) {
      const idx = queue[head++];
      tiles.push(idx);
      const x = idx % w;
      const y = (idx - x) / w;

      if (x > 0) {
        const n = idx - 1;
        if (seen[n] === 0 && WALKABLE[map.t[n]] === 1) {
          seen[n] = 1;
          queue[tail++] = n;
        }
      }
      if (x < w - 1) {
        const n = idx + 1;
        if (seen[n] === 0 && WALKABLE[map.t[n]] === 1) {
          seen[n] = 1;
          queue[tail++] = n;
        }
      }
      if (y > 0) {
        const n = idx - w;
        if (seen[n] === 0 && WALKABLE[map.t[n]] === 1) {
          seen[n] = 1;
          queue[tail++] = n;
        }
      }
      if (y < h - 1) {
        const n = idx + w;
        if (seen[n] === 0 && WALKABLE[map.t[n]] === 1) {
          seen[n] = 1;
          queue[tail++] = n;
        }
      }
    }

    regions.push({ size: tiles.length, seed: start, tiles });
  }

  regions.sort((a, b) => b.size - a.size);
  return regions;
}

export interface ConnectivityReport {
  ok: boolean;
  walkable: number;
  reached: number;
  /** Sizes of every unreached component, largest first. */
  orphanSizes: number[];
}

/**
 * Flood fill from a start tile and report coverage. This is the invariant the
 * connectivity fuzz test asserts: 100% of walkable tiles reachable.
 */
export function checkConnectivity(map: Tilemap, startTx: number, startTy: number): ConnectivityReport {
  const regions = labelRegions(map);
  let walkable = 0;
  for (const r of regions) walkable += r.size;

  const startIdx = startTy * map.w + startTx;
  const home = regions.find((r) => r.tiles.includes(startIdx));
  const reached = home ? home.size : 0;
  const orphanSizes = regions.filter((r) => r !== home).map((r) => r.size);

  return { ok: reached === walkable && walkable > 0, walkable, reached, orphanSizes };
}

/**
 * Fill orphan components smaller than `minKeep` with wall, and report the
 * largest orphan that survives. Small pockets are a harmless artefact of
 * corridor carving; a big one means regenerate.
 */
export function sealSmallOrphans(
  map: Tilemap,
  startTx: number,
  startTy: number,
  minKeep: number,
): number {
  const regions = labelRegions(map);
  if (regions.length <= 1) return 0;

  const startIdx = startTy * map.w + startTx;
  const home = regions.find((r) => r.tiles.includes(startIdx)) ?? regions[0];

  let largestSurviving = 0;
  for (const r of regions) {
    if (r === home) continue;
    if (r.size <= minKeep) {
      for (const idx of r.tiles) map.t[idx] = Tile.Wall;
    } else {
      largestSurviving = Math.max(largestSurviving, r.size);
    }
  }
  return largestSurviving;
}

// --------------------------------------------------------------------- MST

export interface Edge {
  a: number;
  b: number;
  cost: number;
}

/**
 * Prim's minimum spanning tree over room centres, squared-distance weighted.
 * Returns exactly `rooms.length - 1` edges, so the graph is provably connected.
 */
export function primMST(rooms: Room[]): Edge[] {
  const n = rooms.length;
  if (n <= 1) return [];

  const inTree = new Uint8Array(n);
  const best = new Float64Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
  const edges: Edge[] = [];

  inTree[0] = 1;
  for (let i = 1; i < n; i++) {
    best[i] = cost(rooms[0], rooms[i]);
    parent[i] = 0;
  }

  for (let added = 1; added < n; added++) {
    let pick = -1;
    let pickCost = Infinity;
    for (let i = 0; i < n; i++) {
      if (inTree[i] === 1) continue;
      if (best[i] < pickCost) {
        pickCost = best[i];
        pick = i;
      }
    }
    if (pick < 0) break;

    inTree[pick] = 1;
    edges.push({ a: parent[pick], b: pick, cost: pickCost });

    for (let i = 0; i < n; i++) {
      if (inTree[i] === 1) continue;
      const c = cost(rooms[pick], rooms[i]);
      if (c < best[i]) {
        best[i] = c;
        parent[i] = pick;
      }
    }
  }

  return edges;
}

function cost(a: Room, b: Room): number {
  const dx = a.cx - b.cx;
  const dy = a.cy - b.cy;
  return dx * dx + dy * dy;
}

/** Every room pair, cheapest first, excluding pairs already in `existing`. */
export function candidateEdges(rooms: Room[], existing: Edge[]): Edge[] {
  const taken = new Set<string>();
  for (const e of existing) taken.add(edgeKey(e.a, e.b));

  const out: Edge[] = [];
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      if (taken.has(edgeKey(i, j))) continue;
      out.push({ a: i, b: j, cost: cost(rooms[i], rooms[j]) });
    }
  }
  out.sort((x, y) => x.cost - y.cost);
  return out;
}

export function edgeKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

/** Hop distance between rooms over an edge list. Used to place loop edges well. */
export function hopDistances(roomCount: number, edges: Edge[], from: number): Int32Array {
  const adj: number[][] = Array.from({ length: roomCount }, () => []);
  for (const e of edges) {
    adj[e.a].push(e.b);
    adj[e.b].push(e.a);
  }
  const dist = new Int32Array(roomCount).fill(-1);
  const queue: number[] = [from];
  dist[from] = 0;
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    for (const next of adj[cur]) {
      if (dist[next] !== -1) continue;
      dist[next] = dist[cur] + 1;
      queue.push(next);
    }
  }
  return dist;
}

// ------------------------------------------------------------ tile distances

/**
 * BFS over walkable tiles from a single source. Used for stair placement and
 * for "how far off the main path is this room".
 */
export function tileDistances(map: Tilemap, srcTx: number, srcTy: number): Int32Array {
  const w = map.w;
  const h = map.h;
  const dist = new Int32Array(w * h).fill(-1);
  if (!map.isWalkable(srcTx, srcTy)) return dist;

  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  const start = srcTy * w + srcTx;
  dist[start] = 0;
  queue[tail++] = start;

  while (head < tail) {
    const idx = queue[head++];
    const d = dist[idx] + 1;
    const x = idx % w;
    const y = (idx - x) / w;

    if (x > 0 && dist[idx - 1] === -1 && WALKABLE[map.t[idx - 1]] === 1) {
      dist[idx - 1] = d;
      queue[tail++] = idx - 1;
    }
    if (x < w - 1 && dist[idx + 1] === -1 && WALKABLE[map.t[idx + 1]] === 1) {
      dist[idx + 1] = d;
      queue[tail++] = idx + 1;
    }
    if (y > 0 && dist[idx - w] === -1 && WALKABLE[map.t[idx - w]] === 1) {
      dist[idx - w] = d;
      queue[tail++] = idx - w;
    }
    if (y < h - 1 && dist[idx + w] === -1 && WALKABLE[map.t[idx + w]] === 1) {
      dist[idx + w] = d;
      queue[tail++] = idx + w;
    }
  }

  return dist;
}

/** Carve a straight width-`width` tunnel between two tiles. */
export function carveTunnel(
  map: Tilemap,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  width: number,
  tile: number = Tile.Corridor,
): void {
  let x = x0;
  let y = y0;
  const half = Math.floor(width / 2);
  const guard = (Math.abs(x1 - x0) + Math.abs(y1 - y0)) * 2 + 8;

  for (let i = 0; i < guard; i++) {
    stampBrush(map, x, y, half, width, tile);
    if (x === x1 && y === y1) break;
    // Move on the axis with the larger remaining delta; ties go horizontal.
    if (Math.abs(x1 - x) >= Math.abs(y1 - y) && x !== x1) x += x1 > x ? 1 : -1;
    else if (y !== y1) y += y1 > y ? 1 : -1;
    else if (x !== x1) x += x1 > x ? 1 : -1;
  }
}

function stampBrush(
  map: Tilemap,
  x: number,
  y: number,
  half: number,
  width: number,
  tile: number,
): void {
  for (let dy = -half; dy < width - half; dy++) {
    for (let dx = -half; dx < width - half; dx++) {
      const tx = x + dx;
      const ty = y + dy;
      // Keep a one-tile border so nothing opens onto the void.
      if (tx < 1 || ty < 1 || tx >= map.w - 1 || ty >= map.h - 1) continue;
      if (WALKABLE[map.t[ty * map.w + tx]] === 1) continue;
      map.t[ty * map.w + tx] = tile;
    }
  }
}

/** Nearest tile pair between two regions. O(|a| * sample of |b|). */
export function closestPair(
  map: Tilemap,
  a: Region,
  b: Region,
): { ax: number; ay: number; bx: number; by: number } {
  const w = map.w;
  let best = Infinity;
  let out = { ax: 0, ay: 0, bx: 0, by: 0 };

  // Subsample the larger region; exactness buys nothing here and the naive
  // product is 10^7 on a big map.
  const strideA = Math.max(1, Math.floor(a.tiles.length / 400));
  const strideB = Math.max(1, Math.floor(b.tiles.length / 400));

  for (let i = 0; i < a.tiles.length; i += strideA) {
    const ia = a.tiles[i];
    const ax = ia % w;
    const ay = (ia - ax) / w;
    for (let j = 0; j < b.tiles.length; j += strideB) {
      const ib = b.tiles[j];
      const bx = ib % w;
      const by = (ib - bx) / w;
      const dx = ax - bx;
      const dy = ay - by;
      const d = dx * dx + dy * dy;
      if (d < best) {
        best = d;
        out = { ax, ay, bx, by };
      }
    }
  }
  return out;
}
