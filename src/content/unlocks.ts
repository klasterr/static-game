/**
 * Meta-progression unlocks.
 *
 * Five rules, all non-negotiable, because this is the part most roguelites get
 * wrong:
 *
 *  1. Every node adds VARIETY, never removes a penalty. A node reading "enemies
 *     deal 10% less damage" would retroactively make your earlier runs feel
 *     rigged, which is exactly how meta-progression turns into resentment.
 *  2. Tier 1 costs 40-90 souls and a floor-5 run earns about 108, so run 1
 *     always buys one or two nodes and run 2 has a visibly different item pool.
 *     Feeling the progression on run TWO is the single most important retention
 *     beat in the design.
 *  3. Nothing is gated except variety. The free class reaches the intended skill
 *     ceiling on its own.
 *  4. Everything is purchasable and nothing is random. No gacha.
 *  5. The tree ends. Endless DEPTH is the endgame; an endless currency
 *     treadmill is not, so there is no prestige layer and never will be.
 */

export type UnlockKind = 'relics' | 'weapons' | 'consumables' | 'class';

export interface UnlockDef {
  id: string;
  name: string;
  desc: string;
  cost: number;
  kind: UnlockKind;
  /** Item or class ids added to the pool when purchased. */
  grants: string[];
  /** Souls that must already have been spent before this appears. */
  requiresSpent?: number;
}

export const UNLOCKS: UnlockDef[] = [
  {
    id: 'field_kit',
    name: 'Field Kit',
    desc: 'Adds Adrenal Draught and Blink Powder to consumable drops.',
    cost: 40,
    kind: 'consumables',
    grants: ['adrenal_draught', 'blink_powder'],
  },
  {
    id: 'ember_cache',
    name: 'Ember Cache',
    desc: 'Adds Ember Core and Static Coil to the relic pool.',
    cost: 60,
    kind: 'relics',
    grants: ['ember_core', 'static_coil'],
  },
  {
    id: 'bloom_cache',
    name: 'Bloom Cache',
    desc: 'Adds Leech Rune to the relic pool.',
    cost: 60,
    kind: 'relics',
    grants: ['leech_rune'],
  },
  {
    id: 'frost_cache',
    name: 'Frost Cache',
    desc: 'Adds Ricochet Sigil and Second Wind to the relic pool.',
    cost: 60,
    kind: 'relics',
    grants: ['ricochet_sigil', 'second_wind'],
  },
  {
    id: 'armory_1',
    name: 'Armoury I',
    desc: "Adds the Warden's Halberd to weapon pedestals.",
    cost: 80,
    kind: 'weapons',
    grants: ['wardens_halberd'],
  },
  {
    id: 'armory_2',
    name: 'Armoury II',
    desc: 'Adds Twin Fangs to weapon pedestals.',
    cost: 90,
    kind: 'weapons',
    grants: ['twin_fangs'],
  },
  {
    id: 'class_gravebound',
    name: 'Gravebound',
    desc: 'Unlocks a slow, armoured class that heals by killing.',
    cost: 250,
    kind: 'class',
    grants: ['gravebound'],
    requiresSpent: 200,
  },
];

export const UNLOCK_BY_ID = new Map(UNLOCKS.map((u) => [u.id, u]));

export function unlockById(id: string): UnlockDef | undefined {
  return UNLOCK_BY_ID.get(id);
}

export const TOTAL_UNLOCK_COST = UNLOCKS.reduce((sum, u) => sum + u.cost, 0);

/** Is this node offered yet, given how much has already been spent? */
export function unlockAvailable(u: UnlockDef, soulsSpent: number): boolean {
  return u.requiresSpent === undefined || soulsSpent >= u.requiresSpent;
}
