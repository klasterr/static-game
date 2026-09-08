/** Rolling frame timing, read by the dev overlay and by adaptive degradation. */

import { PERF_DEGRADE_MS } from './constants';

const SAMPLES = 120;

export class FrameStats {
  private frame = new Float32Array(SAMPLES);
  private step = new Float32Array(SAMPLES);
  private render = new Float32Array(SAMPLES);
  private i = 0;
  private filled = 0;

  /** Scratch buffer for percentile computation; avoids per-call allocation. */
  private sorted = new Float32Array(SAMPLES);

  /** Consecutive milliseconds spent above the degrade threshold. */
  private overBudgetMs = 0;

  /** Multiplier applied to particle spawn counts. Halves under sustained load. */
  fxBudget = 1;

  frameMs = 0;
  stepMs = 0;
  renderMs = 0;
  stepsThisFrame = 0;
  drawCalls = 0;
  entityCount = 0;
  particleCount = 0;

  push(frameMs: number, stepMs: number, renderMs: number): void {
    this.frame[this.i] = frameMs;
    this.step[this.i] = stepMs;
    this.render[this.i] = renderMs;
    this.i = (this.i + 1) % SAMPLES;
    if (this.filled < SAMPLES) this.filled++;

    this.frameMs = frameMs;
    this.stepMs = stepMs;
    this.renderMs = renderMs;

    // Adaptive particle budget: sustained p99 over budget halves it, and it
    // recovers once things calm down. Degrade gracefully rather than stutter.
    const p99 = this.p99();
    if (p99 > PERF_DEGRADE_MS) {
      this.overBudgetMs += frameMs;
      if (this.overBudgetMs > 2000) {
        this.fxBudget = Math.max(0.25, this.fxBudget * 0.5);
        this.overBudgetMs = 0;
      }
    } else {
      this.overBudgetMs = Math.max(0, this.overBudgetMs - frameMs);
      if (this.overBudgetMs === 0 && this.fxBudget < 1) {
        this.fxBudget = Math.min(1, this.fxBudget * 1.02);
      }
    }
  }

  private percentile(buf: Float32Array, q: number): number {
    const n = this.filled;
    if (n === 0) return 0;
    const s = this.sorted;
    for (let k = 0; k < n; k++) s[k] = buf[k];
    // Insertion sort: n is 120 and the data is near-sorted frame to frame.
    for (let k = 1; k < n; k++) {
      const v = s[k];
      let j = k - 1;
      while (j >= 0 && s[j] > v) {
        s[j + 1] = s[j];
        j--;
      }
      s[j + 1] = v;
    }
    const idx = Math.min(n - 1, Math.max(0, Math.round(q * (n - 1))));
    return s[idx];
  }

  p50(): number {
    return this.percentile(this.frame, 0.5);
  }

  p99(): number {
    return this.percentile(this.frame, 0.99);
  }

  stepP50(): number {
    return this.percentile(this.step, 0.5);
  }

  renderP50(): number {
    return this.percentile(this.render, 0.5);
  }
}

/** Format milliseconds for the overlay without allocating a template string. */
export function fmtMs(v: number): string {
  return (Math.round(v * 100) / 100).toFixed(2);
}

/** mm:ss for floor timers. */
export function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}
