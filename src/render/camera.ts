import {
  CAMERA_DEADZONE_H,
  CAMERA_DEADZONE_W,
  CAMERA_FOLLOW_RATE,
  CAMERA_LOOKAHEAD,
  TILE,
  TRAUMA_DECAY,
  TRAUMA_MAX_OFFSET,
} from '../core/constants';
import { clamp, type Vec2 } from '../core/math';
import type { Tilemap } from '../world/tiles';

export interface Camera {
  x: number;
  y: number;
  /** Previous tick, for render interpolation. */
  px: number;
  py: number;
  /** The point the camera is easing toward. */
  gx: number;
  gy: number;
  trauma: number;
  /** Accessibility multiplier on shake, 0 disables it. */
  shakeScale: number;
}

export function makeCamera(): Camera {
  return { x: 0, y: 0, px: 0, py: 0, gx: 0, gy: 0, trauma: 0, shakeScale: 1 };
}

/** Teleport the camera. Also resets interpolation so it does not streak. */
export function snapCamera(cam: Camera, x: number, y: number): void {
  cam.x = cam.px = cam.gx = x;
  cam.y = cam.py = cam.gy = y;
}

export function addTrauma(cam: Camera, amount: number): void {
  cam.trauma = Math.min(1, cam.trauma + amount * cam.shakeScale);
}

/**
 * Deadzone follow with aim lookahead. Runs inside the fixed step so it is
 * deterministic and so `px/py` interpolation works uniformly with entities.
 */
export function updateCamera(
  cam: Camera,
  targetX: number,
  targetY: number,
  aimX: number,
  aimY: number,
  dt: number,
  map: Tilemap,
  viewW: number,
  viewH: number,
): void {
  cam.px = cam.x;
  cam.py = cam.y;

  const tx = targetX + aimX * CAMERA_LOOKAHEAD;
  const ty = targetY + aimY * CAMERA_LOOKAHEAD;

  // Only chase on the axis where the target has escaped the deadzone box. This
  // is what keeps small strafing movements from dragging the whole view around.
  if (tx > cam.gx + CAMERA_DEADZONE_W) cam.gx = tx - CAMERA_DEADZONE_W;
  else if (tx < cam.gx - CAMERA_DEADZONE_W) cam.gx = tx + CAMERA_DEADZONE_W;
  if (ty > cam.gy + CAMERA_DEADZONE_H) cam.gy = ty - CAMERA_DEADZONE_H;
  else if (ty < cam.gy - CAMERA_DEADZONE_H) cam.gy = ty + CAMERA_DEADZONE_H;

  const k = 1 - Math.exp(-CAMERA_FOLLOW_RATE * dt);
  cam.x += (cam.gx - cam.x) * k;
  cam.y += (cam.gy - cam.y) * k;

  // Clamp to level bounds; centre instead if the level is smaller than the view.
  const wpx = map.w * TILE;
  const hpx = map.h * TILE;
  cam.x = wpx <= viewW ? wpx * 0.5 : clamp(cam.x, viewW * 0.5, wpx - viewW * 0.5);
  cam.y = hpx <= viewH ? hpx * 0.5 : clamp(cam.y, viewH * 0.5, hpx - viewH * 0.5);

  cam.trauma = Math.max(0, cam.trauma - TRAUMA_DECAY * dt);
}

/**
 * Shake offset in world px, written into `out`. Quadratic in trauma so small
 * hits are subtle and big ones are violent. Translation only — rotating the
 * view is nauseating at this zoom.
 */
export function shakeOffset(cam: Camera, out: Vec2): void {
  if (cam.trauma <= 0) {
    out.x = 0;
    out.y = 0;
    return;
  }
  const mag = cam.trauma * cam.trauma * TRAUMA_MAX_OFFSET;
  out.x = (Math.random() * 2 - 1) * mag;
  out.y = (Math.random() * 2 - 1) * mag;
}
