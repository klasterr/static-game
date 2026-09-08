import { circle, fillPoly, strokePoly } from '../../render/glyphs';
import { Rarity, weapon, type WeaponDef } from '../types/item';

/**
 * Weapons change the attack VERB — arc width, reach, commitment, rhythm — which
 * is why they are the one thing in the game worth a manual choice. Relics stack
 * automatically; weapons you pick up off a pedestal and swap deliberately.
 */

export const CHIPPED_CLEAVER: WeaponDef = weapon({
  id: 'chipped_cleaver',
  name: 'Chipped Cleaver',
  desc: 'A wide, honest swing. Nothing special, always adequate.',
  rarity: Rarity.Common,
  dmg: 18,
  reach: 62,
  arcDeg: 90,
  windup: 90,
  active: 70,
  recovery: 150,
  knockback: 240,
  hitstop: 60,
  hits: 1,
  // Movement multipliers per phase. Slowing down mid-swing IS the commitment.
  windupMoveMul: 0.55,
  activeMoveMul: 0.35,
  recoveryMoveMul: 0.7,
  critBonus: 0,
  pierceShield: false,
  color: '#c9d4e2',
  glyph(c, r, color) {
    c.fillStyle = color;
    fillPoly(
      c,
      [
        [-0.15, 0.9],
        [-0.1, -0.2],
        [0.75, -0.85],
        [0.85, -0.1],
        [0.15, 0.55],
        [0.1, 0.9],
      ],
      r,
    );
    c.strokeStyle = 'rgba(0,0,0,0.45)';
    strokePoly(c, [[-0.12, 0.9], [-0.12, -0.15]], r, Math.max(1, r * 0.14));
  },
});

export const WARDENS_HALBERD: WeaponDef = weapon({
  id: 'wardens_halberd',
  name: "Warden's Halberd",
  desc: 'Slow, long, and heavy. Pierces shields and armour plates.',
  rarity: Rarity.Uncommon,
  dmg: 34,
  reach: 105,
  arcDeg: 55,
  windup: 220,
  active: 100,
  recovery: 300,
  knockback: 520,
  hitstop: 100,
  hits: 1,
  windupMoveMul: 0.3,
  activeMoveMul: 0.1,
  recoveryMoveMul: 0.4,
  critBonus: 0,
  // The direct answer to the Skeleton Warden, and a reason to keep a slow
  // weapon around even once you own something faster.
  pierceShield: true,
  color: '#d8cfae',
  glyph(c, r, color) {
    c.strokeStyle = 'rgba(0,0,0,0.5)';
    strokePoly(c, [[-0.05, 1], [0.05, -0.5]], r, Math.max(1, r * 0.16));
    c.fillStyle = color;
    fillPoly(
      c,
      [
        [0.05, -0.5],
        [0.7, -0.6],
        [0.25, -0.95],
        [0.15, -0.6],
        [-0.45, -0.6],
        [-0.05, -0.4],
      ],
      r,
    );
  },
});

export const TWIN_FANGS: WeaponDef = weapon({
  id: 'twin_fangs',
  name: 'Twin Fangs',
  desc: 'Two quick stabs per swing. Short reach, high crit.',
  rarity: Rarity.Uncommon,
  dmg: 9,
  reach: 48,
  arcDeg: 70,
  windup: 45,
  active: 50,
  recovery: 80,
  knockback: 130,
  hitstop: 40,
  // Two damage instances per swing. Static Coil counts HITS, so this is the
  // fastest way to trigger it — an interaction worth discovering.
  hits: 2,
  windupMoveMul: 0.8,
  activeMoveMul: 0.6,
  recoveryMoveMul: 0.9,
  critBonus: 0.25,
  pierceShield: false,
  color: '#a8e6ff',
  glyph(c, r, color) {
    c.fillStyle = color;
    for (const off of [-0.32, 0.32]) {
      fillPoly(
        c,
        [
          [off - 0.12, 0.85],
          [off, -0.9],
          [off + 0.12, 0.85],
        ],
        r,
      );
    }
    c.fillStyle = 'rgba(255,255,255,0.55)';
    circle(c, 0, r * 0.62, r * 0.13);
  },
});

export const WEAPONS: WeaponDef[] = [CHIPPED_CLEAVER, WARDENS_HALBERD, TWIN_FANGS];

export const WEAPON_BY_ID = new Map(WEAPONS.map((w) => [w.id, w]));

export function weaponById(id: string): WeaponDef {
  return WEAPON_BY_ID.get(id) ?? CHIPPED_CLEAVER;
}
