import { MAX_DPR, TARGET_VIEW_HEIGHT, TILE } from '../core/constants';
import { lerp, scratchB } from '../core/math';
import type { Palette, WallStyleId } from '../content/types/biome';
import type { Camera } from './camera';
import { shakeOffset } from './camera';
import { LightBuffer } from './lighting';
import { buildTileAtlas, type TileAtlas, type TileView } from './tileart';

/**
 * Owns the canvas, the DPI/zoom maths, and the world<->screen transform.
 *
 * Crispness comes from three things together, and dropping any one of them is
 * visible: integer zoom, `imageSmoothingEnabled = false`, and snapping the
 * camera to whole device pixels. Without the snap, tiles shimmer and crawl as
 * you walk.
 */
export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly lights = new LightBuffer();

  /** Integer world-px -> CSS-px zoom. */
  zoom = 3;
  dpr = 1;
  /** zoom * dpr. Integer, so blits stay pixel-exact. */
  scale = 3;
  /** Visible world size, in world px. */
  viewW = 640;
  viewH = 360;

  atlas: TileAtlas | null = null;
  private atlasKey = '';

  /** Interpolated, pixel-snapped camera position for this frame. */
  camX = 0;
  camY = 0;
  private shakeX = 0;
  private shakeY = 0;

  private readonly view: TileView = { tx0: 0, ty0: 0, tx1: 0, ty1: 0 };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) throw new Error('Canvas 2D is unavailable in this browser');
    this.ctx = ctx;
    this.resize();
  }

  resize(): void {
    const cssW = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const cssH = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    // Cap DPR: a 3x phone triples fill cost for imperceptible gain.
    this.dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);

    const pxW = Math.max(1, Math.round(cssW * this.dpr));
    const pxH = Math.max(1, Math.round(cssH * this.dpr));
    if (this.canvas.width !== pxW || this.canvas.height !== pxH) {
      this.canvas.width = pxW;
      this.canvas.height = pxH;
    }

    // Integer zoom derived from a target logical height. Narrow viewports get a
    // step less zoom so a phone doesn't end up looking through a keyhole.
    const wanted = cssH / TARGET_VIEW_HEIGHT;
    this.zoom = Math.max(1, Math.floor(wanted) || 1);
    if (cssW < 620 && this.zoom > 2) this.zoom -= 1;

    this.scale = this.zoom * this.dpr;
    this.viewW = pxW / this.scale;
    this.viewH = pxH / this.scale;

    this.ctx.imageSmoothingEnabled = false;
    this.lights.resize(pxW, pxH);
  }

  /** Rebuild the tile atlas when the biome changes. Cheap, and idempotent. */
  setBiome(palette: Palette, style: WallStyleId): void {
    const key = `${style}|${palette.wallFace}|${palette.floorA}|${palette.accent}`;
    if (this.atlasKey === key && this.atlas) return;
    this.atlas = buildTileAtlas(palette, style);
    this.atlasKey = key;
  }

  get width(): number {
    return this.canvas.width;
  }

  get height(): number {
    return this.canvas.height;
  }

  /**
   * Establish the world transform for this frame.
   *
   * `alpha` is the fraction of a sim step we are through, used to interpolate
   * the camera the same way entities are interpolated.
   */
  beginWorld(cam: Camera, alpha: number): void {
    const rawX = lerp(cam.px, cam.x, alpha);
    const rawY = lerp(cam.py, cam.y, alpha);
    // Snap to whole device pixels. This is the anti-shimmer step.
    this.camX = Math.round(rawX * this.scale) / this.scale;
    this.camY = Math.round(rawY * this.scale) / this.scale;

    // Shake is applied AFTER the snap and may be fractional — it is motion, so
    // subpixel is fine and actually smoother.
    shakeOffset(cam, scratchB);
    this.shakeX = scratchB.x * this.scale;
    this.shakeY = scratchB.y * this.scale;

    const c = this.ctx;
    c.setTransform(
      this.scale,
      0,
      0,
      this.scale,
      -this.camX * this.scale + this.canvas.width * 0.5 + this.shakeX,
      -this.camY * this.scale + this.canvas.height * 0.5 + this.shakeY,
    );
  }

  beginScreen(): void {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** Fill the whole canvas, ignoring any world transform. */
  clear(color: string): void {
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = color;
    c.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  worldToScreenX(wx: number): number {
    return (wx - this.camX) * this.scale + this.canvas.width * 0.5 + this.shakeX;
  }

  worldToScreenY(wy: number): number {
    return (wy - this.camY) * this.scale + this.canvas.height * 0.5 + this.shakeY;
  }

  /** CSS pixels (from a pointer event) -> world coordinates. */
  screenToWorldX(cssX: number): number {
    return (cssX * this.dpr - this.canvas.width * 0.5) / this.scale + this.camX;
  }

  screenToWorldY(cssY: number): number {
    return (cssY * this.dpr - this.canvas.height * 0.5) / this.scale + this.camY;
  }

  /** Tile range covering the viewport, with one tile of bleed. */
  tileView(mapW: number, mapH: number): TileView {
    const halfW = this.viewW * 0.5;
    const halfH = this.viewH * 0.5;
    const v = this.view;
    v.tx0 = Math.max(0, Math.floor((this.camX - halfW) / TILE) - 1);
    v.ty0 = Math.max(0, Math.floor((this.camY - halfH) / TILE) - 1);
    v.tx1 = Math.min(mapW - 1, Math.ceil((this.camX + halfW) / TILE) + 1);
    v.ty1 = Math.min(mapH - 1, Math.ceil((this.camY + halfH) / TILE) + 1);
    return v;
  }

  /** Is this world-space circle worth drawing? */
  visible(wx: number, wy: number, radius: number): boolean {
    const pad = radius + 24;
    return (
      Math.abs(wx - this.camX) < this.viewW * 0.5 + pad &&
      Math.abs(wy - this.camY) < this.viewH * 0.5 + pad
    );
  }

  // --------------------------------------------------------------- lighting

  beginLights(ambient: string): void {
    this.lights.begin(ambient);
  }

  /** Add a light using WORLD coordinates; conversion happens here. */
  addWorldLight(
    wx: number,
    wy: number,
    radiusWorld: number,
    intensity: number,
    tint: number,
  ): void {
    const div = this.lights.scaleDiv;
    const sx = ((wx - this.camX) * this.scale + this.canvas.width * 0.5 + this.shakeX) / div;
    const sy = ((wy - this.camY) * this.scale + this.canvas.height * 0.5 + this.shakeY) / div;
    this.lights.addLight(sx, sy, (radiusWorld * this.scale) / div, intensity, tint);
  }

  compositeLights(): void {
    this.lights.composite(this.ctx, this.canvas.width, this.canvas.height);
  }

  // ------------------------------------------------------------ text helpers

  private textWidths = new Map<string, number>();

  /**
   * `measureText` is surprisingly slow, and HUD strings repeat every frame.
   * Cache by font + string.
   */
  measure(text: string, font: string): number {
    const key = `${font}|${text}`;
    const hit = this.textWidths.get(key);
    if (hit !== undefined) return hit;
    this.ctx.font = font;
    const w = this.ctx.measureText(text).width;
    if (this.textWidths.size < 2048) this.textWidths.set(key, w);
    return w;
  }

  /** Text with a 1px offset drop shadow. Readable over any background. */
  text(
    str: string,
    x: number,
    y: number,
    font: string,
    color: string,
    align: CanvasTextAlign = 'left',
    baseline: CanvasTextBaseline = 'alphabetic',
    shadow = 'rgba(0,0,0,0.7)',
  ): void {
    const c = this.ctx;
    c.font = font;
    c.textAlign = align;
    c.textBaseline = baseline;
    if (shadow) {
      c.fillStyle = shadow;
      c.fillText(str, x + 1.5, y + 1.5);
    }
    c.fillStyle = color;
    c.fillText(str, x, y);
  }
}
