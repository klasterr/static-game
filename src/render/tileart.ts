import { TILE } from '../core/constants';
import { TAU, hash2 } from '../core/math';
import type { Palette, WallStyleId } from '../content/types/biome';
import { withAlpha } from '../content/types/biome';
import { Tile, Tilemap, isFloorish } from '../world/tiles';

/**
 * Tiles are baked once per biome into an offscreen atlas, then blitted.
 *
 * The alternative — 4-8 `fillRect`s per tile per frame with `fillStyle`
 * changes — is 1,500-2,500 state changes per frame and costs 4-8ms. Blitting
 * ~310 cells from a single source canvas costs about 0.6ms. Bake the atlas.
 *
 * Cells are always 32x32 world px; the integer zoom lives in the canvas
 * transform, so the atlas never needs rebuilding on resize.
 */

const Cell = {
  FloorA: 0,
  FloorB: 1,
  Corridor: 2,
  /** Wall with more wall below it: just the top surface. */
  WallTop: 3,
  /** Wall with floor below it: top cap + vertical face + edge highlight. */
  WallFace: 4,
  DoorOpen: 5,
  DoorSealed: 6,
  StairsDown: 7,
  StairsUp: 8,
  HazardBase: 9,
  VolatileBase: 10,
  Pit: 11,
  Rubble: 12,
  Liquid: 13,
  Prop: 14,
} as const;
type CellId = (typeof Cell)[keyof typeof Cell];

const CELL_ROWS = 15;
const VARIANTS = 3;

export interface TileAtlas {
  canvas: HTMLCanvasElement;
  /** Height of the fake wall cap, in world px. */
  capHeight: number;
}

function cellSrcX(variant: number): number {
  return variant * TILE;
}

function cellSrcY(cell: CellId): number {
  return cell * TILE;
}

/** Deterministic pseudo-random from a cell + index. Never `Math.random` here. */
function jitter(variant: number, i: number): number {
  return (hash2(variant * 977 + i, i * 31 + 7) % 10000) / 10000;
}

export function buildTileAtlas(palette: Palette, style: WallStyleId): TileAtlas {
  const canvas = document.createElement('canvas');
  canvas.width = TILE * VARIANTS;
  canvas.height = TILE * CELL_ROWS;
  const c = canvas.getContext('2d');
  if (!c) throw new Error('2D context unavailable for the tile atlas');

  c.imageSmoothingEnabled = false;
  const capHeight = 7;

  for (let v = 0; v < VARIANTS; v++) {
    const ox = cellSrcX(v);

    drawFloorCell(c, ox, cellSrcY(Cell.FloorA), v, palette, style, palette.floorA);
    drawFloorCell(c, ox, cellSrcY(Cell.FloorB), v, palette, style, palette.floorB);

    // Corridor: floor A plus the biome's corridor tint on top.
    drawFloorCell(c, ox, cellSrcY(Cell.Corridor), v, palette, style, palette.floorA);
    c.fillStyle = palette.corridorTint;
    c.fillRect(ox, cellSrcY(Cell.Corridor), TILE, TILE);

    drawWallTop(c, ox, cellSrcY(Cell.WallTop), v, palette, style);
    drawWallFace(c, ox, cellSrcY(Cell.WallFace), v, palette, style, capHeight);

    drawDoor(c, ox, cellSrcY(Cell.DoorOpen), palette, false);
    drawDoor(c, ox, cellSrcY(Cell.DoorSealed), palette, true);

    drawStairs(c, ox, cellSrcY(Cell.StairsDown), palette, true);
    drawStairs(c, ox, cellSrcY(Cell.StairsUp), palette, false);

    // Hazard and volatile bases; the animated part is overlaid at draw time.
    drawFloorCell(c, ox, cellSrcY(Cell.HazardBase), v, palette, style, palette.floorB);
    c.fillStyle = withAlpha(palette.hazard, 0.22);
    c.fillRect(ox, cellSrcY(Cell.HazardBase), TILE, TILE);

    drawFloorCell(c, ox, cellSrcY(Cell.VolatileBase), v, palette, style, palette.floorA);

    drawPit(c, ox, cellSrcY(Cell.Pit), palette);
    drawRubble(c, ox, cellSrcY(Cell.Rubble), v, palette);
    drawLiquid(c, ox, cellSrcY(Cell.Liquid), v, palette);
    drawProp(c, ox, cellSrcY(Cell.Prop), v, palette, style);
  }

  return { canvas, capHeight };
}

// ------------------------------------------------------------- cell painters

function drawFloorCell(
  c: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  v: number,
  p: Palette,
  style: WallStyleId,
  base: string,
): void {
  c.fillStyle = base;
  c.fillRect(ox, oy, TILE, TILE);

  if (style === 'organic') {
    // Mottled cave floor: three soft blotches.
    for (let i = 0; i < 3; i++) {
      const x = ox + jitter(v, i * 3 + 1) * TILE;
      const y = oy + jitter(v, i * 3 + 2) * TILE;
      const r = 4 + jitter(v, i * 3 + 3) * 6;
      c.fillStyle = withAlpha(p.floorSeam, 0.35);
      c.beginPath();
      c.ellipse(x, y, r, r * 0.7, jitter(v, i + 11) * TAU, 0, TAU);
      c.fill();
    }
  } else {
    // Flagstone: a mortar cross with a per-variant offset.
    const cx = ox + 6 + Math.floor(jitter(v, 1) * 20);
    const cy = oy + 6 + Math.floor(jitter(v, 2) * 20);
    c.fillStyle = p.floorSeam;
    c.fillRect(ox, cy, TILE, 1);
    c.fillRect(cx, oy, 1, TILE);
  }

  // Speckle. Deterministic positions, so the floor has noise with zero storage.
  for (let i = 0; i < 7; i++) {
    const x = ox + Math.floor(jitter(v, 20 + i * 2) * TILE);
    const y = oy + Math.floor(jitter(v, 21 + i * 2) * TILE);
    const light = jitter(v, 40 + i) > 0.55;
    c.fillStyle = withAlpha(light ? p.accent : p.floorSeam, light ? 0.07 : 0.3);
    c.fillRect(x, y, 1, 1);
  }
}

function drawWallTop(
  c: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  v: number,
  p: Palette,
  style: WallStyleId,
): void {
  c.fillStyle = p.wallTop;
  c.fillRect(ox, oy, TILE, TILE);
  paintWallDetail(c, ox, oy, v, p, style, TILE);
}

function drawWallFace(
  c: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  v: number,
  p: Palette,
  style: WallStyleId,
  capHeight: number,
): void {
  // Top cap, then the vertical face below it, then a bright edge between them.
  // This one trick reads as height and beats naive autotiling for a fraction of
  // the work.
  c.fillStyle = p.wallTop;
  c.fillRect(ox, oy, TILE, capHeight);
  c.fillStyle = p.wallFace;
  c.fillRect(ox, oy + capHeight, TILE, TILE - capHeight);
  c.fillStyle = p.wallEdge;
  c.fillRect(ox, oy + capHeight - 1, TILE, 1);

  paintWallDetail(c, ox, oy + capHeight, v, p, style, TILE - capHeight);

  // Ambient occlusion under the cap so the face reads as recessed.
  c.fillStyle = 'rgba(0,0,0,0.22)';
  c.fillRect(ox, oy + capHeight, TILE, 2);
}

function paintWallDetail(
  c: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  v: number,
  p: Palette,
  style: WallStyleId,
  h: number,
): void {
  switch (style) {
    case 'mortar': {
      // Brick courses with a per-variant stagger, plus rare skull glyphs.
      c.fillStyle = withAlpha(p.floorSeam, 0.55);
      const rows = 3;
      for (let r = 1; r < rows; r++) {
        const y = oy + Math.round((h / rows) * r);
        c.fillRect(ox, y, TILE, 1);
      }
      const stagger = jitter(v, 5) > 0.5 ? 0 : 16;
      for (let r = 0; r < rows; r++) {
        const y0 = oy + Math.round((h / rows) * r);
        const y1 = oy + Math.round((h / rows) * (r + 1));
        const x = ox + ((r % 2 === 0 ? 16 : 0) + stagger) % TILE;
        c.fillRect(x, y0, 1, y1 - y0);
      }
      if (v === 2 && h > 18) {
        // One variant in three carries a bone motif: a skull cranium, two eye
        // sockets and a jaw notch. Cheap flavour, strong biome identity.
        const cx = ox + 16;
        const cy = oy + Math.round(h * 0.5);
        c.fillStyle = withAlpha(p.accent, 0.3);
        c.beginPath();
        c.arc(cx, cy - 2, 5, 0, TAU);
        c.fill();
        c.fillRect(cx - 3, cy + 3, 6, 3);
        c.fillStyle = withAlpha(p.bgDeep, 0.75);
        c.fillRect(cx - 3, cy - 3, 2, 2);
        c.fillRect(cx + 1, cy - 3, 2, 2);
      }
      break;
    }
    case 'organic': {
      // Rounded, wet-looking rock with clustered glowing spore dots.
      c.fillStyle = withAlpha(p.bgDeep, 0.25);
      c.beginPath();
      c.ellipse(ox + 16, oy + h, 20, h * 0.5, 0, 0, TAU);
      c.fill();
      for (let i = 0; i < 3; i++) {
        const x = ox + 5 + jitter(v, 60 + i * 2) * 22;
        const y = oy + 3 + jitter(v, 61 + i * 2) * Math.max(2, h - 6);
        const r = 1 + jitter(v, 70 + i) * 1.6;
        c.fillStyle = withAlpha(p.accentGlow, 0.75);
        c.beginPath();
        c.arc(x, y, r, 0, TAU);
        c.fill();
      }
      break;
    }
    case 'plate': {
      // Riveted steel plate with a horizontal seam.
      c.fillStyle = withAlpha(p.bgDeep, 0.4);
      c.fillRect(ox, oy + Math.round(h * 0.6), TILE, 1);
      c.fillStyle = withAlpha(p.wallEdge, 0.5);
      for (const [dx, dy] of [
        [4, 4],
        [TILE - 5, 4],
        [4, h - 5],
        [TILE - 5, h - 5],
      ]) {
        if (dy < 1 || dy > h - 1) continue;
        c.beginPath();
        c.arc(ox + dx, oy + dy, 1.4, 0, TAU);
        c.fill();
      }
      if (v === 1 && h > 14) {
        c.fillStyle = withAlpha(p.accentGlow, 0.6);
        c.fillRect(ox + 15, oy + 4, 2, h - 8);
      }
      break;
    }
    case 'faceted': {
      // Two triangles with a lightness delta, plus one specular line.
      const flip = jitter(v, 3) > 0.5;
      c.fillStyle = withAlpha('#ffffff', 0.09);
      c.beginPath();
      if (flip) {
        c.moveTo(ox, oy);
        c.lineTo(ox + TILE, oy);
        c.lineTo(ox, oy + h);
      } else {
        c.moveTo(ox + TILE, oy);
        c.lineTo(ox + TILE, oy + h);
        c.lineTo(ox, oy);
      }
      c.closePath();
      c.fill();
      c.strokeStyle = withAlpha(p.wallEdge, 0.8);
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(ox + (flip ? 0 : TILE), oy + h);
      c.lineTo(ox + (flip ? TILE : 0), oy);
      c.stroke();
      break;
    }
  }
}

function drawDoor(
  c: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  p: Palette,
  sealed: boolean,
): void {
  c.fillStyle = p.floorA;
  c.fillRect(ox, oy, TILE, TILE);
  c.fillStyle = withAlpha(p.bgDeep, 0.35);
  c.fillRect(ox, oy, TILE, TILE);
  // Jambs on the left and right so a doorway reads as a threshold.
  c.fillStyle = p.wallFace;
  c.fillRect(ox, oy, 3, TILE);
  c.fillRect(ox + TILE - 3, oy, 3, TILE);
  c.fillStyle = sealed ? p.hazardWarn : p.accent;
  c.globalAlpha = sealed ? 0.85 : 0.35;
  c.fillRect(ox + 3, oy + 14, TILE - 6, 4);
  c.globalAlpha = 1;
}

function drawStairs(
  c: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  p: Palette,
  down: boolean,
): void {
  c.fillStyle = down ? p.bgDeep : p.floorB;
  c.fillRect(ox, oy, TILE, TILE);
  const steps = 5;
  for (let i = 0; i < steps; i++) {
    const t = i / steps;
    const inset = down ? t * 12 : (1 - t) * 12;
    const shade = down ? 0.14 + t * 0.16 : 0.3 - t * 0.16;
    c.fillStyle = withAlpha(p.wallTop, shade + 0.35);
    c.fillRect(ox + inset, oy + i * (TILE / steps), TILE - inset * 2, TILE / steps - 1);
  }
  if (down) {
    // Cold rim light so the exit is legible from across a dark room.
    c.strokeStyle = withAlpha('#d6f0ff', 0.65);
    c.lineWidth = 1.5;
    c.strokeRect(ox + 2.5, oy + 2.5, TILE - 5, TILE - 5);
  }
}

function drawPit(c: CanvasRenderingContext2D, ox: number, oy: number, p: Palette): void {
  c.fillStyle = '#000000';
  c.fillRect(ox, oy, TILE, TILE);
  // Faint inner rim, so the edge of a pit is readable at speed.
  c.fillStyle = withAlpha(p.wallFace, 0.5);
  c.fillRect(ox, oy, TILE, 2);
  c.fillStyle = withAlpha(p.bgDeep, 0.6);
  c.fillRect(ox, oy + 2, TILE, 3);
}

function drawRubble(
  c: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  v: number,
  p: Palette,
): void {
  c.fillStyle = p.floorB;
  c.fillRect(ox, oy, TILE, TILE);
  for (let i = 0; i < 7; i++) {
    const x = ox + 3 + jitter(v, 90 + i * 2) * 26;
    const y = oy + 3 + jitter(v, 91 + i * 2) * 26;
    const s = 2 + jitter(v, 100 + i) * 4;
    c.fillStyle = i % 2 === 0 ? p.wallFace : p.wallTop;
    c.beginPath();
    c.moveTo(x, y - s);
    c.lineTo(x + s, y);
    c.lineTo(x, y + s * 0.8);
    c.lineTo(x - s * 0.9, y);
    c.closePath();
    c.fill();
  }
}

function drawLiquid(
  c: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  v: number,
  p: Palette,
): void {
  c.fillStyle = p.liquid;
  c.fillRect(ox, oy, TILE, TILE);
  c.fillStyle = withAlpha('#ffffff', 0.07);
  for (let i = 0; i < 3; i++) {
    const y = oy + 4 + jitter(v, 120 + i) * 24;
    c.fillRect(ox + 2, y, TILE - 4, 1);
  }
}

function drawProp(
  c: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  v: number,
  p: Palette,
  style: WallStyleId,
): void {
  c.fillStyle = p.floorA;
  c.fillRect(ox, oy, TILE, TILE);
  c.fillStyle = 'rgba(0,0,0,0.3)';
  c.beginPath();
  c.ellipse(ox + 16, oy + 26, 11, 5, 0, 0, TAU);
  c.fill();

  if (style === 'organic') {
    // Mushroom stalk with a glowing cap.
    c.fillStyle = p.prop;
    c.fillRect(ox + 13, oy + 12, 6, 14);
    c.fillStyle = p.accentGlow;
    c.beginPath();
    c.ellipse(ox + 16, oy + 12, 10, 7, 0, Math.PI, TAU);
    c.fill();
    c.fillStyle = withAlpha('#ffffff', 0.25);
    c.beginPath();
    c.ellipse(ox + 13, oy + 10, 3, 2, 0, 0, TAU);
    c.fill();
  } else {
    // Stone pillar with a lit top face.
    c.fillStyle = p.prop;
    c.fillRect(ox + 8, oy + 6, 16, 20);
    c.fillStyle = p.wallTop;
    c.fillRect(ox + 8, oy + 4, 16, 5);
    c.fillStyle = p.wallEdge;
    c.fillRect(ox + 8, oy + 3, 16, 1);
    c.fillStyle = withAlpha(p.bgDeep, 0.3);
    c.fillRect(ox + 8 + Math.floor(jitter(v, 130) * 10), oy + 10, 2, 14);
  }
}

// ----------------------------------------------------------------- the pass

/** Which atlas row a tile id maps to, given whether floor sits below it. */
function cellFor(tile: number, faceBelow: boolean, variant: number): CellId {
  switch (tile) {
    case Tile.Wall:
      return faceBelow ? Cell.WallFace : Cell.WallTop;
    case Tile.Floor:
      return variant % 2 === 0 ? Cell.FloorA : Cell.FloorB;
    case Tile.Corridor:
      return Cell.Corridor;
    case Tile.DoorOpen:
      return Cell.DoorOpen;
    case Tile.DoorSealed:
      return Cell.DoorSealed;
    case Tile.StairsDown:
      return Cell.StairsDown;
    case Tile.StairsUp:
      return Cell.StairsUp;
    case Tile.HazardStatic:
      return Cell.HazardBase;
    case Tile.HazardVolatile:
      return Cell.VolatileBase;
    case Tile.Pit:
      return Cell.Pit;
    case Tile.Rubble:
      return Cell.Rubble;
    case Tile.ShallowLiquid:
      return Cell.Liquid;
    case Tile.Prop:
      return Cell.Prop;
    default:
      return Cell.FloorA;
  }
}

export interface TileView {
  tx0: number;
  ty0: number;
  tx1: number;
  ty1: number;
}

/**
 * Blit every visible tile. `Tile.Void` is skipped entirely — solid rock beyond
 * the playable area never needs a draw call.
 *
 * Returns the number of blits, for the dev overlay.
 */
export function drawTiles(
  c: CanvasRenderingContext2D,
  map: Tilemap,
  atlas: TileAtlas,
  view: TileView,
): number {
  const img = atlas.canvas;
  let blits = 0;

  for (let ty = view.ty0; ty <= view.ty1; ty++) {
    for (let tx = view.tx0; tx <= view.tx1; tx++) {
      const tile = map.at(tx, ty);
      if (tile === Tile.Void) continue;

      const variant = map.variantAt(tx, ty) % 3;
      const faceBelow = tile === Tile.Wall && isFloorish(map.at(tx, ty + 1));
      const cell = cellFor(tile, faceBelow, map.variantAt(tx, ty));

      c.drawImage(
        img,
        cellSrcX(variant),
        cellSrcY(cell),
        TILE,
        TILE,
        tx * TILE,
        ty * TILE,
        TILE,
        TILE,
      );
      blits++;
    }
  }
  return blits;
}
