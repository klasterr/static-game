import { Tile } from '../../world/tiles';
import type { HazardBehavior } from '../types/biome';

/**
 * Hazard behaviours.
 *
 * `hitsEnemies: true` is the interesting flag. When a hazard damages enemies
 * too, knockback relics quietly become "shove them into the spikes" relics, and
 * players discover a whole strategy the item descriptions never mention. Spike
 * plates do this; spore vents deliberately do not, because the natives should
 * feel at home in their own biome.
 */

export const SPIKE_PLATE: HazardBehavior = {
  id: 'spike_plate',
  name: 'Spike Plate',
  tile: Tile.HazardStatic,
  period: 2050,
  warn: 500,
  active: 350,
  dps: 0,
  burst: 18,
  slow: 1,
  hitsEnemies: true,
  blocksPath: false,
  blobTiles: [6, 20],
};

export const CRUMBLING_FLOOR: HazardBehavior = {
  id: 'crumbling_floor',
  name: 'Crumbling Floor',
  tile: Tile.HazardVolatile,
  period: 0,
  warn: 0,
  active: 0,
  dps: 0,
  burst: 0,
  slow: 1,
  hitsEnemies: true,
  blocksPath: false,
  blobTiles: [4, 12],
  volatile: { triggerMs: 700, burst: 12, becomes: Tile.Pit, stun: 800 },
};

export const SPORE_VENT: HazardBehavior = {
  id: 'spore_vent',
  name: 'Spore Vent',
  tile: Tile.HazardStatic,
  period: 4000,
  warn: 700,
  active: 3000,
  dps: 4,
  burst: 0,
  slow: 0.75,
  // Fungal natives are immune, so this biome's hazard is a player problem
  // specifically — which makes the Sporeling Adept class fantasy land.
  hitsEnemies: false,
  blocksPath: false,
  blobTiles: [5, 16],
  cloud: { every: 4000, radius: 110, dps: 4, ms: 3000 },
};

export const CREEPING_ROOT: HazardBehavior = {
  id: 'creeping_root',
  name: 'Creeping Root',
  tile: Tile.HazardVolatile,
  period: 0,
  warn: 0,
  active: 0,
  dps: 0,
  burst: 0,
  slow: 0.45,
  hitsEnemies: false,
  blocksPath: false,
  blobTiles: [6, 18],
};

export const HAZARDS: HazardBehavior[] = [
  SPIKE_PLATE,
  CRUMBLING_FLOOR,
  SPORE_VENT,
  CREEPING_ROOT,
];
