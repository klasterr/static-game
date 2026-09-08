import { TILE } from '../core/constants';
import type { EnemyDef } from '../content/types/enemy';
import {
  EKind,
  Flags,
  TEAM_HOSTILE,
  TEAM_PLAYER,
  blankEntity,
  resetEntity,
  type EKindId,
  type Entity,
  type Team,
} from './entities';
import type { Tilemap } from './tiles';

/**
 * Entity lifecycle protocol. Every system in the game depends on these three
 * rules, so read this before touching `ents`:
 *
 *  1. `spawn()` appends to `pending`, NOT to `ents`. `ents.length` is therefore
 *     invariant for the whole tick.
 *  2. `kill()` only flips `alive`. It never splices.
 *  3. `flush()` runs exactly once, at the end of the tick, and does the
 *     appends plus a backward swap-remove of the dead into the pool.
 *
 * Consequence: every system iterates `for (let i = 0; i < w.ents.length; i++)`
 * and skips `!e.alive`. No skipped entities, no double-processed entities, no
 * index shuffling mid-loop.
 *
 * The trap: after `flush()`, a dead entity's object is back in the pool and
 * will be reused with different data. Never hold an `Entity` reference that
 * outlives the tick — except `w.player`. Use `{id, gen}` handles via `ref()`
 * and `resolve()` instead.
 */

export interface EntityRef {
  id: number;
  gen: number;
}

export interface EnemySpawnOpts {
  hpMult?: number;
  dmgMult?: number;
  speedMult?: number;
  elite?: boolean;
  affix?: string;
  trickle?: boolean;
  roomId?: number;
  /** Boss health bar, no knockback, never despawned. */
  boss?: boolean;
}

const POOL_CAP = 320;

export class World {
  /** The live entity array. Nothing outside this file may push or splice it. */
  readonly ents: Entity[] = [];
  private readonly pending: Entity[] = [];
  private readonly pool: Entity[] = [];

  nextId = 1;
  map!: Tilemap;
  /** The only long-lived entity reference anyone may hold. */
  player!: Entity;

  /** Sim clock in ms, advanced one STEP per tick. Drives all art animation. */
  timeMs = 0;

  /** Threat bookkeeping for floor-clear percentage and the trickle spawner. */
  threatsInitial = 0;
  threatsAlive = 0;
  threatsKilled = 0;

  /** Set while a scene is rendering; guards against determinism leaks. */
  inRender = false;

  reset(map: Tilemap): void {
    for (let i = 0; i < this.ents.length; i++) {
      const e = this.ents[i];
      e.alive = false;
      if (this.pool.length < POOL_CAP) this.pool.push(e);
    }
    this.ents.length = 0;
    this.pending.length = 0;
    this.map = map;
    this.timeMs = 0;
    this.threatsInitial = 0;
    this.threatsAlive = 0;
    this.threatsKilled = 0;
  }

  /** A blank live entity, queued for insertion at the end of the tick. */
  spawn(kind: EKindId, x: number, y: number, team: Team = TEAM_HOSTILE): Entity {
    const e = this.pool.pop() ?? blankEntity();
    resetEntity(e);
    e.gen++;
    e.id = this.nextId++;
    e.kind = kind;
    e.team = team;
    e.x = e.px = x;
    e.y = e.py = y;
    e.seed = (Math.imul(e.id, 0x9e3779b1) >>> 0) & 0xffff;
    e.alive = true;
    this.pending.push(e);
    return e;
  }

  /** Build an enemy from its content definition, with depth scaling applied. */
  spawnEnemy(def: EnemyDef, x: number, y: number, opts: EnemySpawnOpts = {}): Entity {
    const e = this.spawn(EKind.Enemy, x, y, TEAM_HOSTILE);
    const s = def.stats;
    const hpMult = opts.hpMult ?? 1;
    const dmgMult = opts.dmgMult ?? 1;
    const speedMult = opts.speedMult ?? 1;

    e.def = def;
    e.hpMax = Math.max(1, Math.round(s.hp * hpMult));
    e.hp = e.hpMax;
    e.dmg = s.damage * dmgMult;
    e.speed = s.speed * speedMult;
    e.r = s.radius;
    e.mass = s.mass;
    e.knockbackResist = s.knockbackResist;
    e.light = s.light ?? 0;
    e.shellMax = (s.shell ?? 0) * hpMult;
    e.shell = e.shellMax;
    e.roomId = opts.roomId ?? -1;

    let flags = Flags.Damageable | Flags.CountsAsThreat;
    if (s.contactDamage) flags |= Flags.ContactDamage;
    if (def.tags.includes('flying')) flags |= Flags.Flying;
    if (def.tags.includes('immobile')) flags |= Flags.Immobile;
    else flags |= Flags.Pushable;

    if (opts.elite) {
      flags |= Flags.Elite;
      e.hpMax = Math.round(e.hpMax * 2.6);
      e.hp = e.hpMax;
      e.dmg *= 1.3;
      e.scale = 1.15;
      e.r *= 1.15;
      e.mass *= 1.4;
      e.affix = opts.affix ?? '';
    }
    if (opts.boss) {
      flags |= Flags.Boss | Flags.KnockbackImmune;
      e.scale = 1;
    }
    if (opts.trickle) flags |= Flags.Trickle;

    e.flags = flags;
    e.faceX = 0;
    e.faceY = 1;

    this.threatsAlive++;
    return e;
  }

  /** Mark dead. The object is not recycled until `flush()`. */
  kill(e: Entity): void {
    if (!e.alive) return;
    e.alive = false;
    if ((e.flags & Flags.CountsAsThreat) !== 0) {
      this.threatsAlive = Math.max(0, this.threatsAlive - 1);
      this.threatsKilled++;
    }
  }

  /** Insert pending, recycle dead. Exactly once per tick, after all systems. */
  flush(): void {
    for (let i = 0; i < this.pending.length; i++) this.ents.push(this.pending[i]);
    this.pending.length = 0;

    for (let i = this.ents.length - 1; i >= 0; i--) {
      const e = this.ents[i];
      if (e.alive) continue;
      const last = this.ents.length - 1;
      this.ents[i] = this.ents[last];
      this.ents.pop();
      if (this.pool.length < POOL_CAP) this.pool.push(e);
    }
  }

  ref(e: Entity): EntityRef {
    return { id: e.id, gen: e.gen };
  }

  /** Resolve a handle, or null if that entity died and its slot was reused. */
  resolve(r: EntityRef | null): Entity | null {
    if (!r) return null;
    for (let i = 0; i < this.ents.length; i++) {
      const e = this.ents[i];
      if (e.id === r.id && e.gen === r.gen && e.alive) return e;
    }
    return null;
  }

  // ------------------------------------------------------------- queries

  /** Closest live hostile within `maxDist`, or null. Brute force is fine here. */
  nearestHostile(x: number, y: number, maxDist: number, exclude?: Entity): Entity | null {
    let best: Entity | null = null;
    let bestD2 = maxDist * maxDist;
    for (let i = 0; i < this.ents.length; i++) {
      const e = this.ents[i];
      if (!e.alive || e.kind !== EKind.Enemy || e.team !== TEAM_HOSTILE) continue;
      if ((e.flags & Flags.Damageable) === 0) continue;
      if ((e.flags & Flags.Invulnerable) !== 0) continue;
      if (e === exclude) continue;
      const dx = e.x - x;
      const dy = e.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = e;
      }
    }
    return best;
  }

  /** Whatever the player-team AI should chase: the decoy if any, else the player. */
  aggroTarget(): Entity {
    for (let i = 0; i < this.ents.length; i++) {
      const e = this.ents[i];
      if (e.alive && e.kind === EKind.Decoy) return e;
    }
    return this.player;
  }

  countAlive(kind: EKindId): number {
    let n = 0;
    for (let i = 0; i < this.ents.length; i++) {
      const e = this.ents[i];
      if (e.alive && e.kind === kind) n++;
    }
    return n;
  }

  /** Threats that count against the live cap. Trickle spawns are included. */
  liveThreats(): number {
    let n = 0;
    for (let i = 0; i < this.ents.length; i++) {
      const e = this.ents[i];
      if (e.alive && (e.flags & Flags.CountsAsThreat) !== 0) n++;
    }
    return n;
  }

  /** 0..1. Trickle spawns deliberately do not raise the denominator. */
  clearFraction(): number {
    if (this.threatsInitial === 0) return 1;
    return Math.min(1, this.threatsKilled / this.threatsInitial);
  }

  bossAlive(): Entity | null {
    for (let i = 0; i < this.ents.length; i++) {
      const e = this.ents[i];
      if (e.alive && (e.flags & Flags.Boss) !== 0) return e;
    }
    return null;
  }

  /** Any live elite, for the HUD health bar. */
  nearestElite(x: number, y: number, maxDist: number): Entity | null {
    let best: Entity | null = null;
    let bestD2 = maxDist * maxDist;
    for (let i = 0; i < this.ents.length; i++) {
      const e = this.ents[i];
      if (!e.alive || (e.flags & Flags.Elite) === 0) continue;
      const dx = e.x - x;
      const dy = e.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = e;
      }
    }
    return best;
  }

  tileAt(e: Entity): number {
    return this.map.at(Math.floor(e.x / TILE), Math.floor(e.y / TILE));
  }

  /** Snapshot the initial threat count once population is done. */
  lockThreatBaseline(): void {
    this.flush();
    this.threatsInitial = this.liveThreats();
    this.threatsAlive = this.threatsInitial;
    this.threatsKilled = 0;
  }
}

/** Player-team entities that hostiles are allowed to hurt. */
export function isPlayerTeam(e: Entity): boolean {
  return e.team === TEAM_PLAYER;
}
