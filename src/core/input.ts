/**
 * Input.
 *
 * The important structural choice here is that DOM listeners only PUSH onto a
 * queue; the queue is drained at simulation step boundaries. The naive
 * `pressed = downNow && !downLast` approach silently loses any key that goes
 * down *and* up inside one 16.7ms window, which happens constantly when a
 * player mashes attack on a machine dropping frames. It is the number one cause
 * of "my inputs feel dropped" in hand-rolled loops.
 */

import { ATTACK_BUFFER_MS, DASH_BUFFER_MS, STEP } from './constants';
import { normalize, scratchA } from './math';

export const Action = {
  Up: 0,
  Down: 1,
  Left: 2,
  Right: 3,
  Attack: 4,
  Dash: 5,
  Interact: 6,
  Use1: 7,
  Use2: 8,
  Pause: 9,
  Confirm: 10,
  Cancel: 11,
  Map: 12,
  Debug: 13,
} as const;
export type ActionId = (typeof Action)[keyof typeof Action];

const ACTION_COUNT = 14;

/** Physical `KeyboardEvent.code` -> action. Using `code` keeps AZERTY working. */
const BINDINGS: Record<string, ActionId> = {
  KeyW: Action.Up,
  ArrowUp: Action.Up,
  KeyS: Action.Down,
  ArrowDown: Action.Down,
  KeyA: Action.Left,
  ArrowLeft: Action.Left,
  KeyD: Action.Right,
  ArrowRight: Action.Right,

  Space: Action.Attack,
  ShiftLeft: Action.Dash,
  ShiftRight: Action.Dash,
  KeyE: Action.Interact,
  KeyQ: Action.Use1,
  KeyF: Action.Use2,

  Escape: Action.Pause,
  KeyP: Action.Pause,
  Enter: Action.Confirm,
  NumpadEnter: Action.Confirm,
  KeyM: Action.Map,
  Tab: Action.Map,
  Backquote: Action.Debug,
};

/** Keys whose default browser behaviour would fight the game. */
const SWALLOW = new Set([
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Tab',
  'Backquote',
  'KeyQ',
]);

interface QueuedKey {
  action: ActionId;
  isDown: boolean;
}

class InputState {
  /** Held state at the last step boundary. */
  private heldA = new Uint8Array(ACTION_COUNT);
  /** Went down at some point during the step just drained. */
  private pressA = new Uint8Array(ACTION_COUNT);
  /** Went up at some point during the step just drained. */
  private relA = new Uint8Array(ACTION_COUNT);

  /** Physical keys currently down, for blur recovery. */
  private downCodes = new Set<string>();
  private queue: QueuedKey[] = [];
  private queueLen = 0;

  // Movement, normalized. Written by keyboard or by the touch stick.
  moveX = 0;
  moveY = 0;

  // Unit aim vector. Defaults to "right" so the very first swing has a direction.
  aimX = 1;
  aimY = 0;
  /** Which device last moved the aim. Lets mouse and keyboard players coexist. */
  aimSource: 'pointer' | 'move' = 'move';

  /** Pointer position in CSS pixels relative to the canvas. */
  mouseSX = 0;
  mouseSY = 0;
  /** True while a pointer button is held. */
  pointerDown = false;
  /** Pointer went down during the step just drained. */
  pointerPressed = false;

  /** Remaining buffer windows, ms. */
  attackBuffer = 0;
  dashBuffer = 0;

  /** Set by the touch layer; suppresses the crosshair cursor and enables aim assist. */
  touchActive = false;

  private pointerPressPending = false;
  private attackPressPending = false;
  private dashPressPending = false;
  private installed = false;

  install(canvas: HTMLCanvasElement): void {
    if (this.installed) return;
    this.installed = true;

    window.addEventListener('keydown', (e) => {
      const action = BINDINGS[e.code];
      if (SWALLOW.has(e.code)) e.preventDefault();
      if (action === undefined) return;
      // Auto-repeat must not read as a fresh press.
      if (e.repeat) return;
      if (this.downCodes.has(e.code)) return;
      this.downCodes.add(e.code);
      this.enqueue(action, true);
    });

    window.addEventListener('keyup', (e) => {
      const action = BINDINGS[e.code];
      if (action === undefined) return;
      this.downCodes.delete(e.code);
      // Only release the action if no other bound key for it is still held.
      let stillHeld = false;
      for (const code of this.downCodes) {
        if (BINDINGS[code] === action) {
          stillHeld = true;
          break;
        }
      }
      if (!stillHeld) this.enqueue(action, false);
    });

    canvas.addEventListener('pointermove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const nx = e.clientX - rect.left;
      const ny = e.clientY - rect.top;
      const moved = Math.abs(nx - this.mouseSX) + Math.abs(ny - this.mouseSY);
      this.mouseSX = nx;
      this.mouseSY = ny;
      if (moved > 3 && e.pointerType !== 'touch') this.aimSource = 'pointer';
    });

    canvas.addEventListener('pointerdown', (e) => {
      const rect = canvas.getBoundingClientRect();
      this.mouseSX = e.clientX - rect.left;
      this.mouseSY = e.clientY - rect.top;
      if (e.pointerType !== 'touch') this.aimSource = 'pointer';
      this.pointerDown = true;
      this.pointerPressPending = true;
      // Left button also attacks; the buffer is consumed by the player system.
      if (e.button === 0) this.enqueue(Action.Attack, true);
      canvas.focus();
      e.preventDefault();
    });

    const releasePointer = (e: PointerEvent) => {
      this.pointerDown = false;
      if (e.button === 0) this.enqueue(Action.Attack, false);
    };
    canvas.addEventListener('pointerup', releasePointer);
    canvas.addEventListener('pointercancel', releasePointer);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // Alt-tabbing mid-strafe must not leave the player walking left forever.
    const dropEverything = () => this.releaseAll();
    window.addEventListener('blur', dropEverything);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) dropEverything();
    });
  }

  private enqueue(action: ActionId, isDown: boolean): void {
    if (this.queueLen < this.queue.length) {
      const slot = this.queue[this.queueLen];
      slot.action = action;
      slot.isDown = isDown;
    } else {
      this.queue.push({ action, isDown });
    }
    this.queueLen++;
  }

  releaseAll(): void {
    this.downCodes.clear();
    this.queueLen = 0;
    this.heldA.fill(0);
    this.pressA.fill(0);
    this.relA.fill(0);
    this.pointerDown = false;
    this.moveX = 0;
    this.moveY = 0;
    this.attackBuffer = 0;
    this.dashBuffer = 0;
  }

  /** Drain the event queue into edge/held state. Called once per sim step. */
  beginStep(): void {
    this.pressA.fill(0);
    this.relA.fill(0);

    for (let i = 0; i < this.queueLen; i++) {
      const q = this.queue[i];
      if (q.isDown) {
        this.pressA[q.action] = 1;
        this.heldA[q.action] = 1;
      } else {
        this.relA[q.action] = 1;
        this.heldA[q.action] = 0;
      }
    }
    this.queueLen = 0;

    this.pointerPressed = this.pointerPressPending;
    this.pointerPressPending = false;

    this.attackPressPending = this.pressA[Action.Attack] === 1;
    this.dashPressPending = this.pressA[Action.Dash] === 1;

    // Keyboard movement vector. Opposing keys cancel.
    const kx = (this.heldA[Action.Right] ? 1 : 0) - (this.heldA[Action.Left] ? 1 : 0);
    const ky = (this.heldA[Action.Down] ? 1 : 0) - (this.heldA[Action.Up] ? 1 : 0);
    if (!this.touchActive) {
      if (kx !== 0 || ky !== 0) {
        normalize(kx, ky, scratchA);
        this.moveX = scratchA.x;
        this.moveY = scratchA.y;
      } else {
        this.moveX = 0;
        this.moveY = 0;
      }
    }

    // Keyboard aim follows the last non-zero movement direction.
    if (this.aimSource === 'move' && (this.moveX !== 0 || this.moveY !== 0)) {
      this.aimX = this.moveX;
      this.aimY = this.moveY;
    }
  }

  /** Decay buffers. Called once per sim step, after scenes have run. */
  endStep(): void {
    this.attackBuffer = this.attackPressPending
      ? ATTACK_BUFFER_MS
      : Math.max(0, this.attackBuffer - STEP);
    this.dashBuffer = this.dashPressPending
      ? DASH_BUFFER_MS
      : Math.max(0, this.dashBuffer - STEP);
    this.attackPressPending = false;
    this.dashPressPending = false;
  }

  held(a: ActionId): boolean {
    return this.heldA[a] === 1;
  }

  pressed(a: ActionId): boolean {
    return this.pressA[a] === 1;
  }

  released(a: ActionId): boolean {
    return this.relA[a] === 1;
  }

  consumeAttackBuffer(): boolean {
    if (this.attackBuffer <= 0) return false;
    this.attackBuffer = 0;
    return true;
  }

  consumeDashBuffer(): boolean {
    if (this.dashBuffer <= 0) return false;
    this.dashBuffer = 0;
    return true;
  }

  /** Any of the "advance a menu" inputs. */
  menuConfirm(): boolean {
    return this.pressed(Action.Confirm) || this.pressed(Action.Attack) ||
      this.pressed(Action.Interact);
  }
}

export const Input = new InputState();
