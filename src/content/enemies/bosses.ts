import { TAU, clamp01 } from '../../core/math';
import { PKind } from '../../render/fx';
import { circle, roundRect } from '../../render/glyphs';
import { Tint } from '../../render/lighting';
import type { GameCtx } from '../../world/ctx';
import { Flags, type Entity } from '../../world/entities';
import { spawnEnemyIn } from '../../world/enemies';
import { spawnProjectile } from '../../world/projectiles';
import { distToTarget, faceTarget, shootAt } from '../behaviors/primitives';
import type { EnemyDef } from '../types/enemy';
import { BONE_RAT } from './catacombs';

/**
 * The Ossuary Choir — floor 5, and every fifth floor after with scaling.
 *
 * One boss with three genuinely different phases beats four half-finished ones.
 * Bosses are the most expensive content per minute of play in the whole design,
 * so this is where that budget went.
 *
 * What it teaches: target priority (phase 2) and ring-gap dodging (phase 3).
 * Both are skills the ordinary roster never forces you to practise.
 */

export const ORB_COUNT = 3;
export const ORB_ID = 'ossuary_orb';

const BossPhase = {
  Choir: 1,
  Exposed: 2,
  Fury: 3,
} as const;

function orbsAlive(ctx: GameCtx): number {
  let n = 0;
  const ents = ctx.world.ents;
  for (let i = 0; i < ents.length; i++) {
    if (ents[i].alive && ents[i].def?.id === ORB_ID) n++;
  }
  return n;
}

// ------------------------------------------------------------------- the orb

export const OSSUARY_ORB: EnemyDef = {
  id: ORB_ID,
  name: 'Choir Skull',
  stats: {
    hp: 110,
    damage: 8,
    speed: 0,
    radius: 13,
    knockbackResist: 1,
    mass: 4,
    contactDamage: false,
    xp: 8,
    coins: [1, 4],
    souls: 4,
    light: 60,
  },
  visual: {
    family: 'circle',
    body: '#e6ddc4',
    accent: '#6b5f76',
    glow: '#ffe6a8',
    outlineWidth: 2,
    draw(c, e, t) {
      const r = e.r;
      const invuln = (e.flags & Flags.Invulnerable) !== 0;

      if (invuln) {
        // A visible ward, so "you cannot hurt this yet" is never a mystery.
        c.strokeStyle = `rgba(180,200,255,${0.35 + Math.sin(t * 0.006) * 0.12})`;
        c.lineWidth = 2;
        c.beginPath();
        c.arc(0, 0, r * 1.45, 0, TAU);
        c.stroke();
      }

      c.fillStyle = '#e6ddc4';
      circle(c, 0, -r * 0.15, r * 0.85);
      c.fillStyle = '#d8cfae';
      roundRect(c, -r * 0.45, r * 0.35, r * 0.9, r * 0.5, 2);
      c.fill();
      c.strokeStyle = '#6b5f76';
      c.lineWidth = 2;
      c.beginPath();
      c.arc(0, -r * 0.15, r * 0.85, 0, TAU);
      c.stroke();

      // Eye sockets glow while charging a bolt.
      const charge = e.state === 1 ? 1 - clamp01(e.stateT / 620) : 0;
      c.fillStyle = charge > 0 ? `rgba(255,180,90,${0.5 + charge * 0.5})` : '#2a2330';
      circle(c, -r * 0.33, -r * 0.25, r * 0.2);
      circle(c, r * 0.33, -r * 0.25, r * 0.2);
    },
  },
  tags: ['undead', 'boss', 'ranged'],
  neverElite: true,
  init(e) {
    e.flags |= Flags.KnockbackImmune;
    // Phase 1 orbs are untouchable; the boss lifts this in phase 2.
    e.flags |= Flags.Invulnerable;
  },
  ai(e, ctx, dt) {
    const boss = ctx.world.bossAlive();
    if (!boss) {
      // Orphaned orb (boss already dead): fade out rather than hang around.
      ctx.world.kill(e);
      return;
    }

    // Orbit faster as siblings die, so killing one raises the pressure.
    const alive = Math.max(1, orbsAlive(ctx));
    const revPerSec = 0.4 + (ORB_COUNT - alive) * 0.22;
    const index = e.payload;
    const angle = (ctx.timeMs * 0.001 * revPerSec * TAU) + (index / ORB_COUNT) * TAU;
    const radius = 120;

    e.x = boss.x + Math.cos(angle) * radius;
    e.y = boss.y + Math.sin(angle) * radius * 0.72;
    e.vx = 0;
    e.vy = 0;
    faceTarget(e, ctx);

    // Staggered bolts: the offset per orb keeps the volley legible.
    if (e.aiT <= 0 && e.state === 0) e.aiT = 900 + index * 420;
    shootAt(e, ctx, dt, {
      cooldown: 2100,
      windup: 620,
      spec: {
        speed: 210,
        radius: 5,
        damage: e.dmg,
        life: 3200,
        color: '#ffb45c',
        light: 40,
        tint: Tint.Warm,
        knockback: 110,
      },
    });
  },
  onDeath(e, ctx) {
    ctx.fx.burst(e.x, e.y, {
      color: '#ffe6a8',
      count: 26,
      speed: [90, 300],
      size: [2, 4.6],
      life: [300, 620],
      additive: true,
    });
    ctx.fx.transientLight(e.x, e.y, 220, 420, Tint.Warm);
  },
};

// ------------------------------------------------------------------ the boss

export const OSSUARY_CHOIR: EnemyDef = {
  id: 'ossuary_choir',
  name: 'The Ossuary Choir',
  stats: {
    hp: 620,
    damage: 14,
    speed: 0,
    radius: 26,
    knockbackResist: 1,
    mass: 20,
    contactDamage: false,
    xp: 120,
    coins: [40, 70],
    souls: 40,
    light: 150,
  },
  visual: {
    family: 'spine',
    body: '#d8cfae',
    accent: '#6b5f76',
    glow: '#ffb45c',
    outlineWidth: 3,
    draw(c, e, t) {
      const r = e.r;
      const height = r * 2.7;
      const phase = e.state;

      // Vertebral column: nine segments, breathing on a slow sine.
      const breath = Math.sin(t * 0.0016) * 0.05;
      c.save();
      c.scale(1 + breath, 1 - breath);

      for (let i = 0; i < 9; i++) {
        const ty = height * 0.5 - (i / 8) * height * 1.4;
        const seg = r * (0.5 - i * 0.026);
        const sway = Math.sin(t * 0.002 + i * 0.5) * (i / 8) * 4;
        c.fillStyle = i % 2 === 0 ? '#d8cfae' : '#c6bc9c';
        roundRect(c, -seg + sway, ty, seg * 2, height * 0.16, 3);
        c.fill();
        c.strokeStyle = '#6b5f76';
        c.lineWidth = 1.6;
        c.stroke();
      }

      // Crown skull.
      c.fillStyle = '#efe7cf';
      circle(c, 0, -height * 0.78, r * 0.62);
      c.strokeStyle = '#6b5f76';
      c.lineWidth = 2.4;
      c.beginPath();
      c.arc(0, -height * 0.78, r * 0.62, 0, TAU);
      c.stroke();

      const eye = phase >= BossPhase.Fury ? '#ff6b3a' : '#ffb45c';
      c.fillStyle = eye;
      circle(c, -r * 0.24, -height * 0.8, r * 0.15);
      circle(c, r * 0.24, -height * 0.8, r * 0.15);
      c.restore();

      // Phase 3 ring wind-up: an expanding outline so the gap can be found.
      if (phase >= BossPhase.Fury && e.aiT < 700 && e.aiT > 0) {
        const wind = 1 - e.aiT / 700;
        c.strokeStyle = `rgba(255,107,58,${0.2 + wind * 0.5})`;
        c.lineWidth = 3;
        c.beginPath();
        c.arc(0, 0, 40 + wind * 90, 0, TAU);
        c.stroke();
      }
    },
  },
  tags: ['boss', 'undead', 'immobile'],
  neverElite: true,
  init(e, ctx) {
    e.state = BossPhase.Choir;
    e.flags |= Flags.KnockbackImmune | Flags.Boss;
    e.aiT = 2500;
    e.cd1 = 6000;

    // Spawn the choir.
    for (let i = 0; i < ORB_COUNT; i++) {
      const orb = spawnEnemyIn(ctx, OSSUARY_ORB, e.x, e.y, {
        speedMult: 1,
        roomId: e.roomId,
      });
      orb.payload = i;
    }
    e.by = ORB_COUNT;
  },
  ai(e, ctx, dt) {
    e.vx = 0;
    e.vy = 0;
    const frac = e.hp / e.hpMax;
    const alive = orbsAlive(ctx);
    // Cached for `modifyIncoming`, which cannot see the world.
    e.by = alive;

    // Phase transitions.
    if (e.state === BossPhase.Choir && frac <= 0.66) {
      e.state = BossPhase.Exposed;
      // Orbs become killable. This is the moment the fight becomes about
      // target priority instead of chipping an armoured pillar.
      for (const o of ctx.world.ents) {
        if (o.alive && o.def?.id === ORB_ID) o.flags &= ~Flags.Invulnerable;
      }
      announce(ctx, e, '#ffd24a');
    } else if (e.state === BossPhase.Exposed && frac <= 0.33) {
      e.state = BossPhase.Fury;
      e.aiT = 1200;
      announce(ctx, e, '#ff6b3a');
    }

    if (e.state === BossPhase.Fury) {
      // 12-projectile ring with exactly one gap. Finding and stepping through
      // the gap is the skill; panic-dodging sideways is not enough.
      e.aiT -= dt * 1000;
      if (e.aiT <= 0) {
        e.aiT = 2500;
        fireRing(ctx, e);
      }

      // Reinforcement packs, so the arena is never static.
      e.cd1 -= dt * 1000;
      if (e.cd1 <= 0) {
        e.cd1 = 7000;
        summonRats(ctx, e);
      }
    } else if (alive === 0) {
      // All orbs down before phase 3: the spine picks up their attack pattern
      // rather than standing there defenceless.
      e.aiT -= dt * 1000;
      if (e.aiT <= 0) {
        e.aiT = 1800;
        fireAimed(ctx, e);
      }
    }

    // A slow contact aura keeps melee honest without being a damage race.
    if (distToTarget(e, ctx) < e.r + ctx.target.r + 6 && e.cd2 <= 0) {
      e.cd2 = 900;
    }
    e.cd2 -= dt * 1000;
  },
  modifyIncoming(e, dmg) {
    if (e.state >= BossPhase.Fury) return dmg.amount;
    // Phase 1: 30% damage taken. Phase 2: each dead orb strips a third of the
    // remaining reduction, so killing orbs is visibly the fast route.
    //
    // `by` is the orb count cached by the AI tick — `modifyIncoming` has no
    // world handle, and caching a NUMBER avoids holding entity references
    // across ticks, which pooling would invalidate.
    const dead = Math.max(0, ORB_COUNT - e.by);
    const mult = 0.3 + dead * (0.7 / ORB_COUNT);
    return dmg.amount * Math.min(1, mult);
  },
  onDeath(e, ctx) {
    // Take the choir with it.
    for (const o of ctx.world.ents) {
      if (o.alive && o.def?.id === ORB_ID) ctx.world.kill(o);
    }
    ctx.fx.flash('#ffe6a8', 0.5, 3);
    for (let i = 0; i < 5; i++) {
      ctx.fx.transientLight(
        e.x + (Math.random() - 0.5) * 90,
        e.y + (Math.random() - 0.5) * 90,
        260,
        700 + i * 120,
        Tint.Warm,
      );
    }
    ctx.fx.burst(e.x, e.y, {
      color: '#efe7cf',
      count: 60,
      speed: [60, 420],
      size: [2, 6],
      life: [500, 1200],
      kind: PKind.Chunk,
      gravity: 240,
    });
  },
};

function announce(ctx: GameCtx, e: Entity, color: string): void {
  ctx.fx.flash(color, 0.28, 5);
  ctx.fx.transientLight(e.x, e.y, 340, 520, Tint.Warm);
  ctx.fx.burst(e.x, e.y, {
    color,
    count: 40,
    speed: [140, 420],
    size: [2, 5],
    life: [320, 700],
    kind: PKind.Streak,
    additive: true,
  });
}

function fireRing(ctx: GameCtx, e: Entity): void {
  const count = 12;
  const gap = Math.floor(Math.random() * count);
  const offset = Math.random() * TAU;
  for (let i = 0; i < count; i++) {
    if (i === gap) continue;
    const a = offset + (i / count) * TAU;
    spawnProjectile(ctx, e.x + Math.cos(a) * 30, e.y + Math.sin(a) * 30, Math.cos(a), Math.sin(a), {
      speed: 175,
      radius: 6,
      damage: e.dmg,
      life: 4200,
      color: '#ff9a3a',
      light: 34,
      tint: Tint.Warm,
      knockback: 130,
    }, false);
  }
  ctx.fx.transientLight(e.x, e.y, 200, 260, Tint.Warm);
}

function fireAimed(ctx: GameCtx, e: Entity): void {
  const dx = ctx.target.x - e.x;
  const dy = ctx.target.y - e.y;
  const l = Math.sqrt(dx * dx + dy * dy) || 1;
  for (let i = -1; i <= 1; i++) {
    const a = Math.atan2(dy / l, dx / l) + i * 0.22;
    spawnProjectile(ctx, e.x, e.y, Math.cos(a), Math.sin(a), {
      speed: 220,
      radius: 5,
      damage: e.dmg * 0.8,
      life: 3000,
      color: '#ffb45c',
      light: 30,
      tint: Tint.Warm,
    }, false);
  }
}

function summonRats(ctx: GameCtx, e: Entity): void {
  const count = 4;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * TAU + Math.random();
    // Marked as trickle so reinforcements never turn the boss into a loot farm.
    spawnEnemyIn(ctx, BONE_RAT, e.x + Math.cos(a) * 130, e.y + Math.sin(a) * 130, {
      roomId: e.roomId,
      trickle: true,
    });
  }
  ctx.fx.flash('#d8cfae', 0.12, 6);
}

// ------------------------------------------------------------- Depth Wraith

/**
 * Not a fight — a clock.
 *
 * Spawns after six minutes on a floor. Invulnerable, slow, and relentless. It
 * exists so that a big floor cannot be farmed indefinitely, and so a long floor
 * acquires a rising-tension third act instead of trailing off.
 */
export const DEPTH_WRAITH: EnemyDef = {
  id: 'depth_wraith',
  name: 'Depth Wraith',
  stats: {
    hp: 1,
    damage: 40,
    speed: 70,
    radius: 15,
    knockbackResist: 1,
    mass: 10,
    contactDamage: true,
    xp: 0,
    coins: [0, 0],
    souls: 0,
    light: 90,
  },
  visual: {
    family: 'blob',
    body: '#2a1c38',
    accent: '#b46cf0',
    glow: '#d0a4ff',
    outlineWidth: 2,
    draw(c, e, t) {
      const r = e.r;
      // Tattered, semi-transparent, always the same silhouette so it is
      // instantly recognisable as "the thing you cannot kill".
      for (let layer = 2; layer >= 0; layer--) {
        const rr = r * (1 + layer * 0.22);
        c.globalAlpha = 0.2 + layer * 0.14;
        c.fillStyle = layer === 0 ? '#3b2750' : '#2a1c38';
        c.beginPath();
        for (let i = 0; i <= 22; i++) {
          const a = (i / 22) * TAU;
          const wob = 1 + Math.sin(a * 3 + t * 0.004 + layer) * 0.18 +
            Math.sin(a * 7 - t * 0.003) * 0.08;
          const px = Math.cos(a) * rr * wob;
          const py = Math.sin(a) * rr * wob * 1.25;
          if (i === 0) c.moveTo(px, py);
          else c.lineTo(px, py);
        }
        c.closePath();
        c.fill();
      }
      c.globalAlpha = 1;

      c.fillStyle = '#d0a4ff';
      circle(c, -r * 0.28, -r * 0.2, r * 0.16);
      circle(c, r * 0.28, -r * 0.2, r * 0.16);
    },
  },
  tags: ['flying', 'undead'],
  neverElite: true,
  init(e) {
    e.flags |= Flags.Invulnerable | Flags.KnockbackImmune | Flags.Flying;
    // Not a threat for clear-percentage purposes: it can never be killed, so
    // counting it would make the floor impossible to "finish".
    e.flags &= ~Flags.CountsAsThreat;
  },
  ai(e, ctx, dt) {
    // Tracks globally, ignores geometry. There is no hiding, only leaving.
    const dx = ctx.target.x - e.x;
    const dy = ctx.target.y - e.y;
    const l = Math.sqrt(dx * dx + dy * dy) || 1;
    e.vx += ((dx / l) * e.speed - e.vx) * Math.min(1, dt / 0.5);
    e.vy += ((dy / l) * e.speed - e.vy) * Math.min(1, dt / 0.5);
    e.faceX = dx / l;
    e.faceY = dy / l;

    if (Math.random() < 0.4) {
      ctx.fx.particle(
        e.x + (Math.random() - 0.5) * e.r * 2,
        e.y + (Math.random() - 0.5) * e.r * 2,
        0,
        -20,
        '#b46cf0',
        2,
        700,
        PKind.Dot,
        true,
        0.4,
      );
    }
  },
};

export const BOSS_ENEMIES: EnemyDef[] = [OSSUARY_CHOIR, OSSUARY_ORB, DEPTH_WRAITH];
