import { TAU } from '../core/math';

/**
 * Shared procedural drawing primitives.
 *
 * Everything visual in the game is built from these — there are no image
 * assets. Two hard rules for anything in this file:
 *  - Never touch `ctx.shadowBlur` or `ctx.filter`. Both fall off the canvas fast
 *    path and can cost 5-20ms for a handful of draws. If you want a glow,
 *    stack two translucent shapes or emit a light.
 *  - Never call `createRadialGradient` here. Gradients are baked once, at init.
 */

export function circle(c: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  c.beginPath();
  c.arc(x, y, r, 0, TAU);
  c.fill();
}

export function ring(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  width: number,
): void {
  c.lineWidth = width;
  c.beginPath();
  c.arc(x, y, r, 0, TAU);
  c.stroke();
}

/** Soft contact shadow. Sells that a thing is standing on the floor. */
export function shadow(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  alpha = 0.22,
): void {
  c.globalAlpha = alpha;
  c.fillStyle = '#000000';
  c.beginPath();
  c.ellipse(x, y + r * 0.78, r * 0.95, r * 0.42, 0, 0, TAU);
  c.fill();
  c.globalAlpha = 1;
}

/** Regular n-gon, rotated. */
export function regularPoly(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  sides: number,
  rotation = 0,
): void {
  c.beginPath();
  for (let i = 0; i < sides; i++) {
    const a = rotation + (i / sides) * TAU;
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    if (i === 0) c.moveTo(px, py);
    else c.lineTo(px, py);
  }
  c.closePath();
}

/** Isoceles triangle pointing along (dx, dy). */
export function pointyTriangle(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  dx: number,
  dy: number,
  sharpness = 0.75,
): void {
  const a = Math.atan2(dy, dx);
  const back = a + Math.PI;
  const spread = 0.9 + (1 - sharpness) * 0.6;
  c.beginPath();
  c.moveTo(x + Math.cos(a) * r * 1.35, y + Math.sin(a) * r * 1.35);
  c.lineTo(x + Math.cos(back - spread) * r, y + Math.sin(back - spread) * r);
  c.lineTo(x + Math.cos(back) * r * 0.45, y + Math.sin(back) * r * 0.45);
  c.lineTo(x + Math.cos(back + spread) * r, y + Math.sin(back + spread) * r);
  c.closePath();
}

/** Arrowhead / bird silhouette pointing along (dx, dy). */
export function chevron(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  dx: number,
  dy: number,
  /** 0 = wings flat out, 1 = wings folded back for a dive. */
  fold = 0,
): void {
  const a = Math.atan2(dy, dx);
  const wing = 1.9 - fold * 0.85;
  c.beginPath();
  c.moveTo(x + Math.cos(a) * r * 1.5, y + Math.sin(a) * r * 1.5);
  c.lineTo(x + Math.cos(a + wing) * r * 1.15, y + Math.sin(a + wing) * r * 1.15);
  c.lineTo(x + Math.cos(a + Math.PI) * r * 0.3, y + Math.sin(a + Math.PI) * r * 0.3);
  c.lineTo(x + Math.cos(a - wing) * r * 1.15, y + Math.sin(a - wing) * r * 1.15);
  c.closePath();
}

/** Wedge: a blunt forward shape that reads as "this thing charges". */
export function wedge(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  dx: number,
  dy: number,
  stretch = 1,
): void {
  const a = Math.atan2(dy, dx);
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const fx = cos * r * 1.6 * stretch;
  const fy = sin * r * 1.6 * stretch;
  const nx = -sin * r * 0.72;
  const ny = cos * r * 0.72;
  c.beginPath();
  c.moveTo(x + fx, y + fy);
  c.lineTo(x + nx - cos * r * 0.6, y + ny - sin * r * 0.6);
  c.lineTo(x - cos * r * 1.1, y - sin * r * 1.1);
  c.lineTo(x - nx - cos * r * 0.6, y - ny - sin * r * 0.6);
  c.closePath();
}

/**
 * Wobbly organic blob. `phase` animates it, `lobes` sets the silhouette. Purely
 * deterministic so it never flickers.
 */
export function blob(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  phase: number,
  lobes = 5,
  amplitude = 0.13,
): void {
  const steps = 20;
  c.beginPath();
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * TAU;
    const wob = 1 + Math.sin(a * lobes + phase) * amplitude;
    const px = x + Math.cos(a) * r * wob;
    const py = y + Math.sin(a) * r * wob;
    if (i === 0) c.moveTo(px, py);
    else c.lineTo(px, py);
  }
  c.closePath();
}

/** Radial spikes emerging from the ground. `grow` in [0,1]. */
export function spikes(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  count: number,
  grow: number,
  seed = 0,
): void {
  for (let i = 0; i < count; i++) {
    const a = -Math.PI / 2 + (i - (count - 1) / 2) * 0.45 + ((seed % 7) - 3) * 0.03;
    const h = r * 1.9 * grow;
    const w = r * 0.3;
    const tipX = x + Math.cos(a) * h;
    const tipY = y + Math.sin(a) * h;
    c.beginPath();
    c.moveTo(tipX, tipY);
    c.lineTo(x - Math.sin(a) * w, y + Math.cos(a) * w);
    c.lineTo(x + Math.sin(a) * w, y - Math.cos(a) * w);
    c.closePath();
    c.fill();
  }
}

/** Rounded rect. Used for anything that reads as constructed. */
export function roundRect(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w * 0.5, h * 0.5);
  c.beginPath();
  c.moveTo(x + rr, y);
  c.lineTo(x + w - rr, y);
  c.quadraticCurveTo(x + w, y, x + w, y + rr);
  c.lineTo(x + w, y + h - rr);
  c.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  c.lineTo(x + rr, y + h);
  c.quadraticCurveTo(x, y + h, x, y + h - rr);
  c.lineTo(x, y + rr);
  c.quadraticCurveTo(x, y, x + rr, y);
  c.closePath();
}

/** Trapezoid, wider at the base. Squat and heavy. */
export function trapezoid(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  taper = 0.55,
): void {
  const bw = r * 1.35;
  const tw = bw * taper;
  const h = r * 0.95;
  c.beginPath();
  c.moveTo(x - tw, y - h);
  c.lineTo(x + tw, y - h);
  c.lineTo(x + bw, y + h);
  c.lineTo(x - bw, y + h);
  c.closePath();
}

/** Arc segment, used for shields and swing trails. */
export function arcBand(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  inner: number,
  outer: number,
  centerAngle: number,
  halfArc: number,
): void {
  c.beginPath();
  c.arc(x, y, outer, centerAngle - halfArc, centerAngle + halfArc);
  c.arc(x, y, inner, centerAngle + halfArc, centerAngle - halfArc, true);
  c.closePath();
}

/** A three-segment whip/tentacle as a quadratic chain. */
export function tentacle(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  length: number,
  wave: number,
  width: number,
): void {
  const segs = 3;
  c.lineWidth = width;
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(x, y);
  let cx = x;
  let cy = y;
  for (let i = 1; i <= segs; i++) {
    const t = i / segs;
    const a = angle + Math.sin(wave + i * 1.1) * 0.45 * (1 - t * 0.4);
    const seg = length / segs;
    const nx = cx + Math.cos(a) * seg;
    const ny = cy + Math.sin(a) * seg;
    const mx = cx + Math.cos(a + 0.3) * seg * 0.5;
    const my = cy + Math.sin(a + 0.3) * seg * 0.5;
    c.quadraticCurveTo(mx, my, nx, ny);
    cx = nx;
    cy = ny;
  }
  c.stroke();
  c.lineCap = 'butt';
}

/**
 * Squash-and-stretch scale factors from a phase timer. This is the whole
 * animation system: it means nothing needs a separate tween/skeleton layer.
 */
export function squash(t: number, amount = 0.18): { sx: number; sy: number } {
  const s = Math.sin(t) * amount;
  return { sx: 1 + s, sy: 1 - s };
}

// -------------------------------------------------------------- item glyphs

/** Small helper so item glyph literals stay one-liners. */
export function fillPoly(
  c: CanvasRenderingContext2D,
  pts: ReadonlyArray<readonly [number, number]>,
  scale: number,
): void {
  c.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const px = pts[i][0] * scale;
    const py = pts[i][1] * scale;
    if (i === 0) c.moveTo(px, py);
    else c.lineTo(px, py);
  }
  c.closePath();
  c.fill();
}

export function strokePoly(
  c: CanvasRenderingContext2D,
  pts: ReadonlyArray<readonly [number, number]>,
  scale: number,
  width: number,
): void {
  c.lineWidth = width;
  c.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const px = pts[i][0] * scale;
    const py = pts[i][1] * scale;
    if (i === 0) c.moveTo(px, py);
    else c.lineTo(px, py);
  }
  c.stroke();
}
