import { MAX_DAMAGE_NUMBERS, MAX_DECALS, MAX_PARTICLES } from '../core/constants';
import { TAU, clamp01 } from '../core/math';

/**
 * Particles, damage numbers, decals and transient lights.
 *
 * These are NOT entities. They are struct-of-arrays ring buffers: hundreds of
 * them, zero collision, zero per-item object cost, and no GC churn. Oldest is
 * evicted when a buffer fills.
 *
 * Everything here may use `Math.random` freely — it is cosmetic and must never
 * touch a seeded stream.
 */

export const PKind = {
  Dot: 0,
  Spark: 1,
  Streak: 2,
  Ring: 3,
  Chunk: 4,
} as const;
export type PKindId = (typeof PKind)[keyof typeof PKind];

export interface BurstSpec {
  color: string;
  count: number;
  speed: [number, number];
  size: [number, number];
  life: [number, number];
  kind?: PKindId;
  /** Velocity retained per second. 0.02 stops fast, 0.6 drifts. */
  drag?: number;
  gravity?: number;
  /** Constrain emission to a cone around this direction. */
  dirX?: number;
  dirY?: number;
  spread?: number;
  additive?: boolean;
}

/** Interned colour strings. Assigning `fillStyle` from a literal avoids a parse. */
class ColorTable {
  private list: string[] = [];
  private index = new Map<string, number>();

  intern(c: string): number {
    const existing = this.index.get(c);
    if (existing !== undefined) return existing;
    if (this.list.length >= 255) return 0;
    const id = this.list.length;
    this.list.push(c);
    this.index.set(c, id);
    return id;
  }

  get(i: number): string {
    return this.list[i] ?? '#ffffff';
  }
}

export class Fx {
  private colors = new ColorTable();

  // --- particles (SoA)
  private px = new Float32Array(MAX_PARTICLES);
  private py = new Float32Array(MAX_PARTICLES);
  private pvx = new Float32Array(MAX_PARTICLES);
  private pvy = new Float32Array(MAX_PARTICLES);
  private plife = new Float32Array(MAX_PARTICLES);
  private pmax = new Float32Array(MAX_PARTICLES);
  private psize = new Float32Array(MAX_PARTICLES);
  private pdrag = new Float32Array(MAX_PARTICLES);
  private pgrav = new Float32Array(MAX_PARTICLES);
  private pcol = new Uint8Array(MAX_PARTICLES);
  private pkind = new Uint8Array(MAX_PARTICLES);
  private padd = new Uint8Array(MAX_PARTICLES);
  private pHead = 0;
  private pCount = 0;

  // --- damage numbers
  private dnX = new Float32Array(MAX_DAMAGE_NUMBERS);
  private dnY = new Float32Array(MAX_DAMAGE_NUMBERS);
  private dnVy = new Float32Array(MAX_DAMAGE_NUMBERS);
  private dnLife = new Float32Array(MAX_DAMAGE_NUMBERS);
  private dnVal = new Float32Array(MAX_DAMAGE_NUMBERS);
  private dnCrit = new Uint8Array(MAX_DAMAGE_NUMBERS);
  private dnCol = new Uint8Array(MAX_DAMAGE_NUMBERS);
  private dnHead = 0;
  private dnCount = 0;

  // --- floor decals
  private dcX = new Float32Array(MAX_DECALS);
  private dcY = new Float32Array(MAX_DECALS);
  private dcR = new Float32Array(MAX_DECALS);
  private dcRot = new Float32Array(MAX_DECALS);
  private dcAlpha = new Float32Array(MAX_DECALS);
  private dcCol = new Uint8Array(MAX_DECALS);
  private dcHead = 0;
  private dcCount = 0;

  // --- transient lights (explosions, muzzle flashes)
  private tlX = new Float32Array(48);
  private tlY = new Float32Array(48);
  private tlR = new Float32Array(48);
  private tlLife = new Float32Array(48);
  private tlMax = new Float32Array(48);
  private tlTint = new Uint8Array(48);
  private tlCount = 0;

  // --- full-screen flash
  private flashCol = 0;
  private flashAlpha = 0;
  private flashDecay = 1;

  /** Scaled down under sustained frame pressure. Set by the game loop. */
  budget = 1;
  /** Accessibility: disables the full-screen flash for photosensitivity. */
  allowFlashes = true;
  allowDamageNumbers = true;

  clear(): void {
    this.pCount = 0;
    this.pHead = 0;
    this.dnCount = 0;
    this.dnHead = 0;
    this.dcCount = 0;
    this.dcHead = 0;
    this.tlCount = 0;
    this.flashAlpha = 0;
  }

  /** Drop world-space effects but keep interned colours. Called on floor change. */
  clearWorld(): void {
    this.clear();
  }

  get particleCount(): number {
    return this.pCount;
  }

  // ------------------------------------------------------------- emitters

  private nextParticle(): number {
    const i = this.pHead;
    this.pHead = (this.pHead + 1) % MAX_PARTICLES;
    if (this.pCount < MAX_PARTICLES) this.pCount++;
    return i;
  }

  burst(x: number, y: number, spec: BurstSpec): void {
    const n = Math.max(1, Math.round(spec.count * this.budget));
    const col = this.colors.intern(spec.color);
    const kind = spec.kind ?? PKind.Dot;
    const drag = spec.drag ?? 0.08;
    const grav = spec.gravity ?? 0;
    const add = spec.additive ? 1 : 0;
    const hasDir = spec.dirX !== undefined && spec.dirY !== undefined;
    const baseAngle = hasDir ? Math.atan2(spec.dirY!, spec.dirX!) : 0;
    const spread = spec.spread ?? TAU;

    for (let k = 0; k < n; k++) {
      const i = this.nextParticle();
      const angle = hasDir
        ? baseAngle + (Math.random() - 0.5) * spread
        : Math.random() * TAU;
      const speed = spec.speed[0] + Math.random() * (spec.speed[1] - spec.speed[0]);
      const life = spec.life[0] + Math.random() * (spec.life[1] - spec.life[0]);
      this.px[i] = x;
      this.py[i] = y;
      this.pvx[i] = Math.cos(angle) * speed;
      this.pvy[i] = Math.sin(angle) * speed;
      this.plife[i] = life;
      this.pmax[i] = life;
      this.psize[i] = spec.size[0] + Math.random() * (spec.size[1] - spec.size[0]);
      this.pdrag[i] = drag;
      this.pgrav[i] = grav;
      this.pcol[i] = col;
      this.pkind[i] = kind;
      this.padd[i] = add;
    }
  }

  /** One particle with explicit velocity. For trails and ambient emitters. */
  particle(
    x: number,
    y: number,
    vx: number,
    vy: number,
    color: string,
    size: number,
    life: number,
    kind: PKindId = PKind.Dot,
    additive = false,
    drag = 0.08,
    gravity = 0,
  ): void {
    const i = this.nextParticle();
    this.px[i] = x;
    this.py[i] = y;
    this.pvx[i] = vx;
    this.pvy[i] = vy;
    this.plife[i] = life;
    this.pmax[i] = life;
    this.psize[i] = size;
    this.pdrag[i] = drag;
    this.pgrav[i] = gravity;
    this.pcol[i] = this.colors.intern(color);
    this.pkind[i] = kind;
    this.padd[i] = additive ? 1 : 0;
  }

  damageNumber(x: number, y: number, amount: number, crit: boolean, color = '#ffe9c2'): void {
    if (!this.allowDamageNumbers) return;
    const i = this.dnHead;
    this.dnHead = (this.dnHead + 1) % MAX_DAMAGE_NUMBERS;
    if (this.dnCount < MAX_DAMAGE_NUMBERS) this.dnCount++;
    this.dnX[i] = x + (Math.random() - 0.5) * 10;
    this.dnY[i] = y;
    this.dnVy[i] = -46;
    this.dnLife[i] = 700;
    this.dnVal[i] = amount;
    this.dnCrit[i] = crit ? 1 : 0;
    this.dnCol[i] = this.colors.intern(color);
  }

  decal(x: number, y: number, r: number, color: string, alpha = 0.5): void {
    const i = this.dcHead;
    this.dcHead = (this.dcHead + 1) % MAX_DECALS;
    if (this.dcCount < MAX_DECALS) this.dcCount++;
    this.dcX[i] = x;
    this.dcY[i] = y;
    this.dcR[i] = r;
    this.dcRot[i] = Math.random() * TAU;
    this.dcAlpha[i] = alpha;
    this.dcCol[i] = this.colors.intern(color);
  }

  /** Short-lived light, e.g. an explosion. `tint` indexes the light sprites. */
  transientLight(x: number, y: number, radius: number, life: number, tint = 0): void {
    if (this.tlCount >= this.tlX.length) return;
    const i = this.tlCount++;
    this.tlX[i] = x;
    this.tlY[i] = y;
    this.tlR[i] = radius;
    this.tlLife[i] = life;
    this.tlMax[i] = life;
    this.tlTint[i] = tint;
  }

  flash(color: string, alpha: number, decayPerSec = 6): void {
    if (!this.allowFlashes) return;
    this.flashCol = this.colors.intern(color);
    this.flashAlpha = Math.max(this.flashAlpha, alpha);
    this.flashDecay = decayPerSec;
  }

  // ---------------------------------------------------------------- update

  /** `dt` in seconds. Runs during hitstop too, so hits stay punchy. */
  step(dt: number): void {
    const dtMs = dt * 1000;

    for (let i = 0; i < MAX_PARTICLES; i++) {
      const life = this.plife[i];
      if (life <= 0) continue;
      const nl = life - dtMs;
      if (nl <= 0) {
        this.plife[i] = 0;
        continue;
      }
      this.plife[i] = nl;
      const d = Math.pow(this.pdrag[i], dt);
      this.pvx[i] *= d;
      this.pvy[i] = this.pvy[i] * d + this.pgrav[i] * dt;
      this.px[i] += this.pvx[i] * dt;
      this.py[i] += this.pvy[i] * dt;
    }

    for (let i = 0; i < MAX_DAMAGE_NUMBERS; i++) {
      const life = this.dnLife[i];
      if (life <= 0) continue;
      const nl = life - dtMs;
      if (nl <= 0) {
        this.dnLife[i] = 0;
        continue;
      }
      this.dnLife[i] = nl;
      this.dnVy[i] += 110 * dt;
      this.dnY[i] += this.dnVy[i] * dt;
    }

    for (let i = this.tlCount - 1; i >= 0; i--) {
      this.tlLife[i] -= dtMs;
      if (this.tlLife[i] > 0) continue;
      const last = this.tlCount - 1;
      this.tlX[i] = this.tlX[last];
      this.tlY[i] = this.tlY[last];
      this.tlR[i] = this.tlR[last];
      this.tlLife[i] = this.tlLife[last];
      this.tlMax[i] = this.tlMax[last];
      this.tlTint[i] = this.tlTint[last];
      this.tlCount--;
    }

    if (this.flashAlpha > 0) {
      this.flashAlpha = Math.max(0, this.flashAlpha - this.flashDecay * dt);
    }
  }

  // ------------------------------------------------------------------ draw

  /** World-space decals. Drawn under entities. */
  drawDecals(c: CanvasRenderingContext2D): void {
    for (let i = 0; i < MAX_DECALS; i++) {
      const a = this.dcAlpha[i];
      if (a <= 0) continue;
      c.globalAlpha = a;
      c.fillStyle = this.colors.get(this.dcCol[i]);
      c.beginPath();
      c.ellipse(this.dcX[i], this.dcY[i], this.dcR[i], this.dcR[i] * 0.62, this.dcRot[i], 0, TAU);
      c.fill();
    }
    c.globalAlpha = 1;
  }

  /** World-space particles. Additive ones are batched after the normal ones. */
  drawParticles(c: CanvasRenderingContext2D): void {
    this.drawParticlePass(c, 0);
    // Additive pass. Composite op is always restored — leaking 'lighter' turns
    // the whole next frame into a white smear.
    c.globalCompositeOperation = 'lighter';
    this.drawParticlePass(c, 1);
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
  }

  private drawParticlePass(c: CanvasRenderingContext2D, additive: number): void {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const life = this.plife[i];
      if (life <= 0 || this.padd[i] !== additive) continue;
      const t = life / this.pmax[i];
      const size = this.psize[i];
      c.globalAlpha = clamp01(t);
      c.fillStyle = this.colors.get(this.pcol[i]);
      const x = this.px[i];
      const y = this.py[i];

      switch (this.pkind[i]) {
        case PKind.Spark: {
          const s = size * (0.4 + t * 0.6);
          c.fillRect(x - s * 0.5, y - s * 0.5, s, s);
          break;
        }
        case PKind.Streak: {
          const vx = this.pvx[i];
          const vy = this.pvy[i];
          const l = Math.sqrt(vx * vx + vy * vy);
          if (l < 1) break;
          const sx = (vx / l) * size * 2.2;
          const sy = (vy / l) * size * 2.2;
          c.strokeStyle = this.colors.get(this.pcol[i]);
          c.lineWidth = Math.max(1, size * 0.55);
          c.beginPath();
          c.moveTo(x, y);
          c.lineTo(x - sx, y - sy);
          c.stroke();
          break;
        }
        case PKind.Ring: {
          const rr = size * (1 + (1 - t) * 2.6);
          c.strokeStyle = this.colors.get(this.pcol[i]);
          c.lineWidth = Math.max(1, size * 0.35 * t);
          c.beginPath();
          c.arc(x, y, rr, 0, TAU);
          c.stroke();
          break;
        }
        case PKind.Chunk: {
          const s = size * (0.5 + t * 0.5);
          c.beginPath();
          c.moveTo(x, y - s);
          c.lineTo(x + s, y);
          c.lineTo(x, y + s * 0.8);
          c.lineTo(x - s * 0.9, y);
          c.closePath();
          c.fill();
          break;
        }
        default: {
          const rr = size * (0.35 + t * 0.65);
          c.beginPath();
          c.arc(x, y, rr, 0, TAU);
          c.fill();
        }
      }
    }
    c.globalAlpha = 1;
  }

  /** Feed transient lights into the light buffer. */
  forEachLight(fn: (x: number, y: number, radius: number, intensity: number, tint: number) => void): void {
    for (let i = 0; i < this.tlCount; i++) {
      const t = this.tlLife[i] / this.tlMax[i];
      fn(this.tlX[i], this.tlY[i], this.tlR[i] * (0.5 + t * 0.5), t, this.tlTint[i]);
    }
  }

  /**
   * Damage numbers, drawn in SCREEN space so they are never darkened by the
   * light composite and never scale oddly.
   */
  drawDamageNumbers(
    c: CanvasRenderingContext2D,
    toScreenX: (wx: number) => number,
    toScreenY: (wy: number) => number,
  ): void {
    for (let i = 0; i < MAX_DAMAGE_NUMBERS; i++) {
      const life = this.dnLife[i];
      if (life <= 0) continue;
      const crit = this.dnCrit[i] === 1;
      const alpha = life > 250 ? 1 : life / 250;
      const size = crit ? 19 : 14;
      c.globalAlpha = alpha;
      c.font = `700 ${size}px ui-monospace, monospace`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      const sx = toScreenX(this.dnX[i]);
      const sy = toScreenY(this.dnY[i]);
      const text = String(Math.max(1, Math.round(this.dnVal[i])));
      c.fillStyle = '#000000';
      c.globalAlpha = alpha * 0.55;
      c.fillText(text, sx + 1.5, sy + 1.5);
      c.globalAlpha = alpha;
      c.fillStyle = this.colors.get(this.dnCol[i]);
      c.fillText(text, sx, sy);
    }
    c.globalAlpha = 1;
  }

  drawFlash(c: CanvasRenderingContext2D, w: number, h: number): void {
    if (this.flashAlpha <= 0) return;
    c.globalAlpha = Math.min(1, this.flashAlpha);
    c.fillStyle = this.colors.get(this.flashCol);
    c.fillRect(0, 0, w, h);
    c.globalAlpha = 1;
  }
}

export const fx = new Fx();
