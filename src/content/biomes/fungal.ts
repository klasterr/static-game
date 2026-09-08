import type { BiomeDef } from '../types/biome';
import { CREEPING_ROOT, SPORE_VENT } from './hazards';

/**
 * The Fungal Caves — floors 6-10, and every fifth block thereafter.
 *
 * Cellular-automata caverns instead of rooms, which changes the fight rather
 * than just the colour: open space means swarms surround you and cover is a
 * blob of rock you circle rather than a doorway you hold. Brighter than the
 * Catacombs (ambient 0.20) with glowing purple caps as the light source, so
 * arriving here reads as a change of place, not a reskin.
 */
export const FUNGAL: BiomeDef = {
  id: 'fungal',
  name: 'The Fungal Caves',
  palette: {
    bgDeep: '#07120e',
    floorA: '#1d3a2a',
    floorB: '#17301f',
    floorSeam: '#102117',
    wallFace: '#2f5a3f',
    wallTop: '#4a7d55',
    wallEdge: '#6b9c6f',
    corridorTint: 'rgba(0,20,10,0.20)',
    accent: '#7ef2a1',
    accentGlow: '#b46cf0',
    hazard: '#a8f06e',
    hazardWarn: '#d9ff8a',
    liquid: '#1b4a33',
    prop: '#8f5bb8',
    lightColor: '#b46cf0',
    lightRadius: 240,
    ambientLight: 0.2,
  },
  wallStyle: 'organic',
  generator: {
    kind: 'caves',
    caves: {
      fillP: 0.47,
      smoothIters: 5,
      minRegionFrac: 0.3,
      reconnectMinSize: 60,
      lakeBlobs: [4, 8],
      lakeSize: [20, 70],
    },
    hazardDensity: 0.055,
    liquidDensity: 0.045,
    rubbleDensity: 0.02,
  },
  roster: [
    { id: 'spore_puff', weight: 30, cost: 1 },
    { id: 'myconid_splitter', weight: 22, cost: 3 },
    { id: 'cap_slinger', weight: 20, cost: 2 },
    // A deliberate carry-over from the Catacombs. One familiar face stops a new
    // biome feeling like a different game and keeps the roster feeling connected.
    { id: 'bone_rat', weight: 14, cost: 1 },
    { id: 'bone_archer', weight: 12, cost: 2 },
  ],
  eliteRoster: ['myconid_splitter', 'cap_slinger'],
  hazard: SPORE_VENT,
  secondaryHazard: CREEPING_ROOT,
  ambient: {
    count: 70,
    color: '#7ef2a1',
    size: [1, 2.4],
    life: [2200, 4200],
    driftX: [-8, 8],
    driftY: [-18, -6],
    additive: true,
    overlay: 'none',
  },
  audio: {
    drone: [
      { wave: 'sine', hz: 65.4, gain: 0.07 },
      // A breathing noise bed. The slow LFO is what makes the caves feel alive.
      { wave: 'noise', hz: 0, gain: 0.05, lpHz: 700, lfoHz: 0.15, lfoDepth: 0.7 },
    ],
    bus: { lpHz: 700, delayS: 0.28, delayFeedback: 0.22 },
    motif: {
      // Major pentatonic, plucked and short — wet and organic against the
      // Catacombs' long minor bells.
      scaleSemis: [0, 2, 4, 7, 9],
      rootHz: 261.6,
      wave: 'sine',
      decay: 0.5,
      intervalRange: [2, 4],
      gain: 0.045,
    },
    sfxTint: { hitBandHz: 500, killNoiseDecay: 0.22, pitchBias: -3 },
  },
  lootBias: {
    relics: ['leech_rune', 'ember_core', 'soul_magnet'],
    weapons: ['twin_fangs'],
  },
};
