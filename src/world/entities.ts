import { PLAYER_BASE_HP, PLAYER_BASE_SPEED, PLAYER_RADIUS } from '../core/constants';
import type { EnemyDef } from '../content/types/enemy';
import type { WeaponDef } from '../content/types/item';

/**
 * Entity kinds. Deliberately few: enemy *variety* lives in `EnemyDef`, not
 * here, so adding a monster never touches this enum.
 */
export const EKind = {
  Player: 0,
  Enemy: 1,
  Projectile: 2,
  /** Relic, consumable, coin, soul mote, heal mote. `payload` disambiguates. */
  Pickup: 3,
  /** Pedestal, shrine, stairs, chest. `interact` disambiguates. */
  Interactive: 4,
  /** Timed area effect: acid pool, spore cloud, fire patch, shockwave. */
  Hazard: 5,
  /** Void Split decoy — taunts enemies, no damage. */
  Decoy: 6,
} as const;
export type EKindId = (typeof EKind)[keyof typeof EKind];

/** 0 = friendly to the player, 1 = hostile. */
export type Team = 0 | 1;
export const TEAM_PLAYER: Team = 0;
export const TEAM_HOSTILE: Team = 1;

export const Flags = {
  None: 0,
  /** Participates in entity-vs-entity separation. */
  Pushable: 1 << 0,
  Damageable: 1 << 1,
  /** Deals damage by touching the player. */
  ContactDamage: 1 << 2,
  Pickupable: 1 << 3,
  /** Crosses pits; ignores ground-only blockers. */
  Flying: 1 << 4,
  /** Does not move, so locomotion and separation can skip it. */
  Immobile: 1 << 5,
  /** Immune to knockback impulses. */
  KnockbackImmune: 1 << 6,
  /** Cannot be damaged at all (Depth Wraith, boss parts in phase 1). */
  Invulnerable: 1 << 7,
  /** Counts toward "floor cleared" and toward the live enemy cap. */
  CountsAsThreat: 1 << 8,
  /** Spawned by the trickle system: reduced rewards, no loot roll. */
  Trickle: 1 << 9,
  /** Elite: aura, health bar, guaranteed drop. */
  Elite: 1 << 10,
  /** Boss: health bar, never knocked back, never despawned. */
  Boss: 1 << 11,
} as const;
export type FlagBits = number;

// --------------------------------------------------------------- player state

export const AtkPhase = {
  Idle: 0,
  Windup: 1,
  Active: 2,
  Recovery: 3,
} as const;
export type AtkPhaseId = (typeof AtkPhase)[keyof typeof AtkPhase];

/** Cached aggregate of every relic/perk/level effect. Recomputed on change. */
export interface DerivedStats {
  dmgMul: number;
  atkSpeedMul: number;
  moveMul: number;
  maxHpBonus: number;
  /** Multiplicative max-HP modifier, applied after `maxHpBonus`. Kept separate
   *  so a stacking penalty (Glass Fang) can never reach zero health. */
  maxHpMul: number;
  /** Extra i-frame milliseconds on top of the base. */
  iframeBonus: number;
  pickupRadius: number;
  /** Fraction of damage dealt returned as healing. */
  leech: number;
  /** Burn damage per second applied on hit, 0 = none. */
  burnDps: number;
  /** Chance to apply a slow on hit. */
  chillChance: number;
  /** Every Nth hit chains. 0 = never. */
  chainEvery: number;
  chainTargets: number;
  /** Extra targets each attack bounces to. */
  bounceTargets: number;
  critChance: number;
  critMul: number;
  /** Extra damage multiplier against enemies below 25% hp. */
  execBonus: number;
  xpMul: number;
  soulMul: number;
  coinMul: number;
  lightMul: number;
  /** Chance a kill drops a healing mote. */
  healMoteChance: number;
  /** Chance a kill spawns a decoy. */
  decoyChance: number;
  /** Fatal-hit saves remaining per floor. */
  secondWindMax: number;
  /** Damage taken multiplier. */
  damageTakenMul: number;
  /** Shockwave on taking damage: 0 damage = disabled. */
  vengeanceDmg: number;
  vengeanceRadius: number;
  /** Attacks ignore directional shields and armour plates. */
  pierceShield: boolean;
  /** Player takes no hazard damage, and hazards hurt enemies double. */
  hazardImmune: boolean;
  /** Multiplier on the dodge cooldown. Lower is better. */
  dodgeCdMul: number;
  /** Extra damage multiplier while below 40% health. */
  lowHpDamage: number;
  killRefreshesDodge: boolean;
  /** Swing cone width and reach multipliers. */
  arcMul: number;
  reachMul: number;
}

export function blankStats(): DerivedStats {
  return {
    dmgMul: 1,
    atkSpeedMul: 1,
    moveMul: 1,
    maxHpBonus: 0,
    maxHpMul: 1,
    iframeBonus: 0,
    pickupRadius: 34,
    leech: 0,
    burnDps: 0,
    chillChance: 0,
    chainEvery: 0,
    chainTargets: 0,
    bounceTargets: 0,
    critChance: 0.05,
    critMul: 1.8,
    execBonus: 0,
    xpMul: 1,
    soulMul: 1,
    coinMul: 1,
    lightMul: 1,
    healMoteChance: 0,
    decoyChance: 0,
    secondWindMax: 0,
    damageTakenMul: 1,
    vengeanceDmg: 0,
    vengeanceRadius: 0,
    pierceShield: false,
    hazardImmune: false,
    dodgeCdMul: 1,
    lowHpDamage: 0,
    killRefreshesDodge: false,
    arcMul: 1,
    reachMul: 1,
  };
}

export interface ConsumableSlot {
  id: string | null;
  count: number;
}

export interface PlayerState {
  classId: string;
  weapon: WeaponDef;

  // Attack state machine
  atk: AtkPhaseId;
  atkT: number;
  /** Which sub-hit of a multi-hit weapon we are in. */
  atkSlice: number;
  combo: number;
  /** Facing latched at the Windup->Active boundary. */
  swingX: number;
  swingY: number;

  // Dash
  dashT: number;
  dashCd: number;
  dashDirX: number;
  dashDirY: number;

  aimX: number;
  aimY: number;

  // Progression
  level: number;
  xp: number;
  xpNext: number;
  pendingPerks: number;
  perks: string[];

  /** relic id -> stack count. */
  relics: Record<string, number>;
  slots: [ConsumableSlot, ConsumableSlot];
  slotCount: 1 | 2;

  coins: number;
  soulsBanked: number;
  soulsPending: number;

  /** Gravebound's decaying kill-shield. */
  shieldHp: number;
  shieldDecayT: number;

  stats: DerivedStats;

  /**
   * Run-permanent shrine effects. Kept separate from relics because they are
   * not stacks and cannot be recomputed from an item list.
   */
  shrineDmgBonus: number;
  shrineHpMul: number;
  shrineHpBonus: number;
  shrineMoveMul: number;

  /** Counts hits, not swings — Static Coil depends on the distinction. */
  hitStreak: number;
  secondWindLeft: number;
  /** Adrenal Draught and similar. */
  buffAtkSpeedT: number;
  buffMoveT: number;
  invisT: number;

  /** Run stats for the summary screen. */
  kills: number;
  elitesKilled: number;
  bossesKilled: number;
}

export function blankPlayerState(weapon: WeaponDef): PlayerState {
  return {
    classId: 'wanderer',
    weapon,
    atk: AtkPhase.Idle,
    atkT: 0,
    atkSlice: 0,
    combo: 0,
    swingX: 1,
    swingY: 0,
    dashT: 0,
    dashCd: 0,
    dashDirX: 1,
    dashDirY: 0,
    aimX: 1,
    aimY: 0,
    level: 1,
    xp: 0,
    xpNext: 24,
    pendingPerks: 0,
    perks: [],
    relics: {},
    slots: [
      { id: null, count: 0 },
      { id: null, count: 0 },
    ],
    slotCount: 1,
    coins: 0,
    soulsBanked: 0,
    soulsPending: 0,
    shieldHp: 0,
    shieldDecayT: 0,
    stats: blankStats(),
    shrineDmgBonus: 0,
    shrineHpMul: 1,
    shrineHpBonus: 0,
    shrineMoveMul: 1,
    hitStreak: 0,
    secondWindLeft: 0,
    buffAtkSpeedT: 0,
    buffMoveT: 0,
    invisT: 0,
    kills: 0,
    elitesKilled: 0,
    bossesKilled: 0,
  };
}

// -------------------------------------------------------------------- entity

/**
 * One shape for every entity. All fields always present.
 *
 * Why a fat struct rather than a discriminated union: shared systems
 * (locomotion, tile collision, knockback decay, i-frames, flash timers, shadow
 * rendering, separation) touch the same ~15 fields on nearly every kind. A
 * union forces constant narrowing or a base interface that reintroduces the fat
 * struct anyway. Why not an ECS: at 80 entities the archetype-iteration win is
 * zero and you pay for it in indirection every time you debug.
 *
 * Bonus: one uniform shape means one pool serves every kind and V8 keeps a
 * single hidden class for the whole array.
 */
export interface Entity {
  // Identity
  id: number;
  /** Bumped on every reuse. `{id, gen}` handles detect a stale reference. */
  gen: number;
  alive: boolean;
  kind: EKindId;
  team: Team;
  flags: FlagBits;

  /** For enemies: the content definition driving behaviour and art. */
  def: EnemyDef | null;

  // Transform. px/py are last tick's position, for render interpolation only —
  // nothing gameplay-relevant may read them.
  x: number;
  y: number;
  px: number;
  py: number;
  /** Locomotion velocity, px/s. Recomputed from intent every tick. */
  vx: number;
  vy: number;
  /** Knockback velocity, px/s. Persists and decays. */
  kx: number;
  ky: number;
  r: number;
  faceX: number;
  faceY: number;

  // Stats
  hp: number;
  hpMax: number;
  dmg: number;
  speed: number;
  mass: number;
  /** Fraction of knockback ignored, 0..1. */
  knockbackResist: number;
  /** Rime-Golem style ablative plate; absorbs all damage until broken. */
  shell: number;
  shellMax: number;

  // Timers, milliseconds, all counting down toward zero
  iframes: number;
  stun: number;
  flash: number;
  /** Lifetime for transient entities; <=0 with `hasLife` set means despawn. */
  life: number;
  hasLife: boolean;
  cd0: number;
  cd1: number;
  cd2: number;

  // Status effects
  burnDps: number;
  burnT: number;
  /** Countdown to the next burn tick. Dedicated field: sharing a scratch timer
   *  here caused burn to fight with projectile pool state. */
  burnTick: number;
  slowMul: number;
  slowT: number;

  // Behaviour scratch. Meaning is per-EnemyDef.
  state: number;
  stateT: number;
  aiT: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;

  // Per-kind extras
  player: PlayerState | null;
  /** Cleared at the start of each damage window; stops multi-tick multi-hits. */
  hitSet: Set<number>;
  /** Pickup value, projectile damage, hazard subtype — kind-dependent. */
  payload: number;
  /** Item/interactable/affix identifier, kind-dependent. */
  tag: string;
  /** Light radius in world px. 0 = emits none. */
  light: number;
  lightTint: number;
  /** Stable per-instance value for deterministic procedural art variation. */
  seed: number;
  /** Which room this entity was spawned in; -1 if unknown. */
  roomId: number;
  /** Elite/enemy affix id, '' if none. */
  affix: string;
  /** Warded affix: hits landed inside the current window. */
  wardHits: number;
  /** Render scale multiplier (elites are bigger). */
  scale: number;
}

let nextBlankId = 1;

export function blankEntity(): Entity {
  return {
    id: nextBlankId++,
    gen: 0,
    alive: false,
    kind: EKind.Enemy,
    team: TEAM_HOSTILE,
    flags: Flags.None,
    def: null,
    x: 0,
    y: 0,
    px: 0,
    py: 0,
    vx: 0,
    vy: 0,
    kx: 0,
    ky: 0,
    r: 8,
    faceX: 1,
    faceY: 0,
    hp: 1,
    hpMax: 1,
    dmg: 0,
    speed: 0,
    mass: 1,
    knockbackResist: 0,
    shell: 0,
    shellMax: 0,
    iframes: 0,
    stun: 0,
    flash: 0,
    life: 0,
    hasLife: false,
    cd0: 0,
    cd1: 0,
    cd2: 0,
    burnDps: 0,
    burnT: 0,
    burnTick: 0,
    slowMul: 1,
    slowT: 0,
    state: 0,
    stateT: 0,
    aiT: 0,
    ax: 0,
    ay: 0,
    bx: 0,
    by: 0,
    player: null,
    hitSet: new Set<number>(),
    payload: 0,
    tag: '',
    light: 0,
    lightTint: 0,
    seed: 0,
    roomId: -1,
    affix: '',
    wardHits: 0,
    scale: 1,
  };
}

/**
 * Wipe every field back to a known state. Must touch ALL of them — a stale
 * value carried over from a previous occupant of this slot is exactly the kind
 * of bug that takes a day to find.
 */
export function resetEntity(e: Entity): void {
  e.alive = false;
  e.kind = EKind.Enemy;
  e.team = TEAM_HOSTILE;
  e.flags = Flags.None;
  e.def = null;
  e.x = 0;
  e.y = 0;
  e.px = 0;
  e.py = 0;
  e.vx = 0;
  e.vy = 0;
  e.kx = 0;
  e.ky = 0;
  e.r = 8;
  e.faceX = 1;
  e.faceY = 0;
  e.hp = 1;
  e.hpMax = 1;
  e.dmg = 0;
  e.speed = 0;
  e.mass = 1;
  e.knockbackResist = 0;
  e.shell = 0;
  e.shellMax = 0;
  e.iframes = 0;
  e.stun = 0;
  e.flash = 0;
  e.life = 0;
  e.hasLife = false;
  e.cd0 = 0;
  e.cd1 = 0;
  e.cd2 = 0;
  e.burnDps = 0;
  e.burnT = 0;
  e.burnTick = 0;
  e.slowMul = 1;
  e.slowT = 0;
  e.state = 0;
  e.stateT = 0;
  e.aiT = 0;
  e.ax = 0;
  e.ay = 0;
  e.bx = 0;
  e.by = 0;
  e.player = null;
  e.hitSet.clear();
  e.payload = 0;
  e.tag = '';
  e.light = 0;
  e.lightTint = 0;
  e.seed = 0;
  e.roomId = -1;
  e.affix = '';
  e.wardHits = 0;
  e.scale = 1;
}

// ------------------------------------------------------------------ helpers

export function hasFlag(e: Entity, f: number): boolean {
  return (e.flags & f) !== 0;
}

export function isHostile(e: Entity): boolean {
  return e.team === TEAM_HOSTILE;
}

/** A live, damageable hostile — the set melee and projectiles care about. */
export function isTargetable(e: Entity): boolean {
  return (
    e.alive &&
    e.kind === EKind.Enemy &&
    e.team === TEAM_HOSTILE &&
    (e.flags & Flags.Damageable) !== 0 &&
    (e.flags & Flags.Invulnerable) === 0
  );
}

/** Configure a fresh entity as the player. */
export function makePlayer(e: Entity, weapon: WeaponDef, x: number, y: number): void {
  e.kind = EKind.Player;
  e.team = TEAM_PLAYER;
  e.flags = Flags.Damageable | Flags.Pushable;
  e.r = PLAYER_RADIUS;
  e.hp = PLAYER_BASE_HP;
  e.hpMax = PLAYER_BASE_HP;
  e.speed = PLAYER_BASE_SPEED;
  e.mass = 1.6;
  e.x = e.px = x;
  e.y = e.py = y;
  e.player = blankPlayerState(weapon);
  e.alive = true;
}
