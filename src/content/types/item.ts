import type { DerivedStats, Entity } from '../../world/entities';
import type { GameCtx } from '../../world/ctx';

export const Rarity = {
  Common: 0,
  Uncommon: 1,
  Rare: 2,
  Legendary: 3,
} as const;
export type RarityId = (typeof Rarity)[keyof typeof Rarity];

export const RARITY_NAME = ['Common', 'Uncommon', 'Rare', 'Legendary'] as const;
export const RARITY_COLOR = ['#b9b3a6', '#7ec8f2', '#c78ef0', '#ffc94a'] as const;

/**
 * Every item is drawn as a small procedural glyph — there are no image assets.
 * The glyph function gets a unit-ish box centred on (0,0) with radius `r`.
 */
export type GlyphFn = (
  c: CanvasRenderingContext2D,
  r: number,
  color: string,
  t: number,
) => void;

export interface WeaponDef {
  id: string;
  name: string;
  desc: string;
  rarity: RarityId;
  /** Damage per hit, before multipliers. */
  dmg: number;
  /** Cone reach from the player's centre, world px. */
  reach: number;
  /** Half-angle of the swing cone, radians. */
  halfArc: number;
  /** Precomputed `cos(halfArc)` — no trig in the hot path. */
  cosHalfArc: number;
  windup: number;
  active: number;
  recovery: number;
  knockback: number;
  hitstop: number;
  /** Damage instances per swing. Twin Fangs is 2. */
  hits: number;
  /** Movement speed multipliers per phase. Commitment is the feel. */
  windupMoveMul: number;
  activeMoveMul: number;
  recoveryMoveMul: number;
  critBonus: number;
  /** Ignores directional shields and armour plates. */
  pierceShield: boolean;
  /** Ranged weapons fire a projectile instead of swinging a cone. */
  projectile?: {
    speed: number;
    radius: number;
    range: number;
    pierce: number;
    /** Lobbed shells arc to a target point and leave a pool. */
    lob?: { travel: number; poolRadius: number; poolDps: number; poolMs: number };
    /** Fan of N shots spread over this arc. */
    fan?: { count: number; spread: number };
  };
  glyph: GlyphFn;
  color: string;
}

export interface RelicDef {
  id: string;
  name: string;
  desc: string;
  rarity: RarityId;
  color: string;
  glyph: GlyphFn;
  /** Fold this relic's contribution into the derived stat block. */
  apply(stats: DerivedStats, stacks: number): void;
  /** Relics that also change max HP need this so the bonus applies at pickup. */
  onPickup?(player: Entity, ctx: GameCtx, stacks: number): void;
}

export interface ConsumableDef {
  id: string;
  name: string;
  desc: string;
  rarity: RarityId;
  color: string;
  glyph: GlyphFn;
  maxStack: number;
  /** Return false to refuse the use (e.g. already at full health). */
  use(player: Entity, ctx: GameCtx): boolean;
}

export type ItemKind = 'relic' | 'weapon' | 'consumable';

export interface ItemRef {
  kind: ItemKind;
  id: string;
}

/** Helper so weapon literals stay readable: degrees in, radians cached out. */
export function weapon(
  def: Omit<WeaponDef, 'halfArc' | 'cosHalfArc'> & { arcDeg: number },
): WeaponDef {
  const halfArc = ((def.arcDeg * 0.5) * Math.PI) / 180;
  const { arcDeg: _arcDeg, ...rest } = def;
  return { ...rest, halfArc, cosHalfArc: Math.cos(halfArc) };
}
