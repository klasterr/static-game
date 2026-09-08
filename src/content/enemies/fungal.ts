import { TAU, clamp01 } from '../../core/math';
import { blob, circle, trapezoid } from '../../render/glyphs';
import { Tint } from '../../render/lighting';
import { explode, spawnPool } from '../../world/combat';
import type { GameCtx } from '../../world/ctx';
import { Flags, type Entity } from '../../world/entities';
import { spawnEnemyIn } from '../../world/enemies';
import { isLob, lobHeight } from '../../world/projectiles';
import {
  Phase,
  chase,
  distToTarget,
  faceTarget,
  lobAtTarget,
  meleeSwing,
} from '../behaviors/primitives';
import type { EnemyDef } from '../types/enemy';

/**
 * Fungal Caves roster.
 *
 * These are the enemies that make POSITION matter: an exploder you should not
 * kill up close, a splitter you should not kill in a doorway, and a lobber that
 * progressively takes the floor away from you.
 */

// -------------------------------------------------------------- Spore Puff

/** Response demanded: kill it at range, or bait it into a crowd. */
export const SPORE_PUFF: EnemyDef = {
  id: 'spore_puff',
  name: 'Spore Puff',
  stats: {
    hp: 12,
    damage: 0,
    speed: 100,
    radius: 11,
    knockbackResist: 0,
    mass: 0.9,
    contactDamage: false,
    xp: 2,
    coins: [0, 2],
    souls: 1,
    light: 34,
  },
  visual: {
    family: 'blob',
    body: '#a8f06e',
    accent: '#2f5a3f',
    glow: '#ceff9a',
    outlineWidth: 1.5,
    draw(c, e, t) {
      const r = e.r;
      // The pulse rate DOUBLES in the last 0.6s before detonation. That change
      // in rhythm is the whole tell, and it is readable in peripheral vision.
      const arming = e.state === 1;
      const rate = arming ? 0.024 : 0.012;
      const pulse = 1 + Math.sin((t + e.seed * 11) * rate) * (arming ? 0.24 : 0.14);

      c.strokeStyle = '#2f5a3f';
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(0, r * 0.6);
      c.lineTo(0, r * 1.5);
      c.stroke();

      c.fillStyle = arming ? '#d9ff8a' : '#a8f06e';
      blob(c, 0, 0, r * pulse, (t + e.seed * 31) * 0.002, 5, 0.1);
      c.fill();
      c.strokeStyle = '#2f5a3f';
      c.lineWidth = 1.5;
      c.stroke();

      c.fillStyle = 'rgba(255,255,255,0.28)';
      circle(c, -r * 0.3, -r * 0.34, r * 0.24);
    },
  },
  tags: ['exploder', 'fungal'],
  neverElite: true,
  ai(e, ctx, dt) {
    chase(e, ctx, dt, e.speed, 0.2);
    e.stateT -= dt * 1000;

    if (e.state === 0) {
      // Arm on proximity, then detonate on a fuse so a dodge still works.
      if (distToTarget(e, ctx) < e.r + ctx.target.r + 16) {
        e.state = 1;
        e.stateT = 600;
      }
      return;
    }

    if (e.stateT <= 0) detonate(e, ctx);
  },
  onDeath(e, ctx) {
    // Dying also detonates. This is what makes killing one at melee range a
    // genuinely bad idea, and what makes baiting one into a pack rewarding.
    if (e.state !== 2) detonate(e, ctx, true);
  },
};

function detonate(e: Entity, ctx: GameCtx, fromDeath = false): void {
  if (e.state === 2) return;
  e.state = 2;
  ctx.fx.transientLight(e.x, e.y, 180, 300, Tint.Green);
  // The cloud damages ENEMIES too, which is the point.
  spawnPool(ctx, e.x, e.y, 90, 5, 4000, '#a8f06e', true);
  explode(ctx, e.x, e.y, 60, 6 * ctx.dmgMult, {
    color: '#d9ff8a',
    hurtPlayer: true,
    tint: Tint.Green,
    knockback: 180,
  });
  if (!fromDeath) ctx.world.kill(e);
}

// --------------------------------------------------------- Myconid Splitter

/** Response demanded: make space before you kill it. */
export const SPORELING: EnemyDef = {
  id: 'sporeling',
  name: 'Sporeling',
  stats: {
    hp: 16,
    damage: 6,
    speed: 120,
    radius: 9,
    knockbackResist: 0,
    mass: 0.8,
    contactDamage: true,
    xp: 1,
    coins: [0, 1],
    souls: 1,
  },
  visual: {
    family: 'blob',
    body: '#4a7d55',
    accent: '#b46cf0',
    outlineWidth: 1.4,
    draw(c, e, t) {
      const r = e.r;
      c.fillStyle = '#4a7d55';
      blob(c, 0, 0, r, (t + e.seed * 7) * 0.006, 4, 0.14);
      c.fill();
      c.strokeStyle = '#25402c';
      c.lineWidth = 1.4;
      c.stroke();
      c.fillStyle = '#b46cf0';
      c.beginPath();
      c.ellipse(0, -r * 0.35, r * 0.72, r * 0.45, 0, Math.PI, TAU);
      c.fill();
    },
  },
  tags: ['minion', 'fungal', 'swarm'],
  neverElite: true,
  ai(e, ctx, dt) {
    chase(e, ctx, dt, e.speed, 0.14);
  },
};

export const MYCONID_SPLITTER: EnemyDef = {
  id: 'myconid_splitter',
  name: 'Myconid Splitter',
  stats: {
    hp: 55,
    damage: 12,
    speed: 62,
    radius: 18,
    knockbackResist: 0.25,
    mass: 2.2,
    contactDamage: false,
    xp: 6,
    coins: [2, 7],
    souls: 3,
    light: 40,
  },
  visual: {
    family: 'blob',
    body: '#2f5a3f',
    accent: '#b46cf0',
    glow: '#d0a4ff',
    outlineWidth: 2,
    draw(c, e, t) {
      const r = e.r;
      // Waddle: a two-phase squash driven by speed, so it reads as heavy.
      const speed = Math.sqrt(e.vx * e.vx + e.vy * e.vy);
      const w = Math.sin((t + e.seed * 5) * 0.011) * 0.1 * clamp01(speed / 60);
      const lunge = e.state === Phase.Windup ? 1 - clamp01(e.stateT / 600) : 0;

      c.save();
      c.scale(1 + w + lunge * 0.14, 1 - w - lunge * 0.1);
      c.fillStyle = '#2f5a3f';
      blob(c, 0, 0, r, (t + e.seed * 3) * 0.0035, 6, 0.09);
      c.fill();
      c.strokeStyle = '#16301f';
      c.lineWidth = 2;
      c.stroke();

      // Cap. Brightens on the wind-up.
      c.fillStyle = lunge > 0 ? '#d0a4ff' : '#b46cf0';
      c.beginPath();
      c.ellipse(0, -r * 0.42, r * 0.95, r * 0.6, 0, Math.PI, TAU);
      c.fill();
      c.strokeStyle = '#6b3a94';
      c.lineWidth = 1.6;
      c.stroke();
      c.restore();

      c.fillStyle = 'rgba(0,0,0,0.5)';
      circle(c, -r * 0.26, -r * 0.1, 2.2);
      circle(c, r * 0.26, -r * 0.1, 2.2);
    },
  },
  tags: ['splitter', 'fungal'],
  ai(e, ctx, dt) {
    if (e.state === Phase.Idle) chase(e, ctx, dt, e.speed, 0.32);
    else {
      e.vx *= 0.9;
      e.vy *= 0.9;
    }
    meleeSwing(e, ctx, dt, {
      windup: 600,
      active: 140,
      recover: 300,
      cooldown: 1500,
      arcDeg: 90,
      reach: 40,
      damage: e.dmg,
      knockback: 300,
      color: '#d0a4ff',
    });
  },
  onDeath(e, ctx) {
    // Two Sporelings, which do NOT split again. One level of recursion is a
    // tactical problem; unbounded recursion is a lag spike.
    const registry = splitRegistry;
    if (!registry) return;
    for (let i = 0; i < 2; i++) {
      const a = (i / 2) * TAU + Math.random();
      const child = spawnEnemyIn(ctx, registry, e.x + Math.cos(a) * 14, e.y + Math.sin(a) * 14, {
        roomId: e.roomId,
        trickle: (e.flags & Flags.Trickle) !== 0,
      });
      child.kx = Math.cos(a) * 180;
      child.ky = Math.sin(a) * 180;
    }
    ctx.fx.burst(e.x, e.y, {
      color: '#7ef2a1',
      count: 18,
      speed: [80, 240],
      size: [2, 4],
      life: [260, 520],
      additive: true,
    });
  },
};

/**
 * Set once at startup. Avoids a circular import between the splitter and the
 * enemy registry that contains it.
 */
let splitRegistry: EnemyDef | null = null;
export function bindSporeling(def: EnemyDef): void {
  splitRegistry = def;
}

// -------------------------------------------------------------- Cap Slinger

/** Response demanded: keep moving laterally; the floor is shrinking. */
export const CAP_SLINGER: EnemyDef = {
  id: 'cap_slinger',
  name: 'Cap Slinger',
  stats: {
    hp: 34,
    damage: 10,
    speed: 70,
    radius: 12,
    knockbackResist: 0.15,
    mass: 1.6,
    contactDamage: false,
    xp: 5,
    coins: [2, 5],
    souls: 2,
  },
  visual: {
    family: 'trapezoid',
    body: '#4a7d55',
    accent: '#a8f06e',
    outlineWidth: 2,
    draw(c, e) {
      const r = e.r;
      const charge = e.state === Phase.Windup ? 1 - clamp01(e.stateT / 500) : 0;

      // Mortar tube, raised to match its arcing shot.
      const a = Math.atan2(e.faceY, e.faceX) - 0.6;
      c.save();
      c.rotate(a);
      c.fillStyle = '#25402c';
      c.fillRect(0, -4, r * 1.5, 8);
      c.fillStyle = charge > 0 ? '#d9ff8a' : '#a8f06e';
      c.fillRect(r * 1.2, -4, 5, 8);
      c.restore();

      c.fillStyle = '#4a7d55';
      trapezoid(c, 0, 0, r, 0.55);
      c.fill();
      c.strokeStyle = '#16301f';
      c.lineWidth = 2;
      c.stroke();

      if (charge > 0) {
        c.fillStyle = `rgba(217,255,138,${0.25 + charge * 0.5})`;
        circle(c, 0, -r * 0.2, r * 0.4 * (0.6 + charge * 0.6));
      }
    },
  },
  tags: ['ranged', 'fungal'],
  ai(e, ctx, dt) {
    // Sidles rather than closing: it wants to stay at range and paint the floor.
    const dist = distToTarget(e, ctx);
    if (dist > 300) chase(e, ctx, dt, e.speed, 0.3);
    else if (dist < 140) {
      const dx = e.x - ctx.target.x;
      const dy = e.y - ctx.target.y;
      const l = Math.sqrt(dx * dx + dy * dy) || 1;
      e.vx += ((dx / l) * e.speed - e.vx) * Math.min(1, dt / 0.2);
      e.vy += ((dy / l) * e.speed - e.vy) * Math.min(1, dt / 0.2);
    } else {
      e.vx *= 0.9;
      e.vy *= 0.9;
    }
    faceTarget(e, ctx);

    lobAtTarget(e, ctx, dt, {
      cooldown: 2600,
      windup: 500,
      travel: 900,
      range: 380,
      spec: {
        speed: 0,
        radius: 6,
        damage: e.dmg,
        life: 900,
        color: '#a8f06e',
        light: 40,
        tint: Tint.Green,
        pool: { radius: 70, dps: 6, ms: 5000 },
      },
    });
  },
};

/** Ground telegraph for an in-flight lob, drawn under everything. */
export function drawLobTelegraph(c: CanvasRenderingContext2D, e: Entity, t: number): void {
  if (!isLob(e)) return;
  const progress = 1 - clamp01(e.life / Math.max(1, e.stateT));
  const r = (e.cd2 > 0 ? e.cd2 : 42) * 0.8;
  const pulse = 0.35 + Math.sin(t * 0.02) * 0.1 + progress * 0.35;

  c.strokeStyle = `rgba(217,255,138,${pulse})`;
  c.lineWidth = 2;
  c.beginPath();
  c.ellipse(e.ax, e.ay, r, r * 0.62, 0, 0, TAU);
  c.stroke();
  c.strokeStyle = `rgba(217,255,138,${pulse * 0.6})`;
  c.lineWidth = 1;
  c.beginPath();
  c.ellipse(e.ax, e.ay, r * progress, r * progress * 0.62, 0, 0, TAU);
  c.stroke();
}

/** Draw a lobbed shell above its ground position, with a shadow beneath. */
export function drawLob(c: CanvasRenderingContext2D, e: Entity): void {
  const h = lobHeight(e);
  c.fillStyle = 'rgba(0,0,0,0.3)';
  c.beginPath();
  c.ellipse(e.x, e.y, e.r * 0.8, e.r * 0.45, 0, 0, TAU);
  c.fill();
  c.fillStyle = e.tag;
  circle(c, e.x, e.y - h, e.r);
  c.fillStyle = 'rgba(255,255,255,0.3)';
  circle(c, e.x - e.r * 0.3, e.y - h - e.r * 0.3, e.r * 0.3);
}

export const FUNGAL_ENEMIES: EnemyDef[] = [
  SPORE_PUFF,
  MYCONID_SPLITTER,
  SPORELING,
  CAP_SLINGER,
];

bindSporeling(SPORELING);
