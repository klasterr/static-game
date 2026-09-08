import type { BiomeDef } from './types/biome';
import type { EnemyDef } from './types/enemy';
import type { ConsumableDef, RelicDef, WeaponDef } from './types/item';
import { CATACOMBS } from './biomes/catacombs';
import { FUNGAL } from './biomes/fungal';
import { BOSS_ENEMIES } from './enemies/bosses';
import { CATACOMBS_ENEMIES } from './enemies/catacombs';
import { FUNGAL_ENEMIES } from './enemies/fungal';
import { CONSUMABLES } from './items/consumables';
import { RELICS } from './items/relics';
import { WEAPONS } from './items/weapons';
import { CLASSES } from './classes';
import { MODIFIERS } from './modifiers';
import { PERKS } from './perks';
import { SHRINES } from './shrines';
import { UNLOCKS } from './unlocks';

/**
 * Content registries.
 *
 * Content is TypeScript data modules with behaviours as first-class functions,
 * not JSON. Behaviours ARE the content — a Slag Hound is
 * `approach -> telegraph -> locked dash -> recover`, not a bag of stats — and
 * expressing that in JSON means writing an interpreter for a mini-language,
 * which is a week of work, untypecheckable, and always grows into an
 * unmaintainable DSL. TypeScript also gives compile-time validation of every
 * field, direct cross-references by value, and zero async content loading on a
 * static host.
 */

const ALL_ENEMIES: EnemyDef[] = [
  ...CATACOMBS_ENEMIES,
  ...FUNGAL_ENEMIES,
  ...BOSS_ENEMIES,
];

export const ENEMIES: Readonly<Record<string, EnemyDef>> = Object.freeze(
  Object.fromEntries(ALL_ENEMIES.map((e) => [e.id, e])),
);

export const BIOMES: Readonly<Record<string, BiomeDef>> = Object.freeze({
  catacombs: CATACOMBS,
  fungal: FUNGAL,
});

/** Rotation order. Biome changes every five floors, then repeats forever. */
export const BIOME_CYCLE = ['catacombs', 'fungal'] as const;

export function biomeForDepth(depth: number): BiomeDef {
  const idx = Math.floor((Math.max(1, depth) - 1) / 5) % BIOME_CYCLE.length;
  return BIOMES[BIOME_CYCLE[idx]];
}

export const RELIC_REGISTRY: Readonly<Record<string, RelicDef>> = Object.freeze(
  Object.fromEntries(RELICS.map((r) => [r.id, r])),
);

export const WEAPON_REGISTRY: Readonly<Record<string, WeaponDef>> = Object.freeze(
  Object.fromEntries(WEAPONS.map((w) => [w.id, w])),
);

export const CONSUMABLE_REGISTRY: Readonly<Record<string, ConsumableDef>> = Object.freeze(
  Object.fromEntries(CONSUMABLES.map((c) => [c.id, c])),
);

export function enemyById(id: string): EnemyDef | undefined {
  return ENEMIES[id];
}

// -------------------------------------------------------------- validation

export interface ValidationIssue {
  where: string;
  message: string;
}

/**
 * Structural and balance checks over the whole content set.
 *
 * Runs under `import.meta.env.DEV` (and in the test suite), and is tree-shaken
 * out of production. It exists because content mistakes — a roster referencing
 * a renamed enemy, a zero-weight table — surface as a crash on floor 14 rather
 * than at the call site.
 */
export function validateContent(): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const fail = (where: string, message: string): void => {
    issues.push({ where, message });
  };

  // Duplicate ids across the enemy set.
  const seen = new Set<string>();
  for (const e of ALL_ENEMIES) {
    if (seen.has(e.id)) fail(`enemy:${e.id}`, 'duplicate enemy id');
    seen.add(e.id);
  }

  for (const e of ALL_ENEMIES) {
    const s = e.stats;
    if (s.hp <= 0) fail(`enemy:${e.id}`, 'hp must be positive');
    if (s.radius <= 0) fail(`enemy:${e.id}`, 'radius must be positive');
    if (s.mass <= 0) fail(`enemy:${e.id}`, 'mass must be positive');
    if (s.damage < 0) fail(`enemy:${e.id}`, 'damage cannot be negative');
    if (s.speed < 0) fail(`enemy:${e.id}`, 'speed cannot be negative');
    if (s.knockbackResist < 0 || s.knockbackResist > 1) {
      fail(`enemy:${e.id}`, 'knockbackResist must be in [0,1]');
    }
    if (s.coins[0] > s.coins[1]) fail(`enemy:${e.id}`, 'coin range is inverted');
    if (e.pack && e.pack[0] > e.pack[1]) fail(`enemy:${e.id}`, 'pack range is inverted');
    if (typeof e.ai !== 'function') fail(`enemy:${e.id}`, 'missing ai function');
  }

  for (const [id, biome] of Object.entries(BIOMES)) {
    if (biome.id !== id) fail(`biome:${id}`, `id mismatch (${biome.id})`);
    if (biome.roster.length === 0) fail(`biome:${id}`, 'empty roster');

    let totalWeight = 0;
    for (const w of biome.roster) {
      // The check that actually saves you: after renaming an enemy, this fires
      // at boot instead of throwing when the floor tries to spawn it.
      if (!ENEMIES[w.id]) fail(`biome:${id}`, `roster references unknown enemy "${w.id}"`);
      if (w.cost <= 0) fail(`biome:${id}`, `enemy "${w.id}" has non-positive cost`);
      if (w.weight > 0) totalWeight += w.weight;
    }
    if (totalWeight <= 0) fail(`biome:${id}`, 'roster weights sum to zero');

    for (const eliteId of biome.eliteRoster) {
      if (!ENEMIES[eliteId]) {
        fail(`biome:${id}`, `eliteRoster references unknown enemy "${eliteId}"`);
      } else if (ENEMIES[eliteId].neverElite) {
        fail(`biome:${id}`, `"${eliteId}" is marked neverElite but is in eliteRoster`);
      }
    }

    for (const r of biome.lootBias.relics) {
      if (!RELIC_REGISTRY[r]) fail(`biome:${id}`, `lootBias relic "${r}" unknown`);
    }
    for (const w of biome.lootBias.weapons) {
      if (!WEAPON_REGISTRY[w]) fail(`biome:${id}`, `lootBias weapon "${w}" unknown`);
    }

    const g = biome.generator;
    if (g.kind === 'rooms' && !g.rooms) fail(`biome:${id}`, 'rooms generator without config');
    if (g.kind === 'caves' && !g.caves) fail(`biome:${id}`, 'caves generator without config');
    if (g.hazardDensity < 0 || g.hazardDensity > 0.3) {
      fail(`biome:${id}`, 'hazardDensity outside a sane range');
    }
    if (biome.palette.ambientLight < 0 || biome.palette.ambientLight > 1) {
      fail(`biome:${id}`, 'ambientLight must be in [0,1]');
    }
    if (biome.audio.drone.length === 0) fail(`biome:${id}`, 'no drone layers');
  }

  for (const r of RELICS) {
    if (!r.name) fail(`relic:${r.id}`, 'missing name');
    if (!r.desc) fail(`relic:${r.id}`, 'missing description');
    if (typeof r.glyph !== 'function') fail(`relic:${r.id}`, 'missing glyph');
    if (typeof r.apply !== 'function') fail(`relic:${r.id}`, 'missing apply');
  }

  for (const w of WEAPONS) {
    if (w.dmg <= 0) fail(`weapon:${w.id}`, 'damage must be positive');
    if (w.reach <= 0) fail(`weapon:${w.id}`, 'reach must be positive');
    if (w.hits < 1) fail(`weapon:${w.id}`, 'hits must be at least 1');
    if (w.halfArc <= 0 || w.halfArc > Math.PI) fail(`weapon:${w.id}`, 'halfArc out of range');
    if (Math.abs(Math.cos(w.halfArc) - w.cosHalfArc) > 1e-9) {
      fail(`weapon:${w.id}`, 'cosHalfArc does not match halfArc');
    }
    if (w.active <= 0) fail(`weapon:${w.id}`, 'active window must be positive');
  }

  for (const c of CONSUMABLES) {
    if (c.maxStack < 1) fail(`consumable:${c.id}`, 'maxStack must be at least 1');
    if (typeof c.use !== 'function') fail(`consumable:${c.id}`, 'missing use');
  }

  for (const c of CLASSES) {
    if (!WEAPON_REGISTRY[c.weaponId]) {
      fail(`class:${c.id}`, `starting weapon "${c.weaponId}" unknown`);
    }
    for (const r of c.startRelics) {
      if (!RELIC_REGISTRY[r]) fail(`class:${c.id}`, `starting relic "${r}" unknown`);
    }
    if (c.startConsumable && !CONSUMABLE_REGISTRY[c.startConsumable]) {
      fail(`class:${c.id}`, `starting consumable "${c.startConsumable}" unknown`);
    }
    if (c.hp <= 0) fail(`class:${c.id}`, 'hp must be positive');
  }

  for (const u of UNLOCKS) {
    if (u.cost <= 0) fail(`unlock:${u.id}`, 'cost must be positive');
    for (const g of u.grants) {
      const known =
        (u.kind === 'relics' && RELIC_REGISTRY[g]) ||
        (u.kind === 'weapons' && WEAPON_REGISTRY[g]) ||
        (u.kind === 'consumables' && CONSUMABLE_REGISTRY[g]) ||
        (u.kind === 'class' && CLASSES.some((c) => c.id === g));
      if (!known) fail(`unlock:${u.id}`, `grants unknown ${u.kind} "${g}"`);
    }
  }

  let modWeight = 0;
  for (const m of MODIFIERS) {
    if (m.weight > 0) modWeight += m.weight;
    if (m.countMul <= 0) fail(`modifier:${m.id}`, 'countMul must be positive');
    if (m.lightMul <= 0) fail(`modifier:${m.id}`, 'lightMul must be positive');
  }
  if (modWeight <= 0) fail('modifiers', 'weights sum to zero');

  if (PERKS.length < 3) fail('perks', 'need at least 3 perks to offer a choice of 3');
  if (SHRINES.length < 2) fail('shrines', 'need at least 2 shrines to offer a choice');

  return issues;
}

/** Throw on any content problem. Called at boot in dev and from the tests. */
export function assertContentValid(): void {
  const issues = validateContent();
  if (issues.length === 0) return;
  const lines = issues.map((i) => `  ${i.where}: ${i.message}`).join('\n');
  throw new Error(`Content validation failed:\n${lines}`);
}
