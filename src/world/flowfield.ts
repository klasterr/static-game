import { TILE } from '../core/constants';
import type { Vec2 } from '../core/math';
import { Tilemap } from './tiles';

/**
 * Breadth-first distance field toward a goal tile.
 *
 * Enemies steer down this gradient instead of each running A*. For a dungeon
 * whose corridors are two tiles wide, the result is indistinguishable from
 * per-enemy pathfinding and roughly fifty times cheaper: one BFS over ~10k
 * tiles when the goal's tile changes, versus 40 searches every frame.
 *
 * Recompute policy lives in the caller — typically "when the player's tile has
 * moved more than a couple of tiles", not per frame.
 */

const UNREACHABLE = 0x7fffffff;

export class FlowField {
  private w = 0;
  private h = 0;
  dist: Int32Array = new Int32Array(0);
  private queue: Int32Array = new Int32Array(0);

  goalTx = -1;
  goalTy = -1;
  /** Incremented on every recompute; lets callers cache derived data. */
  revision = 0;

  private ensure(w: number, h: number): void {
    if (this.w === w && this.h === h) return;
    this.w = w;
    this.h = h;
    this.dist = new Int32Array(w * h);
    this.queue = new Int32Array(w * h);
  }

  /** True if a recompute is warranted for a goal at this world position. */
  needsUpdate(wx: number, wy: number, slack = 2): boolean {
    const tx = Math.floor(wx / TILE);
    const ty = Math.floor(wy / TILE);
    if (this.goalTx < 0) return true;
    return Math.abs(tx - this.goalTx) > slack || Math.abs(ty - this.goalTy) > slack;
  }

  compute(map: Tilemap, goalWx: number, goalWy: number): void {
    this.ensure(map.w, map.h);
    const w = this.w;
    const h = this.h;
    const dist = this.dist;
    dist.fill(UNREACHABLE);

    let gx = Math.floor(goalWx / TILE);
    let gy = Math.floor(goalWy / TILE);

    // If the goal sits in a wall (mid-teleport, pushed into geometry), walk out
    // to the nearest open tile so the field is never empty.
    if (map.isBlocked(gx, gy)) {
      let found = false;
      for (let ring = 1; ring <= 6 && !found; ring++) {
        for (let dy = -ring; dy <= ring && !found; dy++) {
          for (let dx = -ring; dx <= ring && !found; dx++) {
            if (Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
            if (!map.isBlocked(gx + dx, gy + dy)) {
              gx += dx;
              gy += dy;
              found = true;
            }
          }
        }
      }
      if (!found) {
        this.goalTx = -1;
        this.goalTy = -1;
        this.revision++;
        return;
      }
    }

    this.goalTx = gx;
    this.goalTy = gy;

    const queue = this.queue;
    let head = 0;
    let tail = 0;
    const start = gy * w + gx;
    dist[start] = 0;
    queue[tail++] = start;

    while (head < tail) {
      const idx = queue[head++];
      const d = dist[idx] + 1;
      const x = idx % w;
      const y = (idx - x) / w;

      // 4-neighbour BFS. Diagonal smoothing happens at lookup time.
      if (x > 0) {
        const n = idx - 1;
        if (dist[n] === UNREACHABLE && !map.isBlocked(x - 1, y)) {
          dist[n] = d;
          queue[tail++] = n;
        }
      }
      if (x < w - 1) {
        const n = idx + 1;
        if (dist[n] === UNREACHABLE && !map.isBlocked(x + 1, y)) {
          dist[n] = d;
          queue[tail++] = n;
        }
      }
      if (y > 0) {
        const n = idx - w;
        if (dist[n] === UNREACHABLE && !map.isBlocked(x, y - 1)) {
          dist[n] = d;
          queue[tail++] = n;
        }
      }
      if (y < h - 1) {
        const n = idx + w;
        if (dist[n] === UNREACHABLE && !map.isBlocked(x, y + 1)) {
          dist[n] = d;
          queue[tail++] = n;
        }
      }
    }

    this.revision++;
  }

  distAt(tx: number, ty: number): number {
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return UNREACHABLE;
    return this.dist[ty * this.w + tx];
  }

  reachable(tx: number, ty: number): boolean {
    return this.distAt(tx, ty) !== UNREACHABLE;
  }

  /**
   * Unit direction of steepest descent at a world position, written into `out`.
   * Returns false when the field has nothing useful to say (unreachable tile,
   * or already at the goal) so the caller can fall back to steering directly.
   */
  dirAt(map: Tilemap, wx: number, wy: number, out: Vec2): boolean {
    const tx = Math.floor(wx / TILE);
    const ty = Math.floor(wy / TILE);
    const here = this.distAt(tx, ty);
    if (here === UNREACHABLE) return false;
    if (here === 0) return false;

    let bestD = here;
    let bx = 0;
    let by = 0;

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        // Never cut a corner through geometry: a diagonal needs both
        // orthogonal neighbours open, or enemies clip wall corners.
        if (dx !== 0 && dy !== 0) {
          if (map.isBlocked(tx + dx, ty) || map.isBlocked(tx, ty + dy)) continue;
        }
        const d = this.distAt(tx + dx, ty + dy);
        if (d < bestD) {
          bestD = d;
          bx = dx;
          by = dy;
        }
      }
    }

    if (bx === 0 && by === 0) return false;

    // Aim at the centre of the chosen neighbour rather than along the raw
    // lattice direction; that keeps movement off the tile seams and stops the
    // characteristic zig-zag of naive grid following.
    const targetX = (tx + bx + 0.5) * TILE;
    const targetY = (ty + by + 0.5) * TILE;
    const ddx = targetX - wx;
    const ddy = targetY - wy;
    const l = Math.sqrt(ddx * ddx + ddy * ddy);
    if (l < 1e-6) {
      out.x = bx;
      out.y = by;
      return true;
    }
    out.x = ddx / l;
    out.y = ddy / l;
    return true;
  }
}
