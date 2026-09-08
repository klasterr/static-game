import type { TileId } from '../../world/tiles';
import type { EnemyWeight } from './enemy';

/**
 * The whole biome palette in one object. Because every colour lives here,
 * `hueShift(palette, deg)` at level-load reskins an entire biome in ~30 lines
 * with no rendering changes — which is free content when there are no assets.
 */
export interface Palette {
  /** Canvas clear colour, seen beyond every light. */
  bgDeep: string;
  floorA: string;
  floorB: string;
  floorSeam: string;
  /** Vertical face of a wall — the part notionally facing the camera. */
  wallFace: string;
  /** Top cap, drawn a few px higher to fake height. */
  wallTop: string;
  /** 1px highlight along the top-front edge. */
  wallEdge: string;
  /** Overlay tint on corridor tiles, to read them as different from rooms. */
  corridorTint: string;
  /** Biome signature colour: props, UI trim, floor detail. */
  accent: string;
  /** Additive glow colour for emitters. */
  accentGlow: string;
  hazard: string;
  hazardWarn: string;
  liquid: string;
  prop: string;
  /** Torch light tint. */
  lightColor: string;
  lightRadius: number;
  /** 0..1 brightness of unlit floor. Higher = friendlier biome. */
  ambientLight: number;
}

export type WallStyleId = 'mortar' | 'organic' | 'plate' | 'faceted';

export interface GeneratorConfig {
  kind: 'rooms' | 'caves';
  rooms?: {
    count: [number, number];
    w: [number, number];
    h: [number, number];
    /** Minimum gap between rooms, in tiles. Bigger = more negative space. */
    margin: number;
    corridorWidth: 2 | 3;
    /** Extra non-tree edges as a fraction of room count. Loops matter: a
     *  dead-end corridor with eight chasers in it is not a fight. */
    loopRatio: number;
    propChance: number;
  };
  caves?: {
    /** Initial random wall probability. Lower = larger caverns. */
    fillP: number;
    smoothIters: number;
    /** Regenerate if the main region is smaller than this fraction of the map. */
    minRegionFrac: number;
    /** Detached regions at least this big get tunnelled back in. */
    reconnectMinSize: number;
    lakeBlobs: [number, number];
    lakeSize: [number, number];
  };
  /** Fraction of walkable tiles turned into the biome hazard. */
  hazardDensity: number;
  liquidDensity: number;
  rubbleDensity: number;
}

/**
 * Tile hazards are stateless by design: the activation phase is derived from
 * the floor clock plus a per-tile hash, so hundreds of spike plates cost
 * nothing to simulate and never all fire in unison.
 */
export interface HazardBehavior {
  id: string;
  name: string;
  tile: TileId;
  /** Full cycle length, ms. 0 means always-on (lava). */
  period: number;
  /** Telegraph portion at the start of the cycle. */
  warn: number;
  /** Damaging portion, immediately after the warning. */
  active: number;
  /** Continuous damage per second while standing in it. */
  dps: number;
  /** One-shot damage when the active window opens. */
  burst: number;
  /** Movement multiplier while standing in it. 1 = no slow. */
  slow: number;
  /**
   * Whether it damages enemies too. When true, knockback builds turn into
   * shove-them-into-the-hazard builds, which is a good thing to allow.
   */
  hitsEnemies: boolean;
  blocksPath: boolean;
  /** Blob size range when the generator paints it. Blobs, never speckle. */
  blobTiles: [number, number];
  /** Periodically spawns a growing cloud entity (spore vents). */
  cloud?: { every: number; radius: number; dps: number; ms: number };
  /** Volatile tiles change state after sustained contact (thin ice). */
  volatile?: { triggerMs: number; burst: number; becomes: TileId; stun: number };
}

export interface AmbientDef {
  /** Steady-state particle count within view. */
  count: number;
  color: string;
  size: [number, number];
  life: [number, number];
  /** Drift velocity ranges, px/s. */
  driftX: [number, number];
  driftY: [number, number];
  additive: boolean;
  overlay: 'none' | 'fogBands' | 'heatShimmer' | 'driftFog';
}

export type DroneWave = 'sine' | 'triangle' | 'sawtooth' | 'square' | 'noise';

export interface DroneLayer {
  wave: DroneWave;
  hz: number;
  gain: number;
  detune?: number;
  /** Low-pass on this layer only. */
  lpHz?: number;
  /** Slow amplitude wobble. */
  lfoHz?: number;
  lfoDepth?: number;
}

export interface AudioDef {
  drone: DroneLayer[];
  bus: { lpHz: number; delayS: number; delayFeedback: number };
  /** Sparse melodic layer. Semitone offsets from `rootHz`. */
  motif: {
    scaleSemis: number[];
    rootHz: number;
    wave: DroneWave;
    decay: number;
    intervalRange: [number, number];
    gain: number;
  };
  /** Rhythmic industrial clank, Foundry-style. Omit for none. */
  pulse?: { bpm: number; bandHz: number; q: number; gain: number };
  /** Character overrides for the shared hit/kill/pickup sounds. */
  sfxTint: { hitBandHz: number; killNoiseDecay: number; pitchBias: number };
}

export interface BiomeDef {
  id: string;
  name: string;
  palette: Palette;
  wallStyle: WallStyleId;
  generator: GeneratorConfig;
  roster: EnemyWeight[];
  /** Which species may spawn as elites here. */
  eliteRoster: string[];
  hazard: HazardBehavior;
  /** Used from floor 26, when hazards double up. */
  secondaryHazard?: HazardBehavior;
  ambient: AmbientDef;
  audio: AudioDef;
  /** Relic/weapon ids this biome favours in its drop pool. */
  lootBias: { relics: string[]; weapons: string[] };
}

/**
 * Shift every colour in a palette around the hue wheel. Used by the floor-21+
 * remix system to make a familiar biome read as somewhere new.
 */
export function hueShift(p: Palette, deg: number): Palette {
  if (deg === 0) return p;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    out[k] = typeof v === 'string' ? shiftColor(v, deg) : v;
  }
  return out as unknown as Palette;
}

/** Hue-rotate a `#rgb`, `#rrggbb` or `rgba(...)` string. */
export function shiftColor(color: string, deg: number): string {
  const rgba = parseColor(color);
  if (!rgba) return color;
  const [h, s, l] = rgbToHsl(rgba[0], rgba[1], rgba[2]);
  const [r, g, b] = hslToRgb((h + deg / 360 + 1) % 1, s, l);
  if (rgba[3] < 1) return `rgba(${r},${g},${b},${rgba[3]})`;
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

export function parseColor(c: string): [number, number, number, number] | null {
  const s = c.trim();
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    if (hex.length === 3) {
      return [
        parseInt(hex[0] + hex[0], 16),
        parseInt(hex[1] + hex[1], 16),
        parseInt(hex[2] + hex[2], 16),
        1,
      ];
    }
    if (hex.length === 6) {
      return [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
        1,
      ];
    }
    return null;
  }
  const m = s.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/);
  if (!m) return null;
  return [
    Math.round(Number(m[1])),
    Math.round(Number(m[2])),
    Math.round(Number(m[3])),
    m[4] === undefined ? 1 : Number(m[4]),
  ];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0)) / 6;
  else if (max === gg) h = ((bb - rr) / d + 2) / 6;
  else h = ((rr - gg) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return [
    Math.round(f(h + 1 / 3) * 255),
    Math.round(f(h) * 255),
    Math.round(f(h - 1 / 3) * 255),
  ];
}

/** Blend two colours; used to lerp an accent toward a guest biome's. */
export function mixColor(a: string, b: string, t: number): string {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb) return a;
  const r = Math.round(ca[0] + (cb[0] - ca[0]) * t);
  const g = Math.round(ca[1] + (cb[1] - ca[1]) * t);
  const bl = Math.round(ca[2] + (cb[2] - ca[2]) * t);
  const al = ca[3] + (cb[3] - ca[3]) * t;
  if (al < 1) return `rgba(${r},${g},${bl},${al})`;
  return `#${((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1)}`;
}

/** `rgba()` string from a hex colour plus an alpha. Precompute; never per-frame. */
export function withAlpha(color: string, alpha: number): string {
  const c = parseColor(color);
  if (!c) return color;
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}
