import { DASH_CD } from '../core/constants';
import { clamp01, TAU } from '../core/math';
import { fmtClock } from '../core/time';
import { CONSUMABLE_REGISTRY, RELIC_REGISTRY } from '../content';
import type { ModifierDef } from '../content/modifiers';
import { RARITY_COLOR } from '../content/types/item';
import { AFFIX_BY_ID } from '../world/enemies';
import { xpFraction } from '../systems/progression';
import { WRAITH_AFTER_MS } from '../systems/trickle';
import { Flags, type Entity } from '../world/entities';
import type { GameCtx } from '../world/ctx';
import { circle, ring } from './glyphs';
import type { Renderer } from './renderer';

/**
 * The HUD.
 *
 * Drawn entirely in screen space, after the light composite, so nothing here is
 * ever darkened by the torch falloff — a health bar you cannot read in a dark
 * corridor is worse than no health bar.
 */

const FONT_SMALL = '600 11px ui-monospace, "Cascadia Mono", monospace';
const FONT_BODY = '600 13px ui-monospace, "Cascadia Mono", monospace';
const FONT_BIG = '700 19px ui-monospace, "Cascadia Mono", monospace';
const FONT_BANNER = '700 26px ui-monospace, "Cascadia Mono", monospace';

export interface HudInfo {
  depth: number;
  clearFraction: number;
  floorMs: number;
  modifier: ModifierDef | null;
  /** Countdown for the arrival banner. */
  bannerMs: number;
  /** Nearby interactable prompt, or null. */
  prompt: string | null;
  seedText: string;
  showMinimapHint: boolean;
}

export function drawHud(r: Renderer, ctx: GameCtx, info: HudInfo): void {
  const c = r.ctx;
  const p = ctx.player.player;
  if (!p) return;

  r.beginScreen();
  c.globalAlpha = 1;
  c.globalCompositeOperation = 'source-over';

  const scale = Math.max(1, Math.min(2, r.dpr * (r.canvas.width < 900 ? 0.85 : 1)));
  c.save();
  c.scale(scale, scale);
  const vw = r.canvas.width / scale;
  const vh = r.canvas.height / scale;

  drawLowHealthVignette(r, ctx, vw, vh, scale);
  drawHealth(c, r, ctx, 14, 14);
  drawXpBar(c, r, ctx, 14, 52, 200);
  drawResources(c, r, ctx, info, 14, 74);
  drawRelicRow(c, ctx, 14, vh - 26);
  drawSlots(c, r, ctx, vw - 14, vh - 26);
  drawDashPip(c, ctx, 14, 66);
  drawDepth(c, r, info, vw - 14, 14);
  drawBossBar(c, r, ctx, vw, 14);
  drawPerkNudge(c, r, ctx, vw, vh);
  drawBanner(c, r, info, vw, vh);
  drawWraithWarning(c, r, ctx, info, vw, vh);
  drawPrompt(c, r, info, vw, vh);

  c.restore();
}

// -------------------------------------------------------------------- health

function drawHealth(
  c: CanvasRenderingContext2D,
  r: Renderer,
  ctx: GameCtx,
  x: number,
  y: number,
): void {
  const e = ctx.player;
  const p = e.player;
  if (!p) return;

  const w = 200;
  const h = 16;
  const frac = clamp01(e.hp / e.hpMax);

  c.fillStyle = 'rgba(6,6,10,0.72)';
  c.fillRect(x - 2, y - 2, w + 4, h + 4);

  // Health. Colour shifts as it drops, so peripheral vision catches it.
  const hue = frac > 0.5 ? '#c2323c' : frac > 0.25 ? '#e0703a' : '#ff4d4d';
  c.fillStyle = '#2a1418';
  c.fillRect(x, y, w, h);
  c.fillStyle = hue;
  c.fillRect(x, y, w * frac, h);

  // The kill-shield rides on top of health rather than beside it, because it is
  // spent first and reads naturally as temporary extra health.
  if (p.shieldHp > 0) {
    const sw = Math.min(w, (p.shieldHp / 30) * 60);
    c.fillStyle = 'rgba(159,182,214,0.85)';
    c.fillRect(x + w * frac - sw, y, sw, h);
  }

  c.strokeStyle = 'rgba(255,255,255,0.22)';
  c.lineWidth = 1;
  c.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

  r.text(
    `${Math.ceil(e.hp)} / ${e.hpMax}`,
    x + w / 2,
    y + h / 2 + 1,
    FONT_SMALL,
    '#ffffff',
    'center',
    'middle',
  );

  if (p.secondWindLeft > 0) {
    for (let i = 0; i < p.secondWindLeft; i++) {
      c.fillStyle = '#ffffff';
      circle(c, x + w + 10 + i * 9, y + h / 2, 3);
    }
  }
}

/** A red edge vignette below 30% health. Impossible to miss, never blocks view. */
function drawLowHealthVignette(
  r: Renderer,
  ctx: GameCtx,
  vw: number,
  vh: number,
  scale: number,
): void {
  const frac = clamp01(ctx.player.hp / ctx.player.hpMax);
  if (frac > 0.3) return;
  const c = r.ctx;
  const intensity = (1 - frac / 0.3) * 0.55;
  const pulse = 0.75 + Math.sin(ctx.timeMs * 0.006) * 0.25;
  const band = Math.min(vw, vh) * 0.14;

  c.globalAlpha = intensity * pulse;
  c.fillStyle = '#6b0d18';
  // Four edge bands rather than a radial gradient: a gradient here would need
  // to be rebuilt every frame, and that is a known several-millisecond mistake.
  c.fillRect(0, 0, vw, band);
  c.fillRect(0, vh - band, vw, band);
  c.fillRect(0, 0, band, vh);
  c.fillRect(vw - band, 0, band, vh);
  c.globalAlpha = 1;
  void scale;
}

// ---------------------------------------------------------------- xp / level

function drawXpBar(
  c: CanvasRenderingContext2D,
  r: Renderer,
  ctx: GameCtx,
  x: number,
  y: number,
  w: number,
): void {
  const p = ctx.player.player;
  if (!p) return;
  const h = 4;
  c.fillStyle = 'rgba(6,6,10,0.72)';
  c.fillRect(x - 2, y - 2, w + 4, h + 4);
  c.fillStyle = '#241f2e';
  c.fillRect(x, y, w, h);
  c.fillStyle = '#7ec8f2';
  c.fillRect(x, y, w * xpFraction(ctx.player), h);
  r.text(`LV ${p.level}`, x + w + 8, y + h - 1, FONT_SMALL, '#9fb6d6', 'left', 'alphabetic');
}

function drawResources(
  c: CanvasRenderingContext2D,
  r: Renderer,
  ctx: GameCtx,
  info: HudInfo,
  x: number,
  y: number,
): void {
  const p = ctx.player.player;
  if (!p) return;

  c.fillStyle = '#b46cf0';
  circle(c, x + 4, y + 4, 3.4);
  r.text(`${p.soulsPending}`, x + 13, y + 8, FONT_BODY, '#e0c4ff', 'left');

  c.fillStyle = '#ffd24a';
  circle(c, x + 62, y + 4, 3.4);
  r.text(`${p.coins}`, x + 71, y + 8, FONT_BODY, '#ffe6a8', 'left');

  void info;
}

/** Dash readiness as a small arc. Cooldowns you cannot see feel arbitrary. */
function drawDashPip(
  c: CanvasRenderingContext2D,
  ctx: GameCtx,
  x: number,
  y: number,
): void {
  const p = ctx.player.player;
  if (!p) return;
  const total = DASH_CD * p.stats.dodgeCdMul;
  const ready = p.dashCd <= 0;
  const frac = ready ? 1 : 1 - clamp01(p.dashCd / total);

  c.strokeStyle = ready ? '#a8e6ff' : 'rgba(168,230,255,0.35)';
  c.lineWidth = 2.4;
  c.beginPath();
  c.arc(x + 218, y + 4, 7, -Math.PI * 0.5, -Math.PI * 0.5 + TAU * frac);
  c.stroke();
}

// ---------------------------------------------------------------- relic row

/**
 * Relic icons with stack counts.
 *
 * This is the payoff for auto-pickup stacking: thirty relics still read as a
 * single glanceable row, where thirty inventory slots would not.
 */
function drawRelicRow(
  c: CanvasRenderingContext2D,
  ctx: GameCtx,
  x: number,
  y: number,
): void {
  const p = ctx.player.player;
  if (!p) return;
  const entries = Object.entries(p.relics).filter(([, n]) => n > 0);
  if (entries.length === 0) return;

  const size = 15;
  let cx = x;
  for (const [id, stacks] of entries) {
    const def = RELIC_REGISTRY[id];
    if (!def) continue;

    c.fillStyle = 'rgba(6,6,10,0.6)';
    c.fillRect(cx - 1, y - size / 2 - 1, size + 2, size + 2);
    c.strokeStyle = RARITY_COLOR[def.rarity];
    c.lineWidth = 1;
    c.strokeRect(cx - 0.5, y - size / 2 - 0.5, size + 1, size + 1);

    c.save();
    c.translate(cx + size / 2, y);
    def.glyph(c, 5.4, def.color, ctx.timeMs);
    c.restore();

    if (stacks > 1) {
      c.font = FONT_SMALL;
      c.textAlign = 'right';
      c.textBaseline = 'alphabetic';
      c.fillStyle = 'rgba(0,0,0,0.8)';
      c.fillText(`${stacks}`, cx + size + 1.5, y + size / 2 + 1.5);
      c.fillStyle = '#ffffff';
      c.fillText(`${stacks}`, cx + size, y + size / 2);
    }
    cx += size + 5;
  }
}

function drawSlots(
  c: CanvasRenderingContext2D,
  r: Renderer,
  ctx: GameCtx,
  right: number,
  y: number,
): void {
  const p = ctx.player.player;
  if (!p) return;
  const size = 26;
  const keys = ['Q', 'F'];

  for (let i = p.slotCount - 1; i >= 0; i--) {
    const slot = p.slots[i];
    const x = right - (p.slotCount - i) * (size + 6);

    c.fillStyle = 'rgba(6,6,10,0.66)';
    c.fillRect(x, y - size / 2, size, size);
    c.strokeStyle = slot.id ? '#d8cfae' : 'rgba(216,207,174,0.25)';
    c.lineWidth = 1.2;
    c.strokeRect(x + 0.5, y - size / 2 + 0.5, size - 1, size - 1);

    if (slot.id) {
      const def = CONSUMABLE_REGISTRY[slot.id];
      if (def) {
        c.save();
        c.translate(x + size / 2, y);
        def.glyph(c, 8, def.color, ctx.timeMs);
        c.restore();
      }
      if (slot.count > 1) {
        r.text(
          `${slot.count}`,
          x + size - 2,
          y + size / 2 - 2,
          FONT_SMALL,
          '#ffffff',
          'right',
        );
      }
    }
    r.text(keys[i], x + 2, y - size / 2 + 9, FONT_SMALL, '#8f97a3', 'left');
  }
}

// ------------------------------------------------------------------- depth

function drawDepth(
  c: CanvasRenderingContext2D,
  r: Renderer,
  info: HudInfo,
  right: number,
  y: number,
): void {
  r.text(`DEPTH ${info.depth}`, right, y + 15, FONT_BIG, '#d8cfae', 'right');
  r.text(
    `${Math.round(info.clearFraction * 100)}% cleared`,
    right,
    y + 31,
    FONT_SMALL,
    '#8f97a3',
    'right',
  );
  // The floor clock matters because the Depth Wraith is on it.
  const late = info.floorMs > WRAITH_AFTER_MS * 0.8;
  r.text(
    fmtClock(info.floorMs),
    right,
    y + 45,
    FONT_SMALL,
    late ? '#d0a4ff' : '#6b6472',
    'right',
  );
  r.text(info.seedText, right, y + 59, FONT_SMALL, '#4a4552', 'right');
  void c;
}

function drawBossBar(
  c: CanvasRenderingContext2D,
  r: Renderer,
  ctx: GameCtx,
  vw: number,
  y: number,
): void {
  const boss = ctx.world.bossAlive();
  const target = boss ?? ctx.world.nearestElite(ctx.player.x, ctx.player.y, 600);
  if (!target) return;

  const isBoss = (target.flags & Flags.Boss) !== 0;
  const w = isBoss ? Math.min(460, vw * 0.5) : 200;
  const h = isBoss ? 12 : 7;
  const x = (vw - w) / 2;
  const top = isBoss ? y + 8 : y + 4;

  c.fillStyle = 'rgba(6,6,10,0.75)';
  c.fillRect(x - 2, top - 2, w + 4, h + 4);
  c.fillStyle = '#2a1418';
  c.fillRect(x, top, w, h);
  c.fillStyle = isBoss ? '#ff6b3a' : '#ffd24a';
  c.fillRect(x, top, w * clamp01(target.hp / target.hpMax), h);
  c.strokeStyle = 'rgba(255,255,255,0.2)';
  c.lineWidth = 1;
  c.strokeRect(x + 0.5, top + 0.5, w - 1, h - 1);

  const affix = AFFIX_BY_ID.get(target.affix);
  const label = affix ? `${affix.name} ${target.def?.name ?? ''}` : target.def?.name ?? '';
  r.text(label.trim(), vw / 2, top + h + 12, FONT_SMALL, '#e8e2d4', 'center');

  // Boss shell/orb state gets its own line: knowing WHY damage is being
  // reduced is the difference between a puzzle and a bug.
  if (isBoss && target.by > 0) {
    r.text(
      `warded by ${target.by} skull${target.by === 1 ? '' : 's'}`,
      vw / 2,
      top + h + 25,
      FONT_SMALL,
      '#ffb45c',
      'center',
    );
  }
}

// ------------------------------------------------------------------ banners

function drawBanner(
  c: CanvasRenderingContext2D,
  r: Renderer,
  info: HudInfo,
  vw: number,
  vh: number,
): void {
  if (info.bannerMs <= 0) return;
  const t = clamp01(info.bannerMs / 1500);
  const alpha = t > 0.8 ? (1 - t) / 0.2 : Math.min(1, t / 0.3);

  c.globalAlpha = alpha;
  const mod = info.modifier;
  const title = mod && mod.id !== 'none' ? mod.name : `Depth ${info.depth}`;
  const sub = mod && mod.id !== 'none' ? mod.desc : '';

  c.fillStyle = 'rgba(6,6,10,0.55)';
  c.fillRect(0, vh * 0.3, vw, sub ? 74 : 50);
  r.text(title, vw / 2, vh * 0.3 + 34, FONT_BANNER, mod?.color ?? '#d8cfae', 'center');
  if (sub) r.text(sub, vw / 2, vh * 0.3 + 58, FONT_BODY, '#b9b3a6', 'center');
  c.globalAlpha = 1;
}

function drawWraithWarning(
  c: CanvasRenderingContext2D,
  r: Renderer,
  ctx: GameCtx,
  info: HudInfo,
  vw: number,
  vh: number,
): void {
  if (ctx.wraithWarning <= 0) return;
  const alpha = clamp01(ctx.wraithWarning / 3200);
  c.globalAlpha = alpha * (0.7 + Math.sin(ctx.timeMs * 0.012) * 0.3);
  r.text(
    'SOMETHING HAS NOTICED YOU',
    vw / 2,
    vh * 0.22,
    FONT_BANNER,
    '#d0a4ff',
    'center',
  );
  r.text('It cannot be killed. Find the stairs.', vw / 2, vh * 0.22 + 22, FONT_BODY, '#b46cf0', 'center');
  c.globalAlpha = 1;
  void info;
}

function drawPrompt(
  c: CanvasRenderingContext2D,
  r: Renderer,
  info: HudInfo,
  vw: number,
  vh: number,
): void {
  if (!info.prompt) return;
  const w = r.measure(info.prompt, FONT_BODY) + 24;
  const x = (vw - w) / 2;
  const y = vh * 0.7;
  c.fillStyle = 'rgba(6,6,10,0.8)';
  c.fillRect(x, y, w, 26);
  c.strokeStyle = 'rgba(216,207,174,0.35)';
  c.lineWidth = 1;
  c.strokeRect(x + 0.5, y + 0.5, w - 1, 25);
  r.text(info.prompt, vw / 2, y + 17, FONT_BODY, '#efe7d4', 'center');
}

function drawPerkNudge(
  c: CanvasRenderingContext2D,
  r: Renderer,
  ctx: GameCtx,
  vw: number,
  vh: number,
): void {
  const p = ctx.player.player;
  if (!p || p.pendingPerks <= 0) return;
  const pulse = 0.6 + Math.sin(ctx.timeMs * 0.006) * 0.3;
  c.globalAlpha = pulse;
  c.strokeStyle = '#ffd24a';
  c.lineWidth = 2;
  ring(c, vw / 2, vh - 58, 13, 2);
  c.globalAlpha = 1;
  r.text('LEVEL UP', vw / 2, vh - 54, FONT_SMALL, '#ffd24a', 'center', 'middle');
  r.text('press Enter to choose a perk', vw / 2, vh - 34, FONT_SMALL, '#b9b3a6', 'center');
}

/** Off-screen marker for a Bounty target, so it can actually be found. */
export function drawBountyMarker(r: Renderer, ctx: GameCtx): void {
  let bounty: Entity | null = null;
  for (const e of ctx.world.ents) {
    if (e.alive && e.affix === 'bounty') {
      bounty = e;
      break;
    }
  }
  if (!bounty) return;

  const c = r.ctx;
  const sx = r.worldToScreenX(bounty.x);
  const sy = r.worldToScreenY(bounty.y);
  const w = r.canvas.width;
  const h = r.canvas.height;
  if (sx > 40 && sx < w - 40 && sy > 40 && sy < h - 40) return;

  const cx = w / 2;
  const cy = h / 2;
  const angle = Math.atan2(sy - cy, sx - cx);
  const radius = Math.min(w, h) * 0.38;
  const mx = cx + Math.cos(angle) * radius;
  const my = cy + Math.sin(angle) * radius;

  r.beginScreen();
  c.save();
  c.translate(mx, my);
  c.rotate(angle);
  c.fillStyle = '#ffd24a';
  c.globalAlpha = 0.55 + Math.sin(ctx.timeMs * 0.01) * 0.25;
  c.beginPath();
  c.moveTo(12, 0);
  c.lineTo(-8, -7);
  c.lineTo(-8, 7);
  c.closePath();
  c.fill();
  c.globalAlpha = 1;
  c.restore();
}
