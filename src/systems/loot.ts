import type { Rng } from '../core/rng';
import type { SaveData } from '../core/storage';
import {
  CONSUMABLE_REGISTRY,
  RELIC_REGISTRY,
  WEAPON_REGISTRY,
} from '../content';
import { STARTING_CONSUMABLE_POOL } from '../content/items/consumables';
import { STARTING_RELIC_POOL } from '../content/items/relics';
import { Rarity, type RarityId } from '../content/types/item';
import { UNLOCKS, unlockById } from '../content/unlocks';
import { rarityWeights } from './scaling';

/**
 * Loot pools and rarity rolls.
 *
 * The unlock system works by widening these pools, never by making drops
 * stronger. That is what keeps meta-progression feeling like discovery instead
 * of like a power gate — a run-1 player and a run-20 player face the same
 * numbers, they just draw from a different deck.
 */

export interface LootPools {
  relics: string[];
  weapons: string[];
  consumables: string[];
}

export function poolsFor(save: SaveData): LootPools {
  const relics = new Set(STARTING_RELIC_POOL);
  const consumables = new Set(STARTING_CONSUMABLE_POOL);
  // The starting weapon is always available so a pedestal can always offer a
  // downgrade-to-faster option.
  const weapons = new Set<string>(['chipped_cleaver']);

  for (const id of save.unlocks) {
    const u = unlockById(id);
    if (!u) continue;
    for (const g of u.grants) {
      if (u.kind === 'relics') relics.add(g);
      else if (u.kind === 'weapons') weapons.add(g);
      else if (u.kind === 'consumables') consumables.add(g);
    }
  }

  return {
    relics: [...relics].filter((id) => RELIC_REGISTRY[id] !== undefined),
    weapons: [...weapons].filter((id) => WEAPON_REGISTRY[id] !== undefined),
    consumables: [...consumables].filter((id) => CONSUMABLE_REGISTRY[id] !== undefined),
  };
}

/** Everything, ignoring unlocks. Used by the meta screen's preview. */
export function fullPools(): LootPools {
  return {
    relics: Object.keys(RELIC_REGISTRY),
    weapons: Object.keys(WEAPON_REGISTRY),
    consumables: Object.keys(CONSUMABLE_REGISTRY),
  };
}

export function rollRarity(rng: Rng, depth: number, boost = 0): RarityId {
  // The Legendary share is whatever is left, so the four weights always sum
  // to exactly 1 regardless of float drift in `rarityWeights`.
  const [c, u, r] = rarityWeights(depth);
  const roll = rng.next();
  let tier: number;
  if (roll < c) tier = Rarity.Common;
  else if (roll < c + u) tier = Rarity.Uncommon;
  else if (roll < c + u + r) tier = Rarity.Rare;
  else tier = Rarity.Legendary;
  return Math.min(Rarity.Legendary, tier + boost) as RarityId;
}

/**
 * Pick a relic at (or near) a rarity.
 *
 * Falls back to a lower tier when the pool has nothing at the rolled rarity,
 * which happens constantly early on: with only the starting pool unlocked there
 * are no Legendary relics to hand out, and a Legendary roll should still give
 * you something good rather than nothing.
 */
export function pickRelic(
  rng: Rng,
  pools: LootPools,
  rarity: RarityId,
  biasIds: readonly string[] = [],
): string | null {
  for (let tier = rarity; tier >= Rarity.Common; tier--) {
    const candidates = pools.relics.filter((id) => RELIC_REGISTRY[id].rarity === tier);
    if (candidates.length === 0) continue;
    // Biome bias: a weighted nudge, not a guarantee, so biomes have flavour
    // without becoming the only place to find a thing.
    const biased = candidates.filter((id) => biasIds.includes(id));
    if (biased.length > 0 && rng.chance(0.4)) return rng.pick(biased);
    return rng.pick(candidates);
  }
  return pools.relics.length > 0 ? rng.pick(pools.relics) : null;
}

export function pickWeapon(
  rng: Rng,
  pools: LootPools,
  exclude: string | null,
  biasIds: readonly string[] = [],
): string | null {
  const candidates = pools.weapons.filter((id) => id !== exclude);
  if (candidates.length === 0) return null;
  const biased = candidates.filter((id) => biasIds.includes(id));
  if (biased.length > 0 && rng.chance(0.45)) return rng.pick(biased);
  return rng.pick(candidates);
}

export function pickConsumable(rng: Rng, pools: LootPools): string | null {
  if (pools.consumables.length === 0) return null;
  return rng.pick(pools.consumables);
}

/**
 * Drops per floor. Six to nine acquisitions is the target: fast enough that
 * every floor changes your character, slow enough that a single pickup matters.
 */
export interface DropPlan {
  relics: number;
  consumables: number;
  /** A weapon pedestal appears on roughly every third floor. */
  pedestal: boolean;
}

export function planDrops(
  rng: Rng,
  depth: number,
  bonusRelics: number,
  extraItems: number,
): DropPlan {
  return {
    relics: rng.int(3, 5) + bonusRelics + extraItems,
    consumables: rng.int(2, 3),
    // Guaranteed on floor 1 so the swap mechanic is taught immediately.
    pedestal: depth === 1 || rng.chance(0.34),
  };
}

/** Total soul value of everything an enemy drops, before multipliers. */
export function soulValue(base: number, elite: boolean, trickle: boolean): number {
  if (trickle) return 0;
  return elite ? base * 3 : base;
}

export const ALL_UNLOCK_IDS = UNLOCKS.map((u) => u.id);
