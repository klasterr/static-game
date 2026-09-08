import { TILE } from '../core/constants';
import { hash2 } from '../core/math';

/**
 * Tile ids are stored in a `Uint8Array`, so keep the set small and never
 * renumber (level snapshots and tests depend on the values).
 */
export const Tile = {
  /** Unreachable filler. Never rendered, so it saves fill rate on solid rock. */
  Void: 0,
  Wall: 1,
  Floor: 2,
  /** Functionally floor; kept distinct for decoration and AI hints. */
  Corridor: 3,
  DoorOpen: 4,
  /** Challenge/vault doors. Becomes DoorOpen when the room is cleared. */
  DoorSealed: 5,
  StairsDown: 6,
  StairsUp: 7,
  /** Lava / spike plate / spore vent — the biome decides what it means. */
  HazardStatic: 8,
  /** Crumbling floor / thin ice. One-shot state change on contact. */
  HazardVolatile: 9,
  /** Impassable to ground units, passable to flyers. */
  Pit: 10,
  /** Slows movement, blocks projectiles, destructible. */
  Rubble: 11,
  ShallowLiquid: 12,
  /** Decorative blocker: pillar, machine, stalagmite. */
  Prop: 13,
} as const;
export type TileId = (typeof Tile)[keyof typeof Tile];

export const TILE_COUNT = 14;

/** Blocks everything, flying included. */
export const SOLID = new Uint8Array(256);
/** Blocks ground movement only. */
export const GROUND_BLOCKED = new Uint8Array(256);
/** Stops projectiles. */
export const BLOCKS_SHOT = new Uint8Array(256);
/** Generation treats these as reachable space. */
export const WALKABLE = new Uint8Array(256);
/** Movement speed multiplier, 1 = normal. */
export const TILE_DRAG = new Float32Array(256).fill(1);

for (const t of [Tile.Void, Tile.Wall, Tile.DoorSealed, Tile.Prop]) {
  SOLID[t] = 1;
  GROUND_BLOCKED[t] = 1;
  BLOCKS_SHOT[t] = 1;
}
GROUND_BLOCKED[Tile.Pit] = 1;
BLOCKS_SHOT[Tile.Rubble] = 1;

for (const t of [
  Tile.Floor,
  Tile.Corridor,
  Tile.DoorOpen,
  Tile.StairsDown,
  Tile.StairsUp,
  Tile.HazardStatic,
  Tile.HazardVolatile,
  Tile.ShallowLiquid,
  Tile.Rubble,
]) {
  WALKABLE[t] = 1;
}

TILE_DRAG[Tile.Rubble] = 0.6;
TILE_DRAG[Tile.ShallowLiquid] = 0.8;

/** True for tiles that read as open ground when drawing floors. */
export function isFloorish(t: number): boolean {
  return WALKABLE[t] === 1 || t === Tile.Pit;
}

export class Tilemap {
  readonly w: number;
  readonly h: number;
  readonly t: Uint8Array;
  /** Per-tile 0-255 hash, for deterministic visual jitter that never flickers. */
  readonly variant: Uint8Array;

  constructor(w: number, h: number, fill: TileId = Tile.Wall) {
    this.w = w;
    this.h = h;
    this.t = new Uint8Array(w * h).fill(fill);
    this.variant = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        this.variant[y * w + x] = hash2(x, y) & 0xff;
      }
    }
  }

  /** Out of bounds reads as Wall, so no border special-casing anywhere else. */
  at(tx: number, ty: number): number {
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return Tile.Wall;
    return this.t[ty * this.w + tx];
  }

  set(tx: number, ty: number, id: TileId): void {
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return;
    this.t[ty * this.w + tx] = id;
  }

  variantAt(tx: number, ty: number): number {
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return 0;
    return this.variant[ty * this.w + tx];
  }

  inBounds(tx: number, ty: number): boolean {
    return tx >= 0 && ty >= 0 && tx < this.w && ty < this.h;
  }

  isSolid(tx: number, ty: number): boolean {
    return SOLID[this.at(tx, ty)] === 1;
  }

  /** Movement blocker for an entity. Flyers cross pits. */
  isBlocked(tx: number, ty: number, flying = false): boolean {
    const t = this.at(tx, ty);
    return flying ? SOLID[t] === 1 : GROUND_BLOCKED[t] === 1;
  }

  isWalkable(tx: number, ty: number): boolean {
    return WALKABLE[this.at(tx, ty)] === 1;
  }

  blocksShot(tx: number, ty: number): boolean {
    return BLOCKS_SHOT[this.at(tx, ty)] === 1;
  }

  dragAt(wx: number, wy: number): number {
    return TILE_DRAG[this.at(Math.floor(wx / TILE), Math.floor(wy / TILE))];
  }

  /** World coords -> tile id. */
  atWorld(wx: number, wy: number): number {
    return this.at(Math.floor(wx / TILE), Math.floor(wy / TILE));
  }

  /** Count of walkable tiles. Used to size enemy budgets. */
  countWalkable(): number {
    let n = 0;
    for (let i = 0; i < this.t.length; i++) if (WALKABLE[this.t[i]] === 1) n++;
    return n;
  }

  /** 8-neighbour wall count, used by the cave smoothing pass. */
  wallNeighbors8(tx: number, ty: number): number {
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        if (!this.isWalkable(tx + dx, ty + dy)) n++;
      }
    }
    return n;
  }

  /**
   * Bitmask of walkable neighbours: 1=N 2=E 4=S 8=W 16=NE 32=SE 64=SW 128=NW.
   * Wall art uses this to fake height and round corners.
   */
  neighborMask(tx: number, ty: number): number {
    let m = 0;
    if (isFloorish(this.at(tx, ty - 1))) m |= 1;
    if (isFloorish(this.at(tx + 1, ty))) m |= 2;
    if (isFloorish(this.at(tx, ty + 1))) m |= 4;
    if (isFloorish(this.at(tx - 1, ty))) m |= 8;
    if (isFloorish(this.at(tx + 1, ty - 1))) m |= 16;
    if (isFloorish(this.at(tx + 1, ty + 1))) m |= 32;
    if (isFloorish(this.at(tx - 1, ty + 1))) m |= 64;
    if (isFloorish(this.at(tx - 1, ty - 1))) m |= 128;
    return m;
  }

  /**
   * DDA line-of-sight between two world points. Returns false if a
   * shot-blocking tile is in the way. ~30 lines and only ever called on
   * candidates that already passed a cheaper test.
   */
  rayClear(x0: number, y0: number, x1: number, y1: number): boolean {
    let tx = Math.floor(x0 / TILE);
    let ty = Math.floor(y0 / TILE);
    const ex = Math.floor(x1 / TILE);
    const ey = Math.floor(y1 / TILE);
    if (this.blocksShot(tx, ty)) return false;
    if (tx === ex && ty === ey) return true;

    const dx = x1 - x0;
    const dy = y1 - y0;
    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const invDx = dx === 0 ? Infinity : Math.abs(TILE / dx);
    const invDy = dy === 0 ? Infinity : Math.abs(TILE / dy);

    const fracX = x0 / TILE - tx;
    const fracY = y0 / TILE - ty;
    let tMaxX = dx === 0 ? Infinity : invDx * (dx > 0 ? 1 - fracX : fracX);
    let tMaxY = dy === 0 ? Infinity : invDy * (dy > 0 ? 1 - fracY : fracY);

    // Bound the walk so a degenerate ray can never spin forever.
    const maxSteps = Math.abs(ex - tx) + Math.abs(ey - ty) + 2;
    for (let i = 0; i < maxSteps; i++) {
      if (tMaxX < tMaxY) {
        tx += stepX;
        tMaxX += invDx;
      } else {
        ty += stepY;
        tMaxY += invDy;
      }
      if (this.blocksShot(tx, ty)) return false;
      if (tx === ex && ty === ey) return true;
    }
    return true;
  }
}
