import { SAVE_CORRUPT_KEY, SAVE_KEY, SAVE_VERSION } from './constants';
import { clamp, isNum } from './math';

/**
 * Persistence.
 *
 * Two things about this file are load-bearing:
 *
 *  1. The `sg.` key prefix. GitHub Pages puts every one of a user's projects on
 *     the same origin (`<user>.github.io`), so localStorage is SHARED across all
 *     of them. A generic key like `save` would let another project clobber this
 *     one. The prefix is not cosmetic.
 *  2. `sanitize()` runs unconditionally on every load, not just after a
 *     migration. It is what stops a hand-edited or half-written blob from
 *     crashing the meta screen, and it filters unlock ids against the LIVE
 *     registry so renaming an unlock in a future version degrades instead of
 *     throwing.
 *
 * The game must never fail to run because storage is unavailable — private
 * browsing modes and quota errors are handled by falling back to memory.
 */

export interface Settings {
  master: number;
  sfx: number;
  music: number;
  /** Accessibility multiplier on screen shake. 0 disables it. */
  shake: number;
  /** Photosensitivity: disables full-screen flashes. */
  flashes: boolean;
  damageNumbers: boolean;
  /** Hold to attack rather than tapping. Defaults on for touch. */
  autoAttack: boolean;
  touchControls: 'auto' | 'on' | 'off';
}

export interface SaveData {
  v: number;
  souls: number;
  soulsSpent: number;
  soulsLifetime: number;
  bestDepth: number;
  runs: number;
  deaths: number;
  bossKills: number;
  unlocks: string[];
  classId: string;
  seenBiomes: string[];
  /** Whether the how-to-play card has been dismissed. */
  seenIntro: boolean;
  settings: Settings;
  stats: Record<string, number>;
}

export const DEFAULT_SETTINGS: Settings = {
  master: 0.7,
  sfx: 0.8,
  music: 0.55,
  shake: 1,
  flashes: true,
  damageNumbers: true,
  autoAttack: false,
  touchControls: 'auto',
};

export const DEFAULT_SAVE: SaveData = {
  v: SAVE_VERSION,
  souls: 0,
  soulsSpent: 0,
  soulsLifetime: 0,
  bestDepth: 0,
  runs: 0,
  deaths: 0,
  bossKills: 0,
  unlocks: [],
  classId: 'wanderer',
  seenBiomes: [],
  seenIntro: false,
  settings: { ...DEFAULT_SETTINGS },
  stats: {},
};

/** Injected by the content layer so sanitize can reject stale ids. */
let knownUnlocks: ReadonlySet<string> = new Set();
let knownClasses: ReadonlySet<string> = new Set(['wanderer']);

export function registerSaveVocabulary(
  unlockIds: readonly string[],
  classIds: readonly string[],
): void {
  knownUnlocks = new Set(unlockIds);
  knownClasses = new Set(classIds);
}

let available = true;
let cache: SaveData = clone(DEFAULT_SAVE);
let dirtyHandle: ReturnType<typeof setTimeout> | null = null;

function clone(s: SaveData): SaveData {
  return {
    ...s,
    unlocks: [...s.unlocks],
    seenBiomes: [...s.seenBiomes],
    settings: { ...s.settings },
    stats: { ...s.stats },
  };
}

export function storageAvailable(): boolean {
  return available;
}

export function loadSave(): SaveData {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(SAVE_KEY);
  } catch {
    available = false;
    cache = clone(DEFAULT_SAVE);
    return cache;
  }

  if (!raw) {
    cache = clone(DEFAULT_SAVE);
    return cache;
  }

  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    quarantine(raw);
    cache = clone(DEFAULT_SAVE);
    return cache;
  }

  if (typeof obj !== 'object' || obj === null || !isNum((obj as { v?: unknown }).v)) {
    quarantine(raw);
    cache = clone(DEFAULT_SAVE);
    return cache;
  }

  const record = obj as Record<string, unknown>;
  // A save from a NEWER version: do not guess at its shape. Quarantine and
  // start fresh rather than silently mangling it.
  if ((record.v as number) > SAVE_VERSION) {
    quarantine(raw);
    cache = clone(DEFAULT_SAVE);
    return cache;
  }

  try {
    cache = sanitize(migrate(record));
  } catch {
    quarantine(raw);
    cache = clone(DEFAULT_SAVE);
  }
  return cache;
}

export function getSave(): SaveData {
  return cache;
}

/**
 * One small step per version bump; never skip a version. Empty today, but the
 * scaffolding has to exist before the first save is written or the first change
 * becomes a breaking one.
 */
function migrate(o: Record<string, unknown>): Record<string, unknown> {
  // if (o.v === 1) { o.newField = default; o.v = 2; }
  return o;
}

function sanitize(o: Record<string, unknown>): SaveData {
  const d = DEFAULT_SAVE;
  const num = (v: unknown, def: number, lo: number, hi: number): number =>
    isNum(v) ? clamp(Math.floor(v), lo, hi) : def;
  const bool = (v: unknown, def: boolean): boolean => (typeof v === 'boolean' ? v : def);
  const unit = (v: unknown, def: number): number => (isNum(v) ? clamp(v, 0, 1) : def);

  const rawSettings =
    typeof o.settings === 'object' && o.settings !== null
      ? (o.settings as Record<string, unknown>)
      : {};

  const touch = rawSettings.touchControls;
  const touchControls: Settings['touchControls'] =
    touch === 'on' || touch === 'off' || touch === 'auto' ? touch : d.settings.touchControls;

  return {
    v: SAVE_VERSION,
    souls: num(o.souls, 0, 0, 1e9),
    soulsSpent: num(o.soulsSpent, 0, 0, 1e12),
    soulsLifetime: num(o.soulsLifetime, 0, 0, 1e12),
    bestDepth: num(o.bestDepth, 0, 0, 100000),
    runs: num(o.runs, 0, 0, 1e6),
    deaths: num(o.deaths, 0, 0, 1e6),
    bossKills: num(o.bossKills, 0, 0, 1e6),
    // Filtered against the live registry, deduplicated.
    unlocks: Array.isArray(o.unlocks)
      ? [
          ...new Set(
            o.unlocks.filter(
              (u): u is string => typeof u === 'string' && knownUnlocks.has(u),
            ),
          ),
        ]
      : [],
    classId:
      typeof o.classId === 'string' && knownClasses.has(o.classId)
        ? o.classId
        : d.classId,
    seenBiomes: Array.isArray(o.seenBiomes)
      ? o.seenBiomes.filter((b): b is string => typeof b === 'string').slice(0, 64)
      : [],
    seenIntro: bool(o.seenIntro, false),
    settings: {
      master: unit(rawSettings.master, d.settings.master),
      sfx: unit(rawSettings.sfx, d.settings.sfx),
      music: unit(rawSettings.music, d.settings.music),
      shake: unit(rawSettings.shake, d.settings.shake),
      flashes: bool(rawSettings.flashes, d.settings.flashes),
      damageNumbers: bool(rawSettings.damageNumbers, d.settings.damageNumbers),
      autoAttack: bool(rawSettings.autoAttack, d.settings.autoAttack),
      touchControls,
    },
    stats: sanitizeStats(o.stats),
  };
}

function sanitizeStats(v: unknown): Record<string, number> {
  if (typeof v !== 'object' || v === null) return {};
  const out: Record<string, number> = {};
  let count = 0;
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (count >= 128) break;
    if (typeof k !== 'string' || k.length > 48) continue;
    if (!isNum(raw)) continue;
    out[k] = clamp(Math.floor(raw), -1e12, 1e12);
    count++;
  }
  return out;
}

/** Debounced write. Cheap to call from anywhere. */
export function markDirty(): void {
  if (dirtyHandle !== null) return;
  dirtyHandle = setTimeout(() => {
    dirtyHandle = null;
    saveNow();
  }, 500);
}

/**
 * Flush immediately. Called on floor descent (so a crash mid-run does not cost
 * the whole run), on death, on an unlock purchase, on a settings change, and on
 * `visibilitychange`.
 */
export function saveNow(): void {
  if (dirtyHandle !== null) {
    clearTimeout(dirtyHandle);
    dirtyHandle = null;
  }
  if (!available) return;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(cache));
  } catch {
    // Quota exceeded, or Safari private mode. Continue in memory only rather
    // than breaking the game over a save.
    available = false;
  }
}

function quarantine(raw: string): void {
  try {
    localStorage.setItem(SAVE_CORRUPT_KEY, raw.slice(0, 20000));
  } catch {
    // Nothing useful to do; the fresh save still works.
  }
}

export function resetSave(): void {
  cache = clone(DEFAULT_SAVE);
  saveNow();
}

/** Test seam: install a save without touching localStorage. */
export function __setSaveForTests(data: SaveData): void {
  cache = data;
}

/** Test seam: run the sanitizer over arbitrary input. */
export function __sanitizeForTests(o: unknown): SaveData {
  if (typeof o !== 'object' || o === null) return clone(DEFAULT_SAVE);
  return sanitize(o as Record<string, unknown>);
}
