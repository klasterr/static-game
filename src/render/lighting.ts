import { LIGHT_DOWNGRADE_PIXELS } from '../core/constants';

/**
 * Torch-light falloff.
 *
 * Technique: accumulate additive lights into a half-resolution offscreen
 * canvas, then composite it over the finished frame with `multiply`.
 *
 * Why this and not per-tile darkening:
 *  - It lights ENTITIES as well as tiles. Per-tile darkening makes enemies look
 *    pasted on top of the dark.
 *  - Additive accumulation mixes overlapping lights correctly, so a green
 *    fungal glow next to a warm torch bleeds the way you'd hope.
 *  - `multiply` is the physically sensible operator for "how much light reaches
 *    this pixel", and it preserves the biome palette instead of washing it out
 *    the way `screen`/`lighter` over a black mask does.
 *  - Half resolution is free quality: the light field is low-frequency, so a
 *    smoothed upscale gives softer falloff than full-res would, at a quarter of
 *    the fill cost.
 */

export const Tint = {
  Warm: 0,
  Cold: 1,
  Green: 2,
  Purple: 3,
  White: 4,
  Red: 5,
} as const;
export type TintId = (typeof Tint)[keyof typeof Tint];

interface TintSpec {
  core: string;
  mid: string;
  edge: string;
}

const TINTS: TintSpec[] = [
  // Warm torch
  { core: 'rgba(255,226,170,1)', mid: 'rgba(255,170,90,0.55)', edge: 'rgba(255,140,60,0)' },
  // Cold cyan — used for stairs so they are findable across a dark room
  { core: 'rgba(214,240,255,1)', mid: 'rgba(140,200,240,0.55)', edge: 'rgba(90,160,220,0)' },
  // Spore green
  { core: 'rgba(206,255,214,1)', mid: 'rgba(126,242,161,0.5)', edge: 'rgba(60,200,120,0)' },
  // Glowing cap purple
  { core: 'rgba(235,210,255,1)', mid: 'rgba(180,108,240,0.5)', edge: 'rgba(120,60,200,0)' },
  // Neutral white
  { core: 'rgba(255,255,255,1)', mid: 'rgba(230,230,230,0.5)', edge: 'rgba(200,200,200,0)' },
  // Danger red
  { core: 'rgba(255,220,200,1)', mid: 'rgba(255,110,70,0.55)', edge: 'rgba(200,40,30,0)' },
];

const SPRITE_SIZE = 128;

export class LightBuffer {
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private sprites: HTMLCanvasElement[] = [];

  /** Resolution divisor. Bumped to 3 on very large canvases. */
  private div = 2;
  private w = 1;
  private h = 1;

  /** Set false to skip lighting entirely (debug view). */
  enabled = true;

  constructor() {
    this.canvas = document.createElement('canvas');
    const g = this.canvas.getContext('2d', { alpha: false });
    if (!g) throw new Error('2D context unavailable for the light buffer');
    this.g = g;
    this.bakeSprites();
  }

  /**
   * Bake one radial-gradient sprite per tint, ONCE.
   * `createRadialGradient` in a per-frame loop is a classic 4ms mistake.
   */
  private bakeSprites(): void {
    for (const tint of TINTS) {
      const s = document.createElement('canvas');
      s.width = SPRITE_SIZE;
      s.height = SPRITE_SIZE;
      const g = s.getContext('2d');
      if (!g) continue;
      const half = SPRITE_SIZE / 2;
      const grad = g.createRadialGradient(half, half, 0, half, half, half);
      grad.addColorStop(0, tint.core);
      grad.addColorStop(0.45, tint.mid);
      grad.addColorStop(1, tint.edge);
      g.fillStyle = grad;
      g.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
      this.sprites.push(s);
    }
  }

  /** Called from the renderer's resize path. `cw/ch` are device pixels. */
  resize(cw: number, ch: number): void {
    this.div = cw * ch > LIGHT_DOWNGRADE_PIXELS ? 3 : 2;
    this.w = Math.max(1, Math.ceil(cw / this.div));
    this.h = Math.max(1, Math.ceil(ch / this.div));
    this.canvas.width = this.w;
    this.canvas.height = this.h;
  }

  /** Scale factor from device pixels to light-buffer pixels. */
  get scaleDiv(): number {
    return this.div;
  }

  /** Fill with the ambient level, then switch to additive accumulation. */
  begin(ambient: string): void {
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.fillStyle = ambient;
    g.fillRect(0, 0, this.w, this.h);
    g.globalCompositeOperation = 'lighter';
  }

  /**
   * Add a light. `sx/sy/radius` are in LIGHT-BUFFER pixels — the renderer does
   * the world-to-buffer conversion so this stays a pure blit.
   */
  addLight(sx: number, sy: number, radius: number, intensity: number, tint: number): void {
    if (radius <= 0 || intensity <= 0) return;
    // Cull off-buffer lights; a big level has far more torches than are visible.
    if (sx + radius < 0 || sy + radius < 0 || sx - radius > this.w || sy - radius > this.h) {
      return;
    }
    const sprite = this.sprites[tint] ?? this.sprites[Tint.White];
    if (!sprite) return;
    const g = this.g;
    g.globalAlpha = Math.min(1, intensity);
    g.drawImage(sprite, sx - radius, sy - radius, radius * 2, radius * 2);
  }

  /**
   * Multiply the light layer over the frame.
   *
   * Note the explicit `imageSmoothingEnabled` on both sides: the light layer
   * WANTS a smooth upscale, everything else wants nearest-neighbour. Leaving it
   * on afterwards makes the whole next frame blurry.
   */
  composite(c: CanvasRenderingContext2D, cw: number, ch: number): void {
    const g = this.g;
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';

    c.setTransform(1, 0, 0, 1, 0, 0);
    c.imageSmoothingEnabled = true;
    c.globalCompositeOperation = 'multiply';
    c.globalAlpha = 1;
    c.drawImage(this.canvas, 0, 0, cw, ch);
    c.globalCompositeOperation = 'source-over';
    c.imageSmoothingEnabled = false;
  }

  /** Debug: draw the raw light buffer instead of multiplying it. */
  debugBlit(c: CanvasRenderingContext2D, cw: number, ch: number): void {
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.imageSmoothingEnabled = true;
    c.globalCompositeOperation = 'source-over';
    c.drawImage(this.canvas, 0, 0, cw, ch);
    c.imageSmoothingEnabled = false;
  }
}

/**
 * Two-frequency flicker. Four lines, and it sells the entire effect — a
 * perfectly steady torch reads as a flashlight.
 */
export function flicker(timeMs: number, seed = 0): number {
  const t = timeMs + seed * 137;
  return 1 + 0.045 * Math.sin(t * 0.011) + 0.03 * Math.sin(t * 0.0173 + 1.7);
}
