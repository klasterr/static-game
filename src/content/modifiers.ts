/**
 * Floor modifiers: one per floor, announced on arrival.
 *
 * The announcement is half the value. Telling the player "Fortified" before
 * they walk in primes them to play differently, which is the whole point;
 * silently making enemies tougher would just read as inconsistent balance.
 *
 * Swarm and Fortified are direct inversions of each other and reward opposite
 * builds. That is deliberate: it makes the relic choices you already committed
 * to retroactively interesting.
 *
 * These are pure data — every field is consumed by generation or by the play
 * scene, so adding a modifier never requires touching game code.
 */

export interface ModifierDef {
  id: string;
  name: string;
  desc: string;
  color: string;
  weight: number;
  /** Multiplier on the biome's light radius. */
  lightMul: number;
  /** Tiers added to every loot rarity roll on this floor. */
  rarityBoost: number;
  /** Multiplier on the initial enemy budget. */
  countMul: number;
  hpMul: number;
  dmgMul: number;
  /** Extra loot drops beyond the usual per-floor count. */
  extraItems: number;
  hideMinimap: boolean;
  /** One enemy is marked, visible through walls, worth triple souls. */
  bounty: boolean;
}

export const MODIFIERS: ModifierDef[] = [
  {
    id: 'darkened',
    name: 'Darkened',
    desc: 'The dark presses in. Everything you find is finer.',
    color: '#4a4152',
    weight: 10,
    lightMul: 0.55,
    rarityBoost: 1,
    countMul: 1,
    hpMul: 1,
    dmgMul: 1,
    extraItems: 0,
    hideMinimap: false,
    bounty: false,
  },
  {
    id: 'swarm',
    name: 'Swarm',
    desc: 'Far more of them, far frailer.',
    color: '#a8f06e',
    weight: 12,
    lightMul: 1,
    rarityBoost: 0,
    countMul: 1.7,
    hpMul: 0.6,
    dmgMul: 1,
    extraItems: 0,
    hideMinimap: false,
    bounty: false,
  },
  {
    id: 'fortified',
    name: 'Fortified',
    desc: 'Fewer of them, and each one is a wall.',
    color: '#8f97a3',
    weight: 12,
    lightMul: 1,
    rarityBoost: 0,
    countMul: 0.65,
    hpMul: 1.9,
    dmgMul: 1.2,
    extraItems: 0,
    hideMinimap: false,
    bounty: false,
  },
  {
    id: 'bounty',
    name: 'Bounty',
    desc: 'One of them is marked. Kill it for triple souls.',
    color: '#ffd24a',
    weight: 9,
    lightMul: 1,
    rarityBoost: 0,
    countMul: 1,
    hpMul: 1,
    dmgMul: 1,
    extraItems: 0,
    hideMinimap: false,
    bounty: true,
  },
  {
    id: 'silence',
    name: 'Silence',
    desc: 'No map. No marked stairs. Find your own way down.',
    color: '#567e9e',
    weight: 7,
    lightMul: 1,
    rarityBoost: 0,
    countMul: 1,
    hpMul: 1,
    dmgMul: 1,
    extraItems: 1,
    hideMinimap: true,
    bounty: false,
  },
];

export const MODIFIER_BY_ID = new Map(MODIFIERS.map((m) => [m.id, m]));

export function modifierById(id: string | null): ModifierDef | null {
  if (!id) return null;
  return MODIFIER_BY_ID.get(id) ?? null;
}

/** No modifier: the identity values, so callers never need a null check. */
export const NO_MODIFIER: ModifierDef = {
  id: 'none',
  name: '',
  desc: '',
  color: '#ffffff',
  weight: 0,
  lightMul: 1,
  rarityBoost: 0,
  countMul: 1,
  hpMul: 1,
  dmgMul: 1,
  extraItems: 0,
  hideMinimap: false,
  bounty: false,
};

/**
 * Modifiers become guaranteed from floor 16. Before that they are an occasional
 * surprise; after, they are the main source of floor-to-floor variety once the
 * biome rotation has started repeating.
 */
export function modifierChance(depth: number): number {
  if (depth < 3) return 0;
  if (depth >= 16) return 1;
  return 0.35;
}
