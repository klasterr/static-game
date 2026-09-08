import type { Rng } from '../core/rng';
import type { Camera } from '../render/camera';
import type { Fx } from '../render/fx';
import type { BiomeDef } from '../content/types/biome';
import type { Entity } from './entities';
import type { FlowField } from './flowfield';
import type { Tilemap } from './tiles';
import type { World } from './world';

/**
 * Depth-gated behaviour escalation.
 *
 * Stats alone plateau perceptually — floor 28 and floor 34 feel identical if
 * only the numbers moved. Enemy speed in particular is capped, because past
 * about 1.35x base you cannot disengage from anything and the game stops being
 * fair. So late-game pressure comes from new *verbs* instead.
 */
export interface Escalation {
  /** f6: enemies notice you through open doorways, not just in-room. */
  aggroThroughDoors: boolean;
  /** f11: ranged enemies lead their shots by your velocity. */
  leadShots: boolean;
  /** f21: chasers gain a periodic dash. */
  chaserDash: boolean;
  /** f26: ranged enemies fire while retreating instead of stopping. */
  fireWhileRetreating: boolean;
  /** f36: a share of chasers path to your rear arc instead of straight at you. */
  flanking: boolean;
  /** f41: a share of enemies leave a damaging pool where they die. */
  deathPools: boolean;
}

export function escalationFor(depth: number): Escalation {
  return {
    aggroThroughDoors: depth >= 6,
    leadShots: depth >= 11,
    chaserDash: depth >= 21,
    fireWhileRetreating: depth >= 26,
    flanking: depth >= 36,
    deathPools: depth >= 41,
  };
}

/**
 * Everything an AI behaviour or an item effect needs, passed by reference.
 *
 * Deliberately data + system handles, not a giant method surface: behaviours
 * import the functions they need (`applyDamage`, `spawnProjectile`) directly.
 */
export interface GameCtx {
  world: World;
  map: Tilemap;
  /** The real player entity. Damage and rewards always route here. */
  player: Entity;
  /** What hostiles should chase — a decoy if one is active, else the player. */
  target: Entity;
  /** Distance field toward `target`. */
  flow: FlowField;
  fx: Fx;
  camera: Camera;
  /** Seeded per floor on `Stream.Combat`. Crit rolls, AI jitter. */
  rng: Rng;

  depth: number;
  hpMult: number;
  dmgMult: number;
  speedMult: number;
  /** Simulation clock, ms. Art animation reads this, never `performance.now()`. */
  timeMs: number;

  biome: BiomeDef;
  esc: Escalation;

  /**
   * Hitstop and slow-motion are REQUESTED here and applied by the scene after
   * the tick. Combat code therefore never needs a reference to the game loop,
   * which keeps `applyDamage` callable from tests.
   */
  hitstopRequest: number;
  slowmoScale: number;
  slowmoMs: number;

  /** Set when the player dies, so the scene can transition. */
  playerDied: boolean;

  /** Shrine of Ruin was taken on this floor: tougher enemies, extra loot. */
  ruinActive: boolean;

  /**
   * Pointer aim in WORLD coordinates, refreshed once per tick by the scene.
   * Derived rather than cached on the pointer event, so aim stays correct while
   * the camera is moving even if the mouse is still.
   */
  aimWorldX: number;
  aimWorldY: number;

  /** Settings: hold-to-attack instead of tapping. */
  autoAttack: boolean;

  /** Combined light multiplier from the floor modifier and settings. */
  lightMul: number;

  /** Countdown for the "something is coming" banner when the Wraith spawns. */
  wraithWarning: number;

  /**
   * Pickup collection is injected because it needs the run layer (souls, XP,
   * relic grants, shop prices) that `world/` must not depend on.
   */
  collectPickup(ctx: GameCtx, item: Entity): void;
}
