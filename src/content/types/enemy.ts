import type { Entity } from '../../world/entities';
import type { GameCtx } from '../../world/ctx';

/**
 * Outline families. With no image assets, readability at 20-50px comes from a
 * distinct silhouette plus a distinct motion verb. Two enemies may share a
 * colour if their family and motion differ; never both.
 */
export type ShapeFamily =
  | 'triangle'
  | 'rect'
  | 'blob'
  | 'hex'
  | 'chevron'
  | 'diamond'
  | 'circle'
  | 'wedge'
  | 'spikes'
  | 'trapezoid'
  | 'spine';

export type EnemyTag =
  | 'flying'
  | 'swarm'
  | 'ranged'
  | 'armored'
  | 'exploder'
  | 'immobile'
  | 'minion'
  | 'undead'
  | 'fungal'
  | 'splitter'
  | 'boss';

export interface DamageEvent {
  amount: number;
  /** Where the hit came from, for shield-arc and knockback direction. */
  srcX: number;
  srcY: number;
  /** Damage-over-time ticks bypass directional shields and armour plates. */
  isDot: boolean;
  isCrit: boolean;
  /** Attacker ignores shields entirely (Warden's Halberd, a perk). */
  pierceShield: boolean;
}

export interface EnemyStats {
  hp: number;
  damage: number;
  /** px/s */
  speed: number;
  radius: number;
  /** 0..1, fraction of incoming knockback ignored. */
  knockbackResist: number;
  mass: number;
  /** Damages the player by touching them. */
  contactDamage: boolean;
  xp: number;
  /** Inclusive coin drop range. */
  coins: [number, number];
  souls: number;
  /** Ablative shell absorbing all damage until broken. 0 = none. */
  shell?: number;
  /** Light emitted, world px. Glowing enemies read beautifully in the dark. */
  light?: number;
}

export interface EnemyVisual {
  family: ShapeFamily;
  body: string;
  accent: string;
  glow?: string;
  outlineWidth: number;
  /** Full custom draw, overriding `family`. Must be deterministic in `t`. */
  draw?(c: CanvasRenderingContext2D, e: Entity, t: number): void;
}

export interface EnemyDef {
  id: string;
  name: string;
  stats: EnemyStats;
  visual: EnemyVisual;
  tags: readonly EnemyTag[];

  /** Called once when the entity is spawned, after stats are applied. */
  init?(e: Entity, ctx: GameCtx): void;

  /** One AI tick. `dt` in seconds. */
  ai(e: Entity, ctx: GameCtx, dt: number): void;

  /** Splitting, exploding, leaving a pool. */
  onDeath?(e: Entity, ctx: GameCtx): void;

  /** Directional shields, armour plates. Return the damage that gets through. */
  modifyIncoming?(e: Entity, dmg: DamageEvent): number;

  /** Ground-layer telegraph, drawn under entities so it is never obscured. */
  drawTelegraph?(c: CanvasRenderingContext2D, e: Entity, t: number): void;

  /**
   * Spawns in a clump of this many, rather than singly. Grave Hands and Bone
   * Rats read completely differently in packs.
   */
  pack?: [number, number];

  /** Cannot be selected as an elite (minions, exploders). */
  neverElite?: boolean;
}

/** Roster entry: how likely, how much of the floor budget it consumes. */
export interface EnemyWeight {
  id: string;
  weight: number;
  /** Budget cost. A 5-cost juggernaut crowds out five 1-cost swarmers. */
  cost: number;
  minFloor?: number;
  maxPerFloor?: number;
}
