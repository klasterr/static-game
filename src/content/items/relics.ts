import { TAU } from '../../core/math';
import { circle, fillPoly, ring, strokePoly } from '../../render/glyphs';
import { Rarity, type RelicDef } from '../types/item';

/**
 * Relics: auto-pickup, infinitely stacking, no inventory screen.
 *
 * The reasoning matters, because it is the single biggest structural choice in
 * the item design. The core loop is four-minute floors of continuous movement
 * with twenty-plus live enemies. Any UI that makes the player stop and read a
 * grid destroys that pacing and — worse — trains them to pause-farm, which
 * converts an action game into a spreadsheet. Walking over a relic and getting
 * stronger costs nothing and still produces combinatorial builds.
 *
 * Balance guardrail enforced by `validateContent`: no relic may grant more than
 * 15% of an uncapped multiplicative stat per stack.
 */

export const WHETSTONE: RelicDef = {
  id: 'whetstone',
  name: 'Whetstone',
  desc: '+12% attack damage.',
  rarity: Rarity.Common,
  color: '#c9d4e2',
  glyph(c, r, color) {
    c.fillStyle = color;
    fillPoly(c, [[-0.7, 0.4], [0.7, 0.15], [0.5, -0.45], [-0.5, -0.2]], r);
    c.strokeStyle = 'rgba(255,255,255,0.7)';
    strokePoly(c, [[-0.5, -0.2], [0.5, -0.45]], r, Math.max(1, r * 0.1));
  },
  apply(s, n) {
    s.dmgMul += 0.12 * n;
  },
};

export const IRON_SHARD: RelicDef = {
  id: 'iron_shard',
  name: 'Iron Shard',
  desc: '+14 max health, and heals for the same on pickup.',
  rarity: Rarity.Common,
  color: '#8f97a3',
  glyph(c, r, color) {
    c.fillStyle = color;
    fillPoly(c, [[0, -0.85], [0.6, 0], [0, 0.85], [-0.6, 0]], r);
    c.fillStyle = 'rgba(255,255,255,0.3)';
    fillPoly(c, [[0, -0.85], [0.6, 0], [0, 0]], r);
  },
  apply(s, n) {
    s.maxHpBonus += 14 * n;
  },
  onPickup(player) {
    player.hp = Math.min(player.hpMax, player.hp + 14);
  },
};

export const QUICKSILVER_VIAL: RelicDef = {
  id: 'quicksilver_vial',
  name: 'Quicksilver Vial',
  desc: '+7% move speed. Caps at +60% total.',
  rarity: Rarity.Common,
  color: '#a8e6ff',
  glyph(c, r, color) {
    c.fillStyle = color;
    c.beginPath();
    c.moveTo(0, -r * 0.85);
    c.quadraticCurveTo(r * 0.75, r * 0.2, 0, r * 0.85);
    c.quadraticCurveTo(-r * 0.75, r * 0.2, 0, -r * 0.85);
    c.closePath();
    c.fill();
    c.fillStyle = 'rgba(255,255,255,0.45)';
    circle(c, -r * 0.18, r * 0.15, r * 0.16);
  },
  apply(s, n) {
    // Move speed is capped because past a point you outrun the game's ability
    // to threaten you at all, and every enemy tell stops mattering.
    s.moveMul = Math.min(1.6, s.moveMul + 0.07 * n);
  },
};

export const HUMMINGBIRD_FANG: RelicDef = {
  id: 'hummingbird_fang',
  name: 'Hummingbird Fang',
  desc: '+9% attack speed.',
  rarity: Rarity.Common,
  color: '#ffd24a',
  glyph(c, r, color) {
    c.fillStyle = color;
    fillPoly(c, [[0, -0.9], [0.28, 0.6], [0, 0.9], [-0.28, 0.6]], r);
  },
  apply(s, n) {
    s.atkSpeedMul = Math.min(3, s.atkSpeedMul + 0.09 * n);
  },
};

export const SOUL_MAGNET: RelicDef = {
  id: 'soul_magnet',
  name: 'Soul Magnet',
  desc: 'Pickups fly to you from much further, and are worth 8% more.',
  rarity: Rarity.Common,
  color: '#b46cf0',
  glyph(c, r, color) {
    c.strokeStyle = color;
    ring(c, 0, 0, r * 0.62, Math.max(1.5, r * 0.22));
    c.fillStyle = color;
    circle(c, 0, 0, r * 0.16);
  },
  apply(s, n) {
    s.pickupRadius += 90 * n;
    s.soulMul += 0.08 * n;
    s.xpMul += 0.08 * n;
  },
};

export const BROKEN_HOURGLASS: RelicDef = {
  id: 'broken_hourglass',
  name: 'Broken Hourglass',
  desc: '+0.15s invulnerability after taking a hit. Caps at +0.6s.',
  rarity: Rarity.Uncommon,
  color: '#ffc94a',
  glyph(c, r, color) {
    c.fillStyle = color;
    fillPoly(c, [[-0.6, -0.8], [0.6, -0.8], [0, 0]], r);
    fillPoly(c, [[-0.6, 0.8], [0.6, 0.8], [0, 0]], r);
  },
  apply(s, n) {
    // Extending i-frames is what makes a Glass Fang build survivable: a 40-HP
    // character with 1.3s of invulnerability per hit can dodge-tank a swarm.
    s.iframeBonus = Math.min(600, s.iframeBonus + 150 * n);
  },
};

export const LEECH_RUNE: RelicDef = {
  id: 'leech_rune',
  name: 'Leech Rune',
  desc: 'Heal 4% of the damage you deal.',
  rarity: Rarity.Uncommon,
  color: '#c2323c',
  glyph(c, r, color) {
    c.strokeStyle = color;
    c.lineWidth = Math.max(1.5, r * 0.2);
    c.beginPath();
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      const a = t * TAU * 1.6;
      const rr = r * 0.2 + t * r * 0.6;
      const px = Math.cos(a) * rr;
      const py = Math.sin(a) * rr;
      if (i === 0) c.moveTo(px, py);
      else c.lineTo(px, py);
    }
    c.stroke();
  },
  apply(s, n) {
    s.leech += 0.04 * n;
  },
};

export const EMBER_CORE: RelicDef = {
  id: 'ember_core',
  name: 'Ember Core',
  desc: 'Your hits set enemies burning for 4 damage a second.',
  rarity: Rarity.Uncommon,
  color: '#ff7a1a',
  glyph(c, r, color) {
    c.fillStyle = color;
    circle(c, 0, 0, r * 0.42);
    c.strokeStyle = color;
    c.lineWidth = Math.max(1, r * 0.12);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      c.beginPath();
      c.moveTo(Math.cos(a) * r * 0.55, Math.sin(a) * r * 0.55);
      c.lineTo(Math.cos(a) * r * 0.9, Math.sin(a) * r * 0.9);
      c.stroke();
    }
  },
  apply(s, n) {
    // Burn is a damage-over-time tick, so it BYPASSES directional shields and
    // armour plates. Working that out is one of the better moments the item
    // pool has to offer, so it is never spelled out in the description.
    s.burnDps += 2 + 2 * n;
  },
};

export const GLASS_FANG: RelicDef = {
  id: 'glass_fang',
  name: 'Glass Fang',
  desc: '+30% damage, but -15% max health.',
  rarity: Rarity.Uncommon,
  color: '#e8f4ff',
  glyph(c, r, color) {
    c.fillStyle = color;
    fillPoly(c, [[0, -0.9], [0.35, 0.3], [0, 0.9], [-0.35, 0.3]], r);
    c.strokeStyle = 'rgba(0,0,0,0.4)';
    strokePoly(c, [[-0.2, -0.2], [0.12, 0.25], [-0.08, 0.6]], r, Math.max(1, r * 0.09));
  },
  apply(s, n) {
    s.dmgMul += 0.3 * n;
    // Multiplicative, so stacking four of these leaves you at ~52% health
    // rather than at zero. Pairs with Broken Hourglass and Second Wind into the
    // intended "glass cannon that survives" build.
    s.maxHpMul *= Math.pow(0.85, n);
  },
};

export const STATIC_COIL: RelicDef = {
  id: 'static_coil',
  name: 'Static Coil',
  desc: 'Every 6th hit chains to 3 nearby enemies. Fewer hits needed per stack.',
  rarity: Rarity.Rare,
  color: '#7ec8f2',
  glyph(c, r, color) {
    c.strokeStyle = color;
    strokePoly(
      c,
      [[-0.6, -0.8], [0.1, -0.2], [-0.35, 0.1], [0.55, 0.85]],
      r,
      Math.max(1.5, r * 0.2),
    );
  },
  apply(s, n) {
    // Counts HITS, not swings. Two-hit weapons therefore trigger it twice as
    // often, which is the intended discovery.
    s.chainEvery = Math.max(3, 6 - 0.8 * (n - 1));
    s.chainTargets = 3;
  },
};

export const RICOCHET_SIGIL: RelicDef = {
  id: 'ricochet_sigil',
  name: 'Ricochet Sigil',
  desc: 'Your attacks bounce to one extra target for 55% damage.',
  rarity: Rarity.Rare,
  color: '#f2f6fa',
  glyph(c, r, color) {
    c.strokeStyle = color;
    strokePoly(c, [[-0.7, -0.6], [0, 0.5], [0.7, -0.6]], r, Math.max(1.5, r * 0.2));
  },
  apply(s, n) {
    s.bounceTargets += n;
  },
};

export const SECOND_WIND: RelicDef = {
  id: 'second_wind',
  name: 'Second Wind',
  desc: 'Once per floor, survive a fatal hit at 1 health.',
  rarity: Rarity.Legendary,
  color: '#ffffff',
  glyph(c, r, color) {
    c.strokeStyle = color;
    c.lineWidth = Math.max(1.5, r * 0.16);
    c.beginPath();
    c.moveTo(-r * 0.7, r * 0.7);
    c.quadraticCurveTo(0, -r * 0.9, r * 0.7, r * 0.2);
    c.stroke();
    c.beginPath();
    c.moveTo(-r * 0.2, r * 0.3);
    c.quadraticCurveTo(0.1 * r, -0.2 * r, r * 0.45, r * 0.05);
    c.stroke();
  },
  apply(s, n) {
    s.secondWindMax = Math.min(3, n);
  },
};

export const RELICS: RelicDef[] = [
  WHETSTONE,
  IRON_SHARD,
  QUICKSILVER_VIAL,
  HUMMINGBIRD_FANG,
  SOUL_MAGNET,
  BROKEN_HOURGLASS,
  LEECH_RUNE,
  EMBER_CORE,
  GLASS_FANG,
  STATIC_COIL,
  RICOCHET_SIGIL,
  SECOND_WIND,
];

export const RELIC_BY_ID = new Map(RELICS.map((r) => [r.id, r]));

/** Relics available from the start; the rest arrive via meta unlocks. */
export const STARTING_RELIC_POOL = [
  'whetstone',
  'iron_shard',
  'quicksilver_vial',
  'hummingbird_fang',
  'soul_magnet',
  'broken_hourglass',
  'glass_fang',
];

export function relicById(id: string): RelicDef | undefined {
  return RELIC_BY_ID.get(id);
}
