import {
  DISCARD_FRAME_MS,
  MAX_FRAME_MS,
  MAX_STEPS,
  STEP,
  STEP_S,
} from './core/constants';
import { Input } from './core/input';
import { FrameStats } from './core/time';
import { Renderer } from './render/renderer';
import { fx } from './render/fx';

/**
 * A scene is a step + render pair on a stack. Pause menus and overlays are
 * scenes that suppress stepping below them but let rendering through.
 */
export interface Scene {
  onEnter?(g: Game): void;
  onExit?(g: Game): void;
  /** Fixed dt: always exactly STEP milliseconds. */
  step(g: Game): void;
  render(g: Game, alpha: number): void;
  /** If false, scenes below this one are not stepped. */
  passthroughStep: boolean;
  /** If true, scenes below this one are still rendered. */
  passthroughRender: boolean;
}

/**
 * The loop.
 *
 * Fixed timestep with an accumulator, plus render interpolation.
 *
 * Why fixed: combat feel is the product. The attack active window is 70ms —
 * four ticks. With a variable dt, a 33ms frame merges windup and active, a 50ms
 * frame can skip the overlap test entirely, and knockback decay and i-frame
 * timing become framerate-dependent. Fixed stepping also makes a run
 * reproducible from (seed, input log), which is how "the enemy phased through
 * the wall" actually gets debugged.
 *
 * The cost is two extra floats per entity for interpolation. Worth it: without
 * interpolation the game visibly judders on 120/144Hz displays, where each sim
 * frame is shown 2 or 2.4 times, unevenly.
 */
export class Game {
  readonly renderer: Renderer;
  readonly stats = new FrameStats();
  readonly scenes: Scene[] = [];

  private acc = 0;
  private last = 0;
  private running = false;
  private rafHandle = 0;

  paused = false;
  /** Global time multiplier. Scales accumulation, never the step size. */
  timescale = 1;
  private timescaleT = 0;
  private timescaleRestore = 1;

  /** Remaining hitstop, ms. Freezes the sim; effects keep animating. */
  hitstop = 0;

  showDebug = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new Renderer(canvas);
    Input.install(canvas);
  }

  // ---------------------------------------------------------- scene stack

  push(s: Scene): void {
    this.scenes.push(s);
    s.onEnter?.(this);
  }

  pop(): void {
    const s = this.scenes.pop();
    s?.onExit?.(this);
  }

  replace(s: Scene): void {
    while (this.scenes.length > 0) this.pop();
    this.push(s);
  }

  /** Replace only the topmost scene. */
  swapTop(s: Scene): void {
    this.pop();
    this.push(s);
  }

  get top(): Scene | undefined {
    return this.scenes[this.scenes.length - 1];
  }

  // ---------------------------------------------------------------- timing

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.acc = 0;
    this.rafHandle = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafHandle);
  }

  pause(): void {
    this.paused = true;
  }

  /**
   * Resuming MUST reset the accumulator. Otherwise the frame after unpausing
   * runs five catch-up steps at once and teleports every enemy onto the player.
   */
  resume(): void {
    this.paused = false;
    this.acc = 0;
    this.last = performance.now();
  }

  addHitstop(ms: number): void {
    this.hitstop = Math.max(this.hitstop, ms);
  }

  /** Brief slow-motion, e.g. the punch after the player takes a hit. */
  setTimescale(value: number, durationMs: number): void {
    this.timescale = value;
    this.timescaleT = durationMs;
    this.timescaleRestore = 1;
  }

  private readonly frame = (now: number): void => {
    if (!this.running) return;
    this.rafHandle = requestAnimationFrame(this.frame);

    const frameStart = now;
    let raw = now - this.last;
    this.last = now;

    // Tab blur, a debugger breakpoint, or a laptop sleeping produces an absurd
    // dt. Throw the debt away rather than trying to catch up through it.
    if (raw > DISCARD_FRAME_MS) raw = STEP;
    else if (raw > MAX_FRAME_MS) raw = MAX_FRAME_MS;
    else if (raw < 0) raw = STEP;

    let stepMs = 0;
    let steps = 0;

    if (!this.paused) {
      this.acc += raw * this.timescale;
      const stepStart = performance.now();
      while (this.acc >= STEP && steps < MAX_STEPS) {
        this.stepOnce();
        this.acc -= STEP;
        steps++;
      }
      // Hard bail: never let the accumulator spiral on a machine that cannot
      // keep up. Better to run slow than to lock the tab.
      if (steps === MAX_STEPS) this.acc = 0;
      stepMs = performance.now() - stepStart;
    } else {
      this.acc = 0;
    }

    const renderStart = performance.now();
    this.render(this.acc / STEP);
    const renderMs = performance.now() - renderStart;

    this.stats.stepsThisFrame = steps;
    this.stats.push(performance.now() - frameStart, stepMs, renderMs);
    fx.budget = this.stats.fxBudget;
  };

  private stepOnce(): void {
    // Hitstop freezes the simulation but not the effects, which is what makes a
    // connected hit feel heavy. Because we return before any scene updates, the
    // attack phase timers freeze too — if they kept ticking, the freeze would
    // eat into the active window and heavy weapons would start missing.
    if (this.hitstop > 0) {
      this.hitstop -= STEP;
      fx.step(STEP_S);
      return;
    }

    if (this.timescaleT > 0) {
      this.timescaleT -= STEP;
      if (this.timescaleT <= 0) this.timescale = this.timescaleRestore;
    }

    Input.beginStep();

    for (let i = this.scenes.length - 1; i >= 0; i--) {
      const s = this.scenes[i];
      s.step(this);
      if (!s.passthroughStep) break;
    }

    Input.endStep();
    fx.step(STEP_S);
  }

  private render(alpha: number): void {
    // Find the lowest scene that must be drawn, then draw upward so overlays
    // land on top.
    let from = this.scenes.length - 1;
    while (from > 0 && this.scenes[from].passthroughRender) from--;
    for (let i = from; i < this.scenes.length; i++) {
      this.scenes[i].render(this, alpha);
    }
  }

  handleResize(): void {
    this.renderer.resize();
  }
}
