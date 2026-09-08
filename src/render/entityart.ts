import { TAU, clamp01, lerp } from '../core/math';
import { AFFIX_BY_ID } from '../world/enemies';
import { classById } from '../content/classes';
import { CONSUMABLE_REGISTRY, RELIC_REGISTRY, WEAPON_REGISTRY } from '../content';
import { RARITY_COLOR } from '../content/types/item';
import { drawLob, drawLobTelegraph } from '../content/enemies/fungal';
import { AtkPhase, EKind, Flags, type Entity } from '../world/entities';
import { isLob } from '../world/projectiles';
import {
  arcBand,
  blob,
  chevron,
  circle,
  pointyTriangle,
  regularPoly,
  ring,
  roundRect,
  shadow,
  trapezoid,
  wedge,
} from './glyphs';

/**
 * Procedural entity rendering.
 *
 * Everything is drawn from shapes, in LOCAL space with (0,0) at the entity
 * centre — the caller has already translated. Enemy definitions may override
 * with their own `visual.draw`; the family shapes here are the fallback and the
 * baseline for anything that does not need bespoke art.
 *
 * Animation is squash-and-stretch driven off the existing `state`/`stateT`
 * timers. There is no separate tween or skeleton system, and there does not
 * need to be.
 */

export interface DrawContext {
  c: CanvasRenderingContext2D;
  /** Simulation clock, ms. Never `performance.now()` — that would desync. */
  t: number;
  /** Interpolation factor within the current sim step. */
  alpha: number;
}

/** Interpolated draw position. Never written back to the entity. */
export function drawX(e: Entity, alpha: number): number {
  return lerp(e.px, e.x, alpha);
}

export function drawY(e: Entity, alpha: number): number {
  return lerp(e.py, e.y, alpha);
}

/** Ground-layer telegraphs, drawn beneath every entity so nothing hides them. */
export function drawTelegraphs(
  c: CanvasRenderingContext2D,
  ents: Entity[],
  t: number,
  alpha: number,
): void {
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    if (!e.alive) continue;

    if (e.kind === EKind.Projectile && isLob(e)) {
      drawLobTelegraph(c, e, t);
      continue;
    }
    const tele = e.def?.drawTelegraph;
    if (!tele) continue;
    c.save();
    c.translate(drawX(e, alpha), drawY(e, alpha));
    tele(c, e, t);
    c.restore();
  }
}

/** One entity, fully. */
export function drawEntity(e: Entity, dc: DrawContext): void {
  const { c, t, alpha } = dc;
  const x = drawX(e, alpha);
  const y = drawY(e, alpha);

  // Invulnerability blink. Skipping alternate 60ms windows is the clearest
  // possible signal that damage is not landing right now.
  if (e.iframes > 0 && e.kind === EKind.Player && Math.floor(t / 60) % 2 === 0) {
    return;
  }

  switch (e.kind) {
    case EKind.Player:
      drawPlayer(e, c, t, x, y);
      return;
    case EKind.Projectile:
      drawProjectile(e, c, t, x, y);
      return;
    case EKind.Pickup:
      drawPickup(e, c, t, x, y);
      return;
    case EKind.Interactive:
      drawInteractive(e, c, t, x, y);
      return;
    case EKind.Hazard:
      drawHazardVolume(e, c, t, x, y);
      return;
    case EKind.Decoy:
      drawDecoy(e, c, t, x, y);
      return;
    default:
      drawEnemy(e, c, t, x, y);
  }
}

// ------------------------------------------------------------------- enemies

function drawEnemy(
  e: Entity,
  c: CanvasRenderingContext2D,
  t: number,
  x: number,
  y: number,
): void {
  const def = e.def;
  if (!def) return;
  const v = def.visual;

  if ((e.flags & Flags.Immobile) === 0) shadow(c, x, y, e.r);
  else shadow(c, x, y, e.r * 0.7, 0.14);

  // Elite aura ring, tinted by affix. The only cue that this Warden is a 2.6x
  // Warden, so it has to be visible before you are in its arc.
  if ((e.flags & Flags.Elite) !== 0) {
    const affix = AFFIX_BY_ID.get(e.affix);
    const pulse = 0.3 + Math.sin(t * 0.005 + e.seed) * 0.12;
    c.strokeStyle = affix?.color ?? '#ffd24a';
    c.globalAlpha = pulse;
    ring(c, x, y, e.r * 1.6, 2);
    c.globalAlpha = 1;
  }

  // Bounty marker: visible through walls is handled by the HUD; this is the
  // in-world half.
  if (e.affix === 'bounty') {
    c.strokeStyle = '#ffd24a';
    c.globalAlpha = 0.55 + Math.sin(t * 0.008) * 0.25;
    ring(c, x, y, e.r * 1.9, 2.5);
    c.globalAlpha = 1;
  }

  c.save();
  c.translate(x, y);

  // Squash from the walk cycle, subtle and speed-scaled.
  const speed = Math.sqrt(e.vx * e.vx + e.vy * e.vy);
  if (speed > 20 && (e.flags & Flags.Immobile) === 0) {
    const w = Math.sin((t + e.seed * 7) * 0.014) * 0.06 * clamp01(speed / 140);
    c.scale(1 + w, 1 - w);
  }

  if (v.draw) {
    v.draw(c, e, t);
  } else {
    drawFamily(e, c, t);
  }

  // Hit flash: a white silhouette over the top. This is the single strongest
  // readability cue in the whole game, so it is applied uniformly and never
  // skipped for bespoke art.
  if (e.flash > 0) {
    c.globalAlpha = Math.min(1, e.flash / 80) * 0.85;
    c.fillStyle = '#ffffff';
    c.globalCompositeOperation = 'source-atop';
    c.fillRect(-e.r * 2.4, -e.r * 2.4, e.r * 4.8, e.r * 4.8);
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
  }

  c.restore();

  // Burning: embers rise off it, so the DoT is visible without a status bar.
  if (e.burnT > 0) {
    c.fillStyle = '#ff7a1a';
    c.globalAlpha = 0.5 + Math.sin(t * 0.02 + e.seed) * 0.2;
    circle(c, x + Math.sin(t * 0.01 + e.seed) * e.r * 0.4, y - e.r, 2);
    c.globalAlpha = 1;
  }

  // Ablative shell, drawn as discrete plates that shatter off. A fully
  // procedural, extremely readable health bar.
  if (e.shellMax > 0 && e.shell > 0) {
    const plates = 6;
    const intact = Math.ceil((e.shell / e.shellMax) * plates);
    c.strokeStyle = '#a8e6ff';
    c.lineWidth = 2.4;
    for (let i = 0; i < intact; i++) {
      const a = (i / plates) * TAU - Math.PI * 0.5;
      c.beginPath();
      c.arc(x, y, e.r * 1.15, a - 0.42, a + 0.42);
      c.stroke();
    }
  }

  drawEnemyHealthBar(e, c, x, y);
}

/** Health bars only on things worth tracking: elites and bosses. */
function drawEnemyHealthBar(
  e: Entity,
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
): void {
  const isBig = (e.flags & (Flags.Elite | Flags.Boss)) !== 0;
  if (!isBig) return;
  if (e.hp >= e.hpMax) return;

  const w = Math.max(26, e.r * 2.6);
  const h = 3;
  const top = y - e.r - 10;
  c.fillStyle = 'rgba(0,0,0,0.6)';
  c.fillRect(x - w / 2 - 1, top - 1, w + 2, h + 2);
  c.fillStyle = (e.flags & Flags.Boss) !== 0 ? '#ff6b3a' : '#ffd24a';
  c.fillRect(x - w / 2, top, w * clamp01(e.hp / e.hpMax), h);
}

/** Fallback silhouettes by family. */
function drawFamily(e: Entity, c: CanvasRenderingContext2D, t: number): void {
  const def = e.def;
  if (!def) return;
  const v = def.visual;
  const r = e.r;

  c.fillStyle = v.body;
  c.strokeStyle = v.accent;
  c.lineWidth = v.outlineWidth;

  switch (v.family) {
    case 'triangle':
      pointyTriangle(c, 0, 0, r, e.faceX, e.faceY);
      c.fill();
      c.stroke();
      break;
    case 'chevron':
      chevron(c, 0, 0, r, e.faceX, e.faceY, e.state === AtkPhase.Windup ? 1 : 0);
      c.fill();
      c.stroke();
      break;
    case 'wedge':
      wedge(c, 0, 0, r, e.faceX, e.faceY, e.state === 2 ? 1.35 : 1);
      c.fill();
      c.stroke();
      break;
    case 'hex':
      regularPoly(c, 0, 0, r, 6, t * 0.0004);
      c.fill();
      c.stroke();
      break;
    case 'diamond':
      regularPoly(c, 0, 0, r, 4, Math.PI * 0.25);
      c.fill();
      c.stroke();
      break;
    case 'rect':
      roundRect(c, -r * 0.62, -r * 1.1, r * 1.24, r * 2.2, 3);
      c.fill();
      c.stroke();
      break;
    case 'trapezoid':
      trapezoid(c, 0, 0, r);
      c.fill();
      c.stroke();
      break;
    case 'blob':
      blob(c, 0, 0, r, (t + e.seed * 11) * 0.004, 5, 0.12);
      c.fill();
      c.stroke();
      break;
    case 'spine':
      roundRect(c, -r * 0.4, -r * 2, r * 0.8, r * 3, 4);
      c.fill();
      c.stroke();
      break;
    default:
      circle(c, 0, 0, r);
      c.stroke();
  }
}

// -------------------------------------------------------------------- player

function drawPlayer(
  e: Entity,
  c: CanvasRenderingContext2D,
  t: number,
  x: number,
  y: number,
): void {
  const p = e.player;
  if (!p) return;
  const cls = classById(p.classId);
  const r = e.r;

  shadow(c, x, y, r);

  // The swing arc, drawn on the ground under the player during the active
  // window. What you see is exactly the cone that hits.
  if (p.atk === AtkPhase.Active) {
    const a = Math.atan2(p.swingY, p.swingX);
    const reach = p.weapon.reach * p.stats.reachMul;
    const half = p.weapon.halfArc * p.stats.arcMul * (p.combo === 2 ? 1.3 : 1);
    const fade = clamp01(p.atkT / Math.max(1, p.weapon.active));
    c.fillStyle = p.weapon.color;
    c.globalAlpha = 0.16 + fade * 0.34;
    arcBand(c, x, y, r * 0.9, reach, a, Math.min(Math.PI, half));
    c.fill();
    c.globalAlpha = 0.5 + fade * 0.5;
    c.strokeStyle = '#ffffff';
    c.lineWidth = 1.6;
    c.beginPath();
    c.arc(x, y, reach, a - half, a + half);
    c.stroke();
    c.globalAlpha = 1;
  }

  // Wind-up tell: a thin line where the swing is about to land, so committing
  // is a readable decision rather than a guess.
  if (p.atk === AtkPhase.Windup) {
    const a = Math.atan2(p.aimY, p.aimX);
    const reach = p.weapon.reach * p.stats.reachMul;
    const charge = 1 - clamp01(p.atkT / Math.max(1, p.weapon.windup));
    c.strokeStyle = p.weapon.color;
    c.globalAlpha = 0.2 + charge * 0.35;
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    c.lineTo(x + Math.cos(a) * reach * (0.5 + charge * 0.5), y + Math.sin(a) * reach * (0.5 + charge * 0.5));
    c.stroke();
    c.globalAlpha = 1;
  }

  c.save();
  c.translate(x, y);

  const speed = Math.sqrt(e.vx * e.vx + e.vy * e.vy);
  const bobAmount = Math.sin(t * 0.017) * 0.055 * clamp01(speed / 180);
  c.scale(1 + bobAmount, 1 - bobAmount);

  // Body. Shape follows the class silhouette.
  const bodyR = cls.visual.bodyShape === 'broad' ? r * 1.12 : r;
  c.fillStyle = '#efe7d4';
  if (cls.visual.bodyShape === 'broad') {
    roundRect(c, -bodyR, -bodyR * 1.05, bodyR * 2, bodyR * 2.1, bodyR * 0.5);
    c.fill();
  } else if (cls.visual.bodyShape === 'lean') {
    roundRect(c, -bodyR * 0.7, -bodyR * 1.2, bodyR * 1.4, bodyR * 2.4, bodyR * 0.55);
    c.fill();
  } else {
    circle(c, 0, 0, bodyR);
  }
  c.strokeStyle = cls.visual.accent;
  c.lineWidth = 2.4;
  c.beginPath();
  if (cls.visual.bodyShape === 'round') c.arc(0, 0, bodyR, 0, TAU);
  c.stroke();

  // Facing pip: a small wedge so the aim direction is never ambiguous.
  c.fillStyle = cls.visual.accent;
  pointyTriangle(c, e.faceX * bodyR * 0.75, e.faceY * bodyR * 0.75, bodyR * 0.42, e.faceX, e.faceY);
  c.fill();

  // Weapon, held out along the facing.
  const wdef = WEAPON_REGISTRY[p.weapon.id];
  if (wdef) {
    c.save();
    const swing =
      p.atk === AtkPhase.Active ? 0.5 : p.atk === AtkPhase.Windup ? -0.55 : 0;
    c.translate(e.faceX * bodyR * 1.05, e.faceY * bodyR * 1.05);
    c.rotate(Math.atan2(e.faceY, e.faceX) + Math.PI * 0.5 + swing);
    wdef.glyph(c, bodyR * 0.72, wdef.color, t);
    c.restore();
  }

  // Kill-shield: a hexagonal ward that thickens as it stacks.
  if (p.shieldHp > 0) {
    const frac = clamp01(p.shieldHp / 30);
    c.strokeStyle = '#9fb6d6';
    c.globalAlpha = 0.35 + frac * 0.4;
    c.lineWidth = 1 + frac * 2.4;
    regularPoly(c, 0, 0, bodyR * 1.55, 6, t * 0.0006);
    c.stroke();
    c.globalAlpha = 1;
  }

  c.restore();

  if (e.flash > 0) {
    c.globalAlpha = Math.min(1, e.flash / 80) * 0.7;
    c.fillStyle = '#ff8080';
    circle(c, x, y, r * 1.2);
    c.globalAlpha = 1;
  }

  // Dash trail.
  if (p.dashT > 0) {
    c.globalAlpha = clamp01(p.dashT / 180) * 0.4;
    c.fillStyle = '#efe7d4';
    circle(c, x - p.dashDirX * 12, y - p.dashDirY * 12, r * 0.8);
    circle(c, x - p.dashDirX * 22, y - p.dashDirY * 22, r * 0.5);
    c.globalAlpha = 1;
  }
}

// --------------------------------------------------------------- projectiles

function drawProjectile(
  e: Entity,
  c: CanvasRenderingContext2D,
  t: number,
  x: number,
  y: number,
): void {
  if (isLob(e)) {
    drawLob(c, e);
    return;
  }

  // Two stacked translucent circles rather than a blur filter: `shadowBlur` and
  // `ctx.filter` both fall off the canvas fast path and can cost 5-20ms.
  c.globalAlpha = 0.35;
  c.fillStyle = e.tag;
  circle(c, x, y, e.r * 2.1);
  c.globalAlpha = 1;
  c.fillStyle = e.tag;
  circle(c, x, y, e.r);
  c.fillStyle = 'rgba(255,255,255,0.75)';
  circle(c, x - e.faceX * e.r * 0.25, y - e.faceY * e.r * 0.25, e.r * 0.42);
  void t;
}

// ------------------------------------------------------------------- pickups

/** Pickup payload kinds, stored in `payload`. */
export const PickupKind = {
  Relic: 0,
  Consumable: 1,
  Coin: 2,
  Soul: 3,
  Heal: 4,
} as const;

function drawPickup(
  e: Entity,
  c: CanvasRenderingContext2D,
  t: number,
  x: number,
  y: number,
): void {
  // Bob on a sine so loose items read as pickups rather than as scenery.
  const bob = Math.sin((t + e.seed * 23) * 0.004) * 3;
  const py = y + bob;

  switch (e.payload) {
    case PickupKind.Relic: {
      const def = RELIC_REGISTRY[e.tag];
      const color = def ? RARITY_COLOR[def.rarity] : '#ffffff';
      shadow(c, x, y + 4, 7, 0.2);
      // Rarity ring, so value is legible from across a room.
      c.strokeStyle = color;
      c.globalAlpha = 0.5 + Math.sin(t * 0.005 + e.seed) * 0.2;
      ring(c, x, py, 11, 1.6);
      c.globalAlpha = 1;
      if (def) {
        c.save();
        c.translate(x, py);
        def.glyph(c, 7, def.color, t);
        c.restore();
      }
      break;
    }
    case PickupKind.Consumable: {
      const def = CONSUMABLE_REGISTRY[e.tag];
      shadow(c, x, y + 4, 6, 0.2);
      if (def) {
        c.save();
        c.translate(x, py);
        def.glyph(c, 6.5, def.color, t);
        c.restore();
      }
      break;
    }
    case PickupKind.Coin: {
      c.fillStyle = '#ffd24a';
      circle(c, x, py, 3.6);
      c.fillStyle = 'rgba(255,255,255,0.6)';
      circle(c, x - 1, py - 1, 1.3);
      break;
    }
    case PickupKind.Heal: {
      c.fillStyle = '#7ef2a1';
      c.globalAlpha = 0.4;
      circle(c, x, py, 7);
      c.globalAlpha = 1;
      c.fillStyle = '#c8ffd8';
      c.fillRect(x - 1.4, py - 4, 2.8, 8);
      c.fillRect(x - 4, py - 1.4, 8, 2.8);
      break;
    }
    default: {
      // Soul mote.
      const pulse = 1 + Math.sin(t * 0.008 + e.seed) * 0.2;
      c.fillStyle = '#b46cf0';
      c.globalAlpha = 0.4;
      circle(c, x, py, 6 * pulse);
      c.globalAlpha = 1;
      c.fillStyle = '#e0c4ff';
      circle(c, x, py, 2.6 * pulse);
    }
  }
}

// -------------------------------------------------------------- interactives

/** Interactable subtypes, stored in `payload`. */
export const InteractKind = {
  Pedestal: 0,
  Chest: 1,
  Shrine: 2,
  Shop: 3,
} as const;

function drawInteractive(
  e: Entity,
  c: CanvasRenderingContext2D,
  t: number,
  x: number,
  y: number,
): void {
  shadow(c, x, y, e.r);

  switch (e.payload) {
    case InteractKind.Chest: {
      const opened = e.state === 1;
      c.fillStyle = '#4a3a2a';
      roundRect(c, x - 14, y - 10, 28, 18, 3);
      c.fill();
      c.strokeStyle = '#ffd24a';
      c.lineWidth = 2;
      c.stroke();
      if (!opened) {
        c.fillStyle = '#6b5335';
        roundRect(c, x - 14, y - 18, 28, 10, 3);
        c.fill();
        c.strokeStyle = '#ffd24a';
        c.stroke();
        c.fillStyle = '#ffd24a';
        c.globalAlpha = 0.3 + Math.sin(t * 0.004) * 0.15;
        circle(c, x, y - 8, 3);
        c.globalAlpha = 1;
      }
      break;
    }
    case InteractKind.Shrine: {
      const used = e.state === 1;
      c.fillStyle = '#3a3446';
      trapezoid(c, x, y, 15, 0.45);
      c.fill();
      c.strokeStyle = used ? '#5a5466' : '#a8e6ff';
      c.lineWidth = 2;
      c.stroke();
      if (!used) {
        const pulse = 0.4 + Math.sin(t * 0.004) * 0.22;
        c.fillStyle = '#a8e6ff';
        c.globalAlpha = pulse;
        circle(c, x, y - 20, 6);
        c.globalAlpha = pulse * 0.5;
        circle(c, x, y - 20, 12);
        c.globalAlpha = 1;
      }
      break;
    }
    case InteractKind.Shop: {
      const sold = e.state === 1;
      c.fillStyle = '#2f3a2a';
      roundRect(c, x - 11, y - 6, 22, 14, 3);
      c.fill();
      c.strokeStyle = sold ? '#4a5442' : '#7ef2a1';
      c.lineWidth = 2;
      c.stroke();
      if (!sold) drawOffer(e, c, t, x, y - 18);
      break;
    }
    default: {
      // Weapon pedestal.
      const taken = e.state === 1;
      c.fillStyle = '#3f3a48';
      roundRect(c, x - 12, y - 4, 24, 12, 3);
      c.fill();
      c.strokeStyle = taken ? '#5a5466' : '#d8cfae';
      c.lineWidth = 2;
      c.stroke();
      if (!taken) drawOffer(e, c, t, x, y - 20);
    }
  }
}

/** The item floating above a pedestal or shop stand. */
function drawOffer(
  e: Entity,
  c: CanvasRenderingContext2D,
  t: number,
  x: number,
  y: number,
): void {
  const bob = Math.sin(t * 0.004 + e.seed) * 3;
  const relic = RELIC_REGISTRY[e.tag];
  const weapon = WEAPON_REGISTRY[e.tag];
  const consumable = CONSUMABLE_REGISTRY[e.tag];
  const def = relic ?? weapon ?? consumable;
  if (!def) return;

  const rarityColor = RARITY_COLOR[def.rarity];
  c.strokeStyle = rarityColor;
  c.globalAlpha = 0.45 + Math.sin(t * 0.005) * 0.2;
  ring(c, x, y + bob, 14, 1.6);
  c.globalAlpha = 1;

  c.save();
  c.translate(x, y + bob);
  def.glyph(c, 9, def.color, t);
  c.restore();
}

// -------------------------------------------------------------------- volumes

function drawHazardVolume(
  e: Entity,
  c: CanvasRenderingContext2D,
  t: number,
  x: number,
  y: number,
): void {
  const fade = clamp01(e.life / 600);
  c.fillStyle = e.tag;
  c.globalAlpha = 0.22 * fade;
  circle(c, x, y, e.r);
  c.globalAlpha = 0.4 * fade;
  c.strokeStyle = e.tag;
  const wobble = 1 + Math.sin(t * 0.004 + e.seed) * 0.03;
  ring(c, x, y, e.r * wobble, 2);
  c.globalAlpha = 1;
}

function drawDecoy(
  e: Entity,
  c: CanvasRenderingContext2D,
  t: number,
  x: number,
  y: number,
): void {
  shadow(c, x, y, e.r, 0.15);
  c.globalAlpha = 0.45 + Math.sin(t * 0.01) * 0.15;
  c.fillStyle = '#b46cf0';
  circle(c, x, y, e.r);
  c.strokeStyle = '#e0c4ff';
  c.lineWidth = 2;
  ring(c, x, y, e.r, 2);
  c.globalAlpha = 1;
}
