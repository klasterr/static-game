import { Tilemap, WALKABLE } from '../world/tiles';
import { makeRoom, type Room } from './level';

/**
 * Chebyshev distance transform: for every walkable tile, how far to the nearest
 * wall. Two sequential passes over the grid, which is exact for the Chebyshev
 * metric and far cheaper than a BFS per tile.
 */
export function wallDistance(map: Tilemap): Int32Array {
  const w = map.w;
  const h = map.h;
  const d = new Int32Array(w * h);
  const BIG = 1 << 20;

  for (let i = 0; i < d.length; i++) {
    d[i] = WALKABLE[map.t[i]] === 1 ? BIG : 0;
  }

  // Forward: north-west neighbourhood.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      let best = d[i];
      if (y > 0) {
        if (x > 0) best = Math.min(best, d[i - w - 1] + 1);
        best = Math.min(best, d[i - w] + 1);
        if (x < w - 1) best = Math.min(best, d[i - w + 1] + 1);
      }
      if (x > 0) best = Math.min(best, d[i - 1] + 1);
      d[i] = best;
    }
  }

  // Backward: south-east neighbourhood.
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      let best = d[i];
      if (y < h - 1) {
        if (x < w - 1) best = Math.min(best, d[i + w + 1] + 1);
        best = Math.min(best, d[i + w] + 1);
        if (x > 0) best = Math.min(best, d[i + w - 1] + 1);
      }
      if (x < w - 1) best = Math.min(best, d[i + 1] + 1);
      d[i] = best;
    }
  }

  return d;
}

/**
 * Caves have no rooms, but the special-room system needs anchors. Find local
 * maxima of the wall-distance field and treat each as a chamber.
 *
 * `degree` is approximated by counting narrow chokepoints nearby, which is
 * enough to tell a cul-de-sac chamber from a junction — and that distinction is
 * all the placement rules actually need.
 */
export function detectChambers(
  map: Tilemap,
  minRadius = 4,
  suppressRadius = 8,
): Room[] {
  const dist = wallDistance(map);
  const w = map.w;
  const h = map.h;

  interface Peak {
    x: number;
    y: number;
    v: number;
  }
  const peaks: Peak[] = [];

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const v = dist[y * w + x];
      if (v < minRadius) continue;
      // Local maximum in the 3x3 neighbourhood; ties broken by scan order.
      let isMax = true;
      for (let dy = -1; dy <= 1 && isMax; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (dist[(y + dy) * w + (x + dx)] > v) {
            isMax = false;
            break;
          }
        }
      }
      if (isMax) peaks.push({ x, y, v });
    }
  }

  peaks.sort((a, b) => b.v - a.v);

  const kept: Peak[] = [];
  for (const p of peaks) {
    let tooClose = false;
    for (const k of kept) {
      const dx = k.x - p.x;
      const dy = k.y - p.y;
      if (dx * dx + dy * dy < suppressRadius * suppressRadius) {
        tooClose = true;
        break;
      }
    }
    if (!tooClose) kept.push(p);
  }

  const rooms: Room[] = [];
  for (let i = 0; i < kept.length; i++) {
    const p = kept[i];
    const size = p.v * 2 + 1;
    const room = makeRoom(i, p.x - p.v, p.y - p.v, size, size);
    room.cx = p.x;
    room.cy = p.y;
    room.degree = chokepointCount(dist, map, p.x, p.y, 12);
    rooms.push(room);
  }
  return rooms;
}

/** Narrow passages within `radius`. A proxy for "how many ways out are there". */
function chokepointCount(
  dist: Int32Array,
  map: Tilemap,
  cx: number,
  cy: number,
  radius: number,
): number {
  const w = map.w;
  let count = 0;
  // Sample the ring rather than the disc: only the boundary tells us about exits.
  for (let a = 0; a < 16; a++) {
    const ang = (a / 16) * Math.PI * 2;
    const x = Math.round(cx + Math.cos(ang) * radius);
    const y = Math.round(cy + Math.sin(ang) * radius);
    if (x < 0 || y < 0 || x >= map.w || y >= map.h) continue;
    if (WALKABLE[map.t[y * w + x]] !== 1) continue;
    if (dist[y * w + x] <= 2) count++;
  }
  return Math.max(1, Math.round(count / 2));
}

/** The widest open spot in the map, for placing a boss arena or a fallback. */
export function widestPoint(map: Tilemap): { x: number; y: number; radius: number } {
  const dist = wallDistance(map);
  let best = -1;
  let bx = 1;
  let by = 1;
  for (let i = 0; i < dist.length; i++) {
    if (dist[i] > best) {
      best = dist[i];
      bx = i % map.w;
      by = (i - bx) / map.w;
    }
  }
  return { x: bx, y: by, radius: Math.max(1, best) };
}
