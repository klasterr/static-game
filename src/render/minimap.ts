import { TILE } from '../core/constants';
import { clamp01 } from '../core/math';
import type { Level } from '../gen/level';
import type { GameCtx } from '../world/ctx';
import { circle } from './glyphs';
import type { Renderer } from './renderer';

/**
 * Minimap.
 *
 * Room outlines only, and only for rooms already entered. A full reveal would
 * remove the reason to explore; showing nothing makes a hundred-by-hundred
 * floor a memory test. Room-granularity is the middle ground: you always know
 * where you have been and roughly how the floor connects, but never what is in
 * the room you have not opened.
 *
 * The Silence modifier suppresses it entirely, which is exactly why it needs to
 * be a single flag.
 */

const PANEL = 122;

export function drawMinimap(r: Renderer, ctx: GameCtx, level: Level, hidden: boolean): void {
  if (hidden) return;

  const c = r.ctx;
  r.beginScreen();

  const scale = Math.max(1, Math.min(2, r.dpr));
  c.save();
  c.scale(scale, scale);
  const vw = r.canvas.width / scale;

  const size = PANEL;
  const x = vw - size - 14;
  const y = 78;

  c.fillStyle = 'rgba(6,6,10,0.62)';
  c.fillRect(x, y, size, size);
  c.strokeStyle = 'rgba(216,207,174,0.22)';
  c.lineWidth = 1;
  c.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);

  const mapW = level.map.w;
  const mapH = level.map.h;
  const k = (size - 8) / Math.max(mapW, mapH);
  const ox = x + 4 + (size - 8 - mapW * k) * 0.5;
  const oy = y + 4 + (size - 8 - mapH * k) * 0.5;

  for (const room of level.rooms) {
    if (!room.visited) continue;
    const rx = ox + room.x * k;
    const ry = oy + room.y * k;
    const rw = Math.max(2, room.w * k);
    const rh = Math.max(2, room.h * k);

    c.fillStyle = fillFor(room.kind);
    c.fillRect(rx, ry, rw, rh);
    c.strokeStyle = strokeFor(room.kind);
    c.lineWidth = 1;
    c.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1);
  }

  // Corridors between visited rooms, so the graph is legible.
  c.strokeStyle = 'rgba(216,207,174,0.2)';
  c.lineWidth = 1;
  for (const room of level.rooms) {
    if (!room.visited) continue;
    for (const nid of room.neighbors) {
      const other = level.rooms[nid];
      if (!other || !other.visited || other.id < room.id) continue;
      c.beginPath();
      c.moveTo(ox + room.cx * k, oy + room.cy * k);
      c.lineTo(ox + other.cx * k, oy + other.cy * k);
      c.stroke();
    }
  }

  // The exit, once its room has been seen. This is the one piece of information
  // worth surfacing, because hunting for stairs is tedium rather than tension.
  const exitTx = level.exit.x / TILE;
  const exitTy = level.exit.y / TILE;
  const exitRoom = level.rooms.find((rm) => rm.kind === 'exit' || rm.kind === 'vault');
  if (exitRoom?.visited) {
    const pulse = 0.6 + Math.sin(ctx.timeMs * 0.005) * 0.3;
    c.fillStyle = `rgba(168,230,255,${pulse})`;
    circle(c, ox + exitTx * k, oy + exitTy * k, 2.6);
  }

  // The player, always.
  const px = ox + (ctx.player.x / TILE) * k;
  const py = oy + (ctx.player.y / TILE) * k;
  c.fillStyle = '#ffffff';
  circle(c, px, py, 2.2);
  c.strokeStyle = 'rgba(255,255,255,0.5)';
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(px, py);
  c.lineTo(px + ctx.player.faceX * 5, py + ctx.player.faceY * 5);
  c.stroke();

  c.restore();
}

function fillFor(kind: string): string {
  switch (kind) {
    case 'treasure':
      return 'rgba(255,210,74,0.3)';
    case 'shrine':
      return 'rgba(168,230,255,0.28)';
    case 'elite':
      return 'rgba(194,50,60,0.3)';
    case 'shop':
      return 'rgba(126,242,161,0.26)';
    case 'boss':
      return 'rgba(255,107,58,0.3)';
    case 'exit':
    case 'vault':
      return 'rgba(214,240,255,0.24)';
    case 'entrance':
      return 'rgba(216,207,174,0.2)';
    default:
      return 'rgba(120,112,132,0.26)';
  }
}

function strokeFor(kind: string): string {
  switch (kind) {
    case 'treasure':
      return 'rgba(255,210,74,0.7)';
    case 'shrine':
      return 'rgba(168,230,255,0.7)';
    case 'elite':
      return 'rgba(230,90,100,0.7)';
    case 'shop':
      return 'rgba(126,242,161,0.7)';
    case 'boss':
      return 'rgba(255,107,58,0.8)';
    default:
      return 'rgba(216,207,174,0.35)';
  }
}

/** Legend shown the first time a floor is entered, then never again. */
export function drawMinimapLegend(r: Renderer, show: boolean): void {
  if (!show) return;
  const c = r.ctx;
  r.beginScreen();
  const scale = Math.max(1, Math.min(2, r.dpr));
  c.save();
  c.scale(scale, scale);
  const vw = r.canvas.width / scale;
  const x = vw - PANEL - 14;
  const y = 78 + PANEL + 6;

  const rows: Array<[string, string]> = [
    ['#ffd24a', 'vault'],
    ['#a8e6ff', 'shrine / exit'],
    ['#c2323c', 'elite'],
    ['#7ef2a1', 'shop'],
  ];
  rows.forEach(([color, label], i) => {
    c.fillStyle = color;
    c.fillRect(x, y + i * 12, 6, 6);
    r.text(label, x + 11, y + i * 12 + 6, '600 10px ui-monospace, monospace', '#8f97a3', 'left');
  });
  c.restore();
}

/** Clamp helper re-exported for the play scene's fade maths. */
export const clampFrac = clamp01;
