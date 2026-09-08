import { Input } from './input';
import { normalize, scratchA } from './math';

/**
 * Touch controls.
 *
 * Minimal on purpose. A GitHub Pages link gets opened on phones constantly, so
 * a game that is literally unplayable there reads as broken — but the design is
 * desktop-first, so this aims at "playable and pleasant", not at parity.
 *
 * Two decisions carry the whole thing:
 *  - The stick's origin is DYNAMIC (wherever your thumb lands), not a fixed
 *    on-screen pad. Fixed pads mean thumb-hunting; dynamic ones never do.
 *  - Aim assist snaps to the nearest hostile inside a narrow cone. Non
 *    negotiable: freehand cone aiming with a thumb is miserable.
 *    (The snap itself lives in `world/player.ts`, gated on `Input.touchActive`.)
 */

const STICK_RADIUS = 48;
const DEADZONE = 10;
const DOUBLE_TAP_MS = 260;

interface Stick {
  id: number;
  originX: number;
  originY: number;
  x: number;
  y: number;
  active: boolean;
}

const move: Stick = { id: -1, originX: 0, originY: 0, x: 0, y: 0, active: false };
const aim: Stick = { id: -1, originX: 0, originY: 0, x: 0, y: 0, active: false };

let lastRightTap = 0;

export function installTouchControls(canvas: HTMLCanvasElement): void {
  Input.touchActive = true;

  const rectOf = (): DOMRect => canvas.getBoundingClientRect();

  canvas.addEventListener(
    'touchstart',
    (e) => {
      const rect = rectOf();
      for (const touch of Array.from(e.changedTouches)) {
        const x = touch.clientX - rect.left;
        const y = touch.clientY - rect.top;
        const leftHalf = x < rect.width * 0.5;

        if (leftHalf && !move.active) {
          move.id = touch.identifier;
          move.originX = x;
          move.originY = y;
          move.x = x;
          move.y = y;
          move.active = true;
        } else if (!leftHalf && !aim.active) {
          aim.id = touch.identifier;
          aim.originX = x;
          aim.originY = y;
          aim.x = x;
          aim.y = y;
          aim.active = true;

          const now = performance.now();
          if (now - lastRightTap < DOUBLE_TAP_MS) {
            // Double-tap on the right half is the dash.
            Input.dashBuffer = 140;
          }
          lastRightTap = now;
          // A tap attacks immediately; holding keeps attacking.
          Input.attackBuffer = 150;
        }
      }
      e.preventDefault();
    },
    { passive: false },
  );

  canvas.addEventListener(
    'touchmove',
    (e) => {
      const rect = rectOf();
      for (const touch of Array.from(e.changedTouches)) {
        const x = touch.clientX - rect.left;
        const y = touch.clientY - rect.top;
        if (touch.identifier === move.id) {
          move.x = x;
          move.y = y;
        } else if (touch.identifier === aim.id) {
          aim.x = x;
          aim.y = y;
        }
      }
      applySticks();
      e.preventDefault();
    },
    { passive: false },
  );

  const end = (e: TouchEvent): void => {
    for (const touch of Array.from(e.changedTouches)) {
      if (touch.identifier === move.id) {
        move.active = false;
        move.id = -1;
        Input.moveX = 0;
        Input.moveY = 0;
      } else if (touch.identifier === aim.id) {
        aim.active = false;
        aim.id = -1;
      }
    }
    e.preventDefault();
  };
  canvas.addEventListener('touchend', end, { passive: false });
  canvas.addEventListener('touchcancel', end, { passive: false });
}

function applySticks(): void {
  if (move.active) {
    const dx = move.x - move.originX;
    const dy = move.y - move.originY;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < DEADZONE) {
      Input.moveX = 0;
      Input.moveY = 0;
    } else {
      const clamped = Math.min(1, len / STICK_RADIUS);
      normalize(dx, dy, scratchA);
      Input.moveX = scratchA.x * clamped;
      Input.moveY = scratchA.y * clamped;
    }
  }

  if (aim.active) {
    const dx = aim.x - aim.originX;
    const dy = aim.y - aim.originY;
    if (Math.sqrt(dx * dx + dy * dy) > DEADZONE) {
      normalize(dx, dy, scratchA);
      Input.aimX = scratchA.x;
      Input.aimY = scratchA.y;
      Input.aimSource = 'move';
    }
    // Drag-and-hold auto-repeats the attack.
    Input.attackBuffer = 150;
  }
}

/** Translucent stick indicator, drawn only while a thumb is down. */
export function drawTouchOverlay(
  c: CanvasRenderingContext2D,
  dpr: number,
): void {
  if (!move.active && !aim.active) return;

  const ring = (s: Stick, color: string): void => {
    if (!s.active) return;
    c.save();
    c.scale(dpr, dpr);
    c.globalAlpha = 0.22;
    c.strokeStyle = color;
    c.lineWidth = 2;
    c.beginPath();
    c.arc(s.originX, s.originY, STICK_RADIUS, 0, Math.PI * 2);
    c.stroke();

    const dx = s.x - s.originX;
    const dy = s.y - s.originY;
    const len = Math.min(STICK_RADIUS, Math.sqrt(dx * dx + dy * dy)) || 0;
    const angle = Math.atan2(dy, dx);
    c.globalAlpha = 0.35;
    c.fillStyle = color;
    c.beginPath();
    c.arc(
      s.originX + Math.cos(angle) * len,
      s.originY + Math.sin(angle) * len,
      14,
      0,
      Math.PI * 2,
    );
    c.fill();
    c.globalAlpha = 1;
    c.restore();
  };

  ring(move, '#a8e6ff');
  ring(aim, '#ffd24a');
}
