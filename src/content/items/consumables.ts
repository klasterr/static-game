import { TILE } from '../../core/constants';
import { PKind } from '../../render/fx';
import { circle, fillPoly, roundRect } from '../../render/glyphs';
import { Tint } from '../../render/lighting';
import { nearestFree } from '../../world/collision';
import { healPlayer } from '../../world/combat';
import { Rarity, type ConsumableDef } from '../types/item';

/**
 * Consumables sit in one or two quick-slots and fire on a keypress. No menu, no
 * pause — using an item has to be as fast as dodging, or nobody uses one.
 */

export const BANDAGE: ConsumableDef = {
  id: 'bandage',
  name: 'Bandage',
  desc: 'Heal 35 health.',
  rarity: Rarity.Common,
  color: '#f0e6d2',
  maxStack: 3,
  glyph(c, r, color) {
    c.fillStyle = color;
    c.save();
    c.rotate(-0.5);
    roundRect(c, -r * 0.85, -r * 0.3, r * 1.7, r * 0.6, r * 0.2);
    c.fill();
    c.fillStyle = '#c2323c';
    c.fillRect(-r * 0.12, -r * 0.3, r * 0.24, r * 0.6);
    c.restore();
  },
  use(player, ctx) {
    // Refuse at full health rather than wasting the stack silently.
    if (player.hp >= player.hpMax - 0.5) return false;
    healPlayer(ctx, 35);
    return true;
  },
};

export const ADRENAL_DRAUGHT: ConsumableDef = {
  id: 'adrenal_draught',
  name: 'Adrenal Draught',
  desc: '+40% attack speed and +20% move speed for 8 seconds.',
  rarity: Rarity.Uncommon,
  color: '#ffd24a',
  maxStack: 3,
  glyph(c, r, color) {
    c.fillStyle = color;
    roundRect(c, -r * 0.36, -r * 0.5, r * 0.72, r * 1.2, r * 0.16);
    c.fill();
    c.fillStyle = 'rgba(255,255,255,0.5)';
    c.fillRect(-r * 0.2, -r * 0.85, r * 0.4, r * 0.4);
    c.fillStyle = '#ff7a1a';
    fillPoly(c, [[-0.16, 0.36], [0.06, -0.02], [-0.04, -0.02], [0.16, -0.4]], r);
  },
  use(player, ctx) {
    const p = player.player;
    if (!p) return false;
    p.buffAtkSpeedT = 8000;
    p.buffMoveT = 8000;
    ctx.fx.burst(player.x, player.y, {
      color: '#ffd24a',
      count: 22,
      speed: [60, 200],
      size: [1.6, 3.4],
      life: [300, 620],
      additive: true,
    });
    ctx.fx.transientLight(player.x, player.y, 180, 320, Tint.Warm);
    return true;
  },
};

export const BLINK_POWDER: ConsumableDef = {
  id: 'blink_powder',
  name: 'Blink Powder',
  desc: 'Teleport 220px forward, with brief invulnerability.',
  rarity: Rarity.Uncommon,
  color: '#b46cf0',
  maxStack: 3,
  glyph(c, r, color) {
    c.fillStyle = color;
    for (let i = 0; i < 3; i++) {
      c.globalAlpha = 0.35 + i * 0.3;
      circle(c, -r * 0.5 + i * r * 0.45, 0, r * (0.2 + i * 0.1));
    }
    c.globalAlpha = 1;
  },
  use(player, ctx) {
    const p = player.player;
    if (!p) return false;
    const dx = p.aimX;
    const dy = p.aimY;

    // Walk backwards from the full distance until a legal spot is found, so the
    // blink never drops the player inside geometry.
    let landedX = player.x;
    let landedY = player.y;
    for (let d = 220; d >= 40; d -= 20) {
      const tx = player.x + dx * d;
      const ty = player.y + dy * d;
      if (ctx.map.isBlocked(Math.floor(tx / TILE), Math.floor(ty / TILE))) continue;
      const spot = nearestFree(ctx.map, tx, ty, player.r, 3);
      landedX = spot.x;
      landedY = spot.y;
      break;
    }
    if (landedX === player.x && landedY === player.y) return false;

    for (let i = 0; i < 10; i++) {
      const t = i / 10;
      ctx.fx.particle(
        player.x + (landedX - player.x) * t,
        player.y + (landedY - player.y) * t,
        (Math.random() - 0.5) * 30,
        (Math.random() - 0.5) * 30,
        '#b46cf0',
        2.4,
        320,
        PKind.Dot,
        true,
        0.3,
      );
    }

    player.x = landedX;
    player.y = landedY;
    // Reset interpolation or the player smears across the room for one frame.
    player.px = landedX;
    player.py = landedY;
    player.iframes = Math.max(player.iframes, 400);
    ctx.fx.burst(landedX, landedY, {
      color: '#d0a4ff',
      count: 18,
      speed: [50, 190],
      size: [1.6, 3.4],
      life: [240, 500],
      additive: true,
    });
    ctx.fx.transientLight(landedX, landedY, 160, 260, Tint.Purple);
    return true;
  },
};

export const CONSUMABLES: ConsumableDef[] = [BANDAGE, ADRENAL_DRAUGHT, BLINK_POWDER];

export const CONSUMABLE_BY_ID = new Map(CONSUMABLES.map((c) => [c.id, c]));

/** Available before any meta unlock; Field Kit adds the other two. */
export const STARTING_CONSUMABLE_POOL = ['bandage'];

export function consumableById(id: string): ConsumableDef | undefined {
  return CONSUMABLE_BY_ID.get(id);
}
