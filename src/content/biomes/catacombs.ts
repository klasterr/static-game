import type { BiomeDef } from '../types/biome';
import { CRUMBLING_FLOOR, SPIKE_PLATE } from './hazards';

/**
 * The Catacombs — floors 1-5, and every fifth block thereafter.
 *
 * Tight rooms and two-tile corridors, so fights happen in doorways and
 * chokepoints. Darkest biome in the game (ambient 0.13): the torch radius is
 * the play area, and that is the first thing a new player learns to respect.
 */
export const CATACOMBS: BiomeDef = {
  id: 'catacombs',
  name: 'The Catacombs',
  palette: {
    bgDeep: '#0b0a10',
    floorA: '#2a2530',
    floorB: '#221d29',
    floorSeam: '#171320',
    wallFace: '#4a4152',
    wallTop: '#6b5f76',
    wallEdge: '#8a7c96',
    corridorTint: 'rgba(0,0,0,0.18)',
    accent: '#d8cfae',
    accentGlow: '#ffb45c',
    hazard: '#b0a8a0',
    hazardWarn: '#e8443a',
    liquid: '#3a2430',
    prop: '#5a5060',
    lightColor: '#ffb45c',
    lightRadius: 210,
    ambientLight: 0.13,
  },
  wallStyle: 'mortar',
  generator: {
    kind: 'rooms',
    rooms: {
      count: [14, 20],
      w: [7, 18],
      h: [7, 14],
      margin: 3,
      corridorWidth: 2,
      loopRatio: 0.16,
      propChance: 0.05,
    },
    hazardDensity: 0.02,
    liquidDensity: 0.01,
    rubbleDensity: 0.03,
  },
  roster: [
    { id: 'bone_rat', weight: 34, cost: 1 },
    { id: 'grave_hand', weight: 20, cost: 1 },
    { id: 'bone_archer', weight: 18, cost: 2 },
    { id: 'skeleton_warden', weight: 16, cost: 3, minFloor: 2 },
  ],
  eliteRoster: ['skeleton_warden', 'bone_archer'],
  hazard: SPIKE_PLATE,
  secondaryHazard: CRUMBLING_FLOOR,
  ambient: {
    count: 45,
    color: '#d8cfae',
    size: [1, 2],
    life: [1800, 3600],
    driftX: [-6, 6],
    driftY: [2, 10],
    additive: false,
    overlay: 'fogBands',
  },
  audio: {
    drone: [
      { wave: 'sine', hz: 55, gain: 0.09 },
      { wave: 'sine', hz: 82.5, gain: 0.035, detune: -8 },
    ],
    bus: { lpHz: 400, delayS: 0.42, delayFeedback: 0.34 },
    motif: {
      // Minor pentatonic, low and slow. Sparse detuned bell.
      scaleSemis: [0, 3, 5, 7, 10],
      rootHz: 110,
      wave: 'triangle',
      decay: 2.6,
      intervalRange: [6, 12],
      gain: 0.05,
    },
    sfxTint: { hitBandHz: 900, killNoiseDecay: 0.14, pitchBias: 0 },
  },
  lootBias: {
    relics: ['iron_shard', 'broken_hourglass', 'whetstone'],
    weapons: ['wardens_halberd'],
  },
};
