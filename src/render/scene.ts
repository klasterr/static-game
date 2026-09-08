import { TILE } from '../core/constants';
import { TAU, clamp01 } from '../core/math';
import { fmtMs } from '../core/time';
import { withAlpha } from '../content/types/biome';
import type { Level } from '../gen/level';
import type { RunState } from '../run/runState';
import { hazardCycle, hazardPhase } from '../world/enemies';
import { EKind, Flags, type Entity } from '../world/entities';
import { Tile } from '../world/tiles';
import type { Game } from '../game';
import { drawEntity, drawTelegraphs, drawX, drawY } from './entityart';
import { fx } from './fx';
import { flicker } from './lighting';
import { drawTiles } from './tileart';
import type { Renderer } from './renderer';

/**
 * The world render pass.
 *
 * Layer order matters and is not arbitrary:
 *
 *   background -> tiles -> hazard overlays -> decals -> ground telegraphs ->
 *   entities (y-sorted) -> particles -> LIGHT COMPOSITE -> post FX -> HUD
 *
 * The light composite sits above entities so that enemies are lit rather than
 * pasted on top of the dark, and the HUD sits above the composite so it is
 * never dimmed by torchlight.
 */

/** Reused draw list. Refilled in place — never reallocated per frame. */
const drawList: Entity[] = [];

function byY(a: Entity, b: Entity): number {
  return a.y - b.y;
}

export function renderWorld(g: Game, run: RunState, alpha: number): void {
  const r = g.renderer;
  const c = r.ctx;
  const ctx = run.ctx;
  const level = run.level;
  const palette = run.biome.palette;

  r.setBiome(palette, run.biome.wallStyle);
  r.clear(palette.bgDeep);
  r.beginWorld(run.camera, alpha);

  c.imageSmoothingEnabled = false;
  c.globalAlpha = 1;
  c.globalCompositeOperation = 'source-over';

  const view = r.tileView(level.map.w, level.map.h);
  const blits = r.atlas ? drawTiles(c, level.map, r.atlas, view) : 0;

  drawHazardOverlays(c, run, view.tx0, view.ty0, view.tx1, view.ty1);
  fx.drawDecals(c);
  drawTelegraphs(c, run.world.ents, ctx.timeMs, alpha);

  // Cull, then y-sort for painter's order. About fifty items survive the cull,
  // so the sort is a few microseconds. The sim array is never reordered — that
  // would risk introducing order-dependence into gameplay.
  drawList.length = 0;
  for (let i = 0; i < run.world.ents.length; i++) {
    const e = run.world.ents[i];
    if (!e.alive) continue;
    if (!r.visible(drawX(e, alpha), drawY(e, alpha), e.r * 2 + 40)) continue;
    drawList.push(e);
  }
  drawList.sort(byY);

  const dc = { c, t: ctx.timeMs, alpha };
  for (let i = 0; i < drawList.length; i++) drawEntity(drawList[i], dc);

  fx.drawParticles(c);

  compositeLights(r, run, alpha);

  // Post: the full-screen damage flash, in screen space and above the light.
  r.beginScreen();
  fx.drawFlash(c, r.canvas.width, r.canvas.height);

  // Damage numbers live in screen space so torchlight never dims them and they
  // never scale oddly with zoom.
  fx.drawDamageNumbers(
    c,
    (wx) => r.worldToScreenX(wx),
    (wy) => r.worldToScreenY(wy),
  );

  g.stats.drawCalls = blits + drawList.length;
  g.stats.entityCount = run.world.ents.length;
  g.stats.particleCount = fx.particleCount;
}

// ------------------------------------------------------------------ lighting

function compositeLights(r: Renderer, run: RunState, alpha: number): void {
  const palette = run.biome.palette;
  const ctx = run.ctx;

  if (!r.lights.enabled) return;

  // Ambient level is the biome's darkness floor. Multiplying by it later is
  // what preserves the palette instead of washing it toward grey.
  const amb = Math.round(clamp01(palette.ambientLight) * 255);
  r.beginLights(`rgb(${amb},${amb},${amb})`);

  // Static emitters: torches, glowing caps, the cold light on the stairs.
  for (const em of level(run).emitters) {
    const f = em.flickers ? flicker(ctx.timeMs, em.x + em.y) : 1;
    r.addWorldLight(em.x, em.y, em.radius * f * ctx.lightMul, 0.9 * f, em.tint);
  }

  // The player's torch.
  const p = ctx.player;
  const pf = flicker(ctx.timeMs, 7);
  const playerRadius = palette.lightRadius * (p.player?.stats.lightMul ?? 1) * ctx.lightMul;
  r.addWorldLight(
    drawX(p, alpha),
    drawY(p, alpha),
    playerRadius * pf,
    0.95 * pf,
    lightTintFor(run),
  );

  // Anything that emits: projectiles, glowing enemies, pickups, hazard pools.
  for (const e of run.world.ents) {
    if (!e.alive || e.light <= 0) continue;
    r.addWorldLight(drawX(e, alpha), drawY(e, alpha), e.light, 0.8, e.lightTint);
  }

  // Transient lights from effects: explosions, muzzle flashes, level-ups.
  fx.forEachLight((x, y, radius, intensity, tint) => {
    r.addWorldLight(x, y, radius, intensity, tint);
  });

  r.compositeLights();
}

function lightTintFor(run: RunState): number {
  return run.biome.wallStyle === 'organic' ? 3 : 0;
}

function level(run: RunState): Level {
  return run.level;
}

// ----------------------------------------------------------- hazard overlays

/**
 * Animated hazard art.
 *
 * The base tile is baked into the atlas; only the moving part is drawn here,
 * and only for tiles actually on screen. The telegraph is the contract: a
 * hazard that damages you without a visible warning window is a bug, not
 * difficulty.
 */
function drawHazardOverlays(
  c: CanvasRenderingContext2D,
  run: RunState,
  tx0: number,
  ty0: number,
  tx1: number,
  ty1: number,
): void {
  const ctx = run.ctx;
  const hazards =
    ctx.depth >= 26 && run.biome.secondaryHazard
      ? [run.biome.hazard, run.biome.secondaryHazard]
      : [run.biome.hazard];
  const palette = run.biome.palette;
  const map = run.level.map;

  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const tile = map.at(tx, ty);
      if (tile !== Tile.HazardStatic && tile !== Tile.HazardVolatile) continue;

      const h = hazards.find((x) => x.tile === tile);
      if (!h) continue;

      const px = tx * TILE;
      const py = ty * TILE;

      if (tile === Tile.HazardVolatile) {
        // Crack lines that grow with contact. Static art, no cycle.
        c.strokeStyle = withAlpha(palette.hazardWarn, 0.4);
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(px + 4, py + 6);
        c.lineTo(px + 15, py + 17);
        c.lineTo(px + 10, py + 27);
        c.moveTo(px + 15, py + 17);
        c.lineTo(px + 27, py + 12);
        c.stroke();
        continue;
      }

      const phase = hazardPhase(ctx, h, tx, ty);
      const cycle = hazardCycle(ctx, h, tx, ty);

      if (phase === 'warn') {
        // Rising warning triangles, growing across the window.
        const grow = clamp01((cycle * h.period) / h.warn);
        c.fillStyle = withAlpha(palette.hazardWarn, 0.25 + grow * 0.45);
        for (let i = 0; i < 3; i++) {
          const cx = px + 8 + i * 8;
          const size = 3 + grow * 4;
          c.beginPath();
          c.moveTo(cx, py + 24 - size);
          c.lineTo(cx + size * 0.7, py + 24);
          c.lineTo(cx - size * 0.7, py + 24);
          c.closePath();
          c.fill();
        }
      } else if (phase === 'active') {
        if (h.cloud) {
          // Spore vent: a soft expanding cloud rather than spikes.
          const t = clamp01(((cycle * h.period) - h.warn) / h.active);
          c.fillStyle = withAlpha(palette.hazard, 0.3 * (1 - t * 0.5));
          c.beginPath();
          c.arc(px + 16, py + 16, 8 + t * 22, 0, TAU);
          c.fill();
        } else {
          // Spike plate: fully extended metal.
          c.fillStyle = palette.hazard;
          for (let i = 0; i < 3; i++) {
            const cx = px + 8 + i * 8;
            c.beginPath();
            c.moveTo(cx, py + 6);
            c.lineTo(cx + 3.5, py + 26);
            c.lineTo(cx - 3.5, py + 26);
            c.closePath();
            c.fill();
          }
          c.fillStyle = withAlpha('#ffffff', 0.35);
          c.fillRect(px + 4, py + 24, 24, 2);
        }
      }
    }
  }
}

// -------------------------------------------------------------- dev overlay

/**
 * Backtick toggles this. Built early on purpose — it pays for itself many
 * times over, and retrofitting it after a performance problem appears is
 * exactly the wrong order.
 */
export function drawDevOverlay(g: Game, run: RunState): void {
  const r = g.renderer;
  const c = r.ctx;
  const s = g.stats;
  r.beginScreen();

  const lines = [
    `frame p50 ${fmtMs(s.p50())}  p99 ${fmtMs(s.p99())}`,
    `step ${fmtMs(s.stepP50())}  render ${fmtMs(s.renderP50())}  steps/f ${s.stepsThisFrame}`,
    `ents ${s.entityCount}  threats ${run.world.liveThreats()}  particles ${s.particleCount}`,
    `blits ${s.drawCalls}  fxBudget ${s.fxBudget.toFixed(2)}`,
    `zoom ${r.zoom} dpr ${r.dpr.toFixed(2)} view ${Math.round(r.viewW)}x${Math.round(r.viewH)}`,
    `depth ${run.depth} biome ${run.biome.id} mod ${run.modifier.id}`,
    `seed ${run.seedText}  attempts ${run.level.attempts}  rooms ${run.level.rooms.length}`,
    `path ${run.level.mainPathLength}t  cleared ${(run.clearFraction * 100).toFixed(0)}%`,
    `flow rev ${run.flow.revision}  trickled ${run.trickle.spawned}`,
    `hitstop ${g.hitstop.toFixed(0)}  timescale ${g.timescale.toFixed(2)}`,
  ];

  const pad = 8;
  const lineH = 14;
  const w = 330;
  const h = lines.length * lineH + pad * 2;

  c.globalAlpha = 0.82;
  c.fillStyle = '#05050a';
  c.fillRect(pad, r.canvas.height - h - pad, w, h);
  c.globalAlpha = 1;

  const font = '600 11px ui-monospace, monospace';
  lines.forEach((line, i) => {
    r.text(
      line,
      pad + 8,
      r.canvas.height - h - pad + pad + (i + 1) * lineH - 4,
      font,
      '#7ef2a1',
      'left',
      'alphabetic',
      '',
    );
  });
}

/** Collision-shape debug view, also behind the backtick toggle. */
export function drawDebugShapes(g: Game, run: RunState, alpha: number): void {
  const r = g.renderer;
  const c = r.ctx;
  r.beginWorld(run.camera, alpha);

  c.lineWidth = 1;
  for (const e of run.world.ents) {
    if (!e.alive) continue;
    c.strokeStyle =
      e.kind === EKind.Player
        ? '#7ef2a1'
        : (e.flags & Flags.Boss) !== 0
          ? '#ff6b3a'
          : e.kind === EKind.Projectile
            ? '#ffd24a'
            : '#ff4d4d';
    c.beginPath();
    c.arc(drawX(e, alpha), drawY(e, alpha), e.r, 0, TAU);
    c.stroke();
  }

  // Solid-tile overlay.
  const view = r.tileView(run.level.map.w, run.level.map.h);
  c.fillStyle = 'rgba(255,0,80,0.12)';
  for (let ty = view.ty0; ty <= view.ty1; ty++) {
    for (let tx = view.tx0; tx <= view.tx1; tx++) {
      if (!run.level.map.isSolid(tx, ty)) continue;
      c.fillRect(tx * TILE, ty * TILE, TILE, TILE);
    }
  }
}
