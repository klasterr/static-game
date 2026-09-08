import type { DerivedStats } from '../world/entities';

/**
 * Perks: choose one of three, every third level.
 *
 * These are deliberately build-DEFINING rather than incremental. A perk that
 * reads "+5% damage" wastes the decision; a perk that inverts how hazards work
 * changes how you route through a floor for the rest of the run.
 */

export interface PerkDef {
  id: string;
  name: string;
  desc: string;
  color: string;
  apply(s: DerivedStats): void;
  /** Perks that only make sense once, so the offer pool can exclude them. */
  unique?: boolean;
}

export const PERKS: PerkDef[] = [
  {
    id: 'extra_dodge',
    name: 'Fleetfoot',
    desc: 'Dodge recharges 45% faster.',
    color: '#a8e6ff',
    apply(s) {
      s.dodgeCdMul *= 0.55;
    },
  },
  {
    id: 'pierce_shields',
    name: 'Sundering',
    desc: 'Your attacks ignore shields and armour plates.',
    color: '#d8cfae',
    unique: true,
    apply(s) {
      s.pierceShield = true;
    },
  },
  {
    id: 'desperate',
    name: 'Desperate Edge',
    desc: '+50% damage while below 40% health.',
    color: '#c2323c',
    unique: true,
    apply(s) {
      s.lowHpDamage += 0.5;
    },
  },
  {
    id: 'kill_refresh',
    name: 'Bloodrush',
    desc: 'Kills refresh your dodge cooldown.',
    color: '#ff7a1a',
    unique: true,
    apply(s) {
      s.killRefreshesDodge = true;
    },
  },
  {
    id: 'bulwark_stance',
    name: 'Bulwark Stance',
    desc: '-25% damage taken, -15% move speed.',
    color: '#8f97a3',
    apply(s) {
      s.damageTakenMul *= 0.75;
      s.moveMul *= 0.85;
    },
  },
  {
    id: 'wide_arc',
    name: 'Wide Arc',
    desc: '+25% swing arc and +12% reach.',
    color: '#ffd24a',
    apply(s) {
      s.arcMul += 0.25;
      s.reachMul += 0.12;
    },
  },
  {
    id: 'crit_focus',
    name: 'Executioner',
    desc: '+20% critical chance and +60% critical damage.',
    color: '#c78ef0',
    apply(s) {
      s.critChance += 0.2;
      s.critMul += 0.6;
    },
  },
  {
    id: 'hazard_walker',
    name: 'Hazard Walker',
    desc: 'Hazards no longer hurt you, and deal double damage to enemies.',
    color: '#a8f06e',
    unique: true,
    apply(s) {
      // Completely rewrites how you read a floor: spike fields stop being
      // obstacles and start being weapons.
      s.hazardImmune = true;
    },
  },
];

export const PERK_BY_ID = new Map(PERKS.map((p) => [p.id, p]));

export function perkById(id: string): PerkDef | undefined {
  return PERK_BY_ID.get(id);
}
