import { TAU, clamp01 } from '../../core/math';
import { PKind } from '../../render/fx';
import {
  arcBand,
  circle,
  pointyTriangle,
  roundRect,
  spikes,
} from '../../render/glyphs';
import { Tint } from '../../render/lighting';
import { applyDamage } from '../../world/combat';
import {
  Phase,
  chase,
  directionalShield,
  distToTarget,
  faceTarget,
  kite,
  meleeSwing,
  shootAt,
} from '../behaviors/primitives';
import type { EnemyDef } from '../types/enemy';

/**
 * Catacombs roster.
 *
 * Every entry demands a DIFFERENT response from the player. That is the point:
 * behaviour variety, not stat variety, is what stops an endless dungeon from
 * feeling like the same fight at bigger numbers.
 *
 * Draw functions work in LOCAL space with (0,0) at the entity centre; the
 * renderer has already translated and applied the hit flash.
 */

// ---------------------------------------------------------------- Bone Rat

/** Response demanded: crowd control, and never standing still. */
export const BONE_RAT: EnemyDef = {
  id: 'bone_rat',
  name: 'Bone Rat',
  stats: {
    hp: 14,
    damage: 5,
    speed: 145,
    radius: 8,
    knockbackResist: 0,
    mass: 1,
    contactDamage: true,
    xp: 1,
    coins: [0, 2],
    souls: 1,
  },
  visual: {
    family: 'triangle',
    body: '#d8cfae',
    accent: '#6b5f76',
    outlineWidth: 1.5,
    draw(c, e, t) {
      const r = e.r;
      // Tail whips opposite the turn, which reads as momentum at a glance.
      const wag = Math.sin((t + e.seed * 17) * 0.02) * 0.5;
      c.strokeStyle = '#6b5f76';
      c.lineWidth = 2;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(-e.faceX * r * 0.6, -e.faceY * r * 0.6);
      const ta = Math.atan2(-e.faceY, -e.faceX) + wag;
      c.quadraticCurveTo(
        Math.cos(ta) * r * 1.3,
        Math.sin(ta) * r * 1.3,
        Math.cos(ta + wag) * r * 2,
        Math.sin(ta + wag) * r * 2,
      );
      c.stroke();
      c.lineCap = 'butt';

      c.fillStyle = '#d8cfae';
      pointyTriangle(c, 0, 0, r, e.faceX, e.faceY, 0.85);
      c.fill();
      c.strokeStyle = '#6b5f76';
      c.lineWidth = 1.5;
      c.stroke();

      // Skull dot at the snout.
      c.fillStyle = '#f2ecd8';
      circle(c, e.faceX * r * 0.55, e.faceY * r * 0.55, r * 0.3);
    },
  },
  tags: ['swarm', 'undead'],
  pack: [3, 6],
  neverElite: true,
  ai(e, ctx, dt) {
    chase(e, ctx, dt, e.speed, 0.15);
  },
};

// ------------------------------------------------------------- Bone Archer

/** Response demanded: close the gap, or use cover. */
export const BONE_ARCHER: EnemyDef = {
  id: 'bone_archer',
  name: 'Bone Archer',
  stats: {
    hp: 26,
    damage: 9,
    speed: 92,
    radius: 9,
    knockbackResist: 0,
    mass: 1,
    contactDamage: false,
    xp: 4,
    coins: [1, 4],
    souls: 2,
  },
  visual: {
    family: 'rect',
    body: '#c8bfa0',
    accent: '#8a7c96',
    outlineWidth: 1.5,
    draw(c, e) {
      const r = e.r;
      const a = Math.atan2(e.faceY, e.faceX);

      // The bowstring visibly draws across the aim window. That telegraph is
      // the entire fairness contract for a ranged enemy.
      const draw = e.state === Phase.Windup ? 1 - clamp01(e.stateT / 700) : 0;
      c.strokeStyle = '#efe6cc';
      c.lineWidth = 1.6;
      c.beginPath();
      c.arc(0, 0, r * 1.5, a - 1.1, a + 1.1);
      c.stroke();
      if (draw > 0) {
        c.strokeStyle = '#fff6df';
        c.lineWidth = 1;
        const bx = Math.cos(a) * r * 1.5;
        const by = Math.sin(a) * r * 1.5;
        const nx = -Math.sin(a) * r * 1.32;
        const ny = Math.cos(a) * r * 1.32;
        const pull = -Math.cos(a) * r * draw * 1.1;
        const puy = -Math.sin(a) * r * draw * 1.1;
        c.beginPath();
        c.moveTo(bx + nx, by + ny);
        c.lineTo(pull, puy);
        c.lineTo(bx - nx, by - ny);
        c.stroke();
      }

      c.fillStyle = '#c8bfa0';
      roundRect(c, -4, -r * 1.2, 8, r * 2.2, 3);
      c.fill();
      c.strokeStyle = '#8a7c96';
      c.lineWidth = 1.5;
      c.stroke();
      c.fillStyle = '#f2ecd8';
      circle(c, 0, -r * 1.05, 4);
    },
  },
  tags: ['ranged', 'undead'],
  ai(e, ctx, dt) {
    kite(e, ctx, dt, e.speed, [240, 340]);
    shootAt(e, ctx, dt, {
      cooldown: 1500,
      windup: 700,
      requireStill: true,
      spec: {
        speed: 260,
        radius: 4,
        damage: e.dmg,
        life: 2400,
        color: '#efe6cc',
        light: 30,
        tint: Tint.Warm,
        knockback: 90,
      },
    });
  },
};

// --------------------------------------------------------- Skeleton Warden

const WARDEN_ARC = 140;
const WARDEN_REDUCTION = 0.85;

/** Response demanded: flank it, or hit it with a damage-over-time effect. */
export const SKELETON_WARDEN: EnemyDef = {
  id: 'skeleton_warden',
  name: 'Skeleton Warden',
  stats: {
    hp: 42,
    damage: 11,
    speed: 78,
    radius: 12,
    knockbackResist: 0.3,
    mass: 1.5,
    contactDamage: false,
    xp: 5,
    coins: [2, 6],
    souls: 3,
  },
  visual: {
    family: 'rect',
    body: '#8a7c96',
    accent: '#d8cfae',
    outlineWidth: 2,
    draw(c, e, t) {
      const r = e.r;

      // Body. Leans into the windup so the swing is legible before it lands.
      const lean = e.state === Phase.Windup ? 1 - clamp01(e.stateT / 800) : 0;
      c.save();
      c.rotate(lean * -0.28 * (e.faceX >= 0 ? 1 : -1));
      c.fillStyle = '#8a7c96';
      roundRect(c, -r * 0.55, -r * 1.4, r * 1.1, r * 2.4, 4);
      c.fill();
      c.strokeStyle = '#5a4f66';
      c.lineWidth = 2;
      c.stroke();
      c.fillStyle = '#e6ddc4';
      circle(c, 0, -r * 1.25, r * 0.44);
      c.restore();

      // Overhead swing arc during the active window.
      if (e.state === Phase.Active) {
        const a = Math.atan2(e.faceY, e.faceX);
        c.fillStyle = 'rgba(255,240,210,0.5)';
        arcBand(c, 0, 0, r * 1.2, 62, a, 0.61);
        c.fill();
      }

      // The shield, drawn at its LAGGING angle. Showing the lag is what makes
      // flanking a skill rather than a guess.
      const sa = e.ax;
      const pulse = 0.72 + Math.sin((t + e.seed * 9) * 0.004) * 0.06;
      c.fillStyle = `rgba(216,207,174,${pulse})`;
      arcBand(c, 0, 0, r * 1.05, r * 1.5, sa, ((WARDEN_ARC * 0.5) * Math.PI) / 180);
      c.fill();
      c.strokeStyle = '#fff4d6';
      c.lineWidth = 1.4;
      c.beginPath();
      c.arc(0, 0, r * 1.5, sa - 1.22, sa + 1.22);
      c.stroke();
    },
  },
  tags: ['armored', 'undead'],
  init(e) {
    e.ax = Math.PI * 0.5;
  },
  ai(e, ctx, dt) {
    // 0.35s of shield lag. Slow enough that a committed strafe gets behind it,
    // fast enough that standing still never works.
    const want = Math.atan2(ctx.target.y - e.y, ctx.target.x - e.x);
    let d = want - e.ax;
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    e.ax += d * Math.min(1, dt / 0.35);

    if (e.state === Phase.Idle) chase(e, ctx, dt, e.speed, 0.3);
    else {
      e.vx *= 0.86;
      e.vy *= 0.86;
    }

    meleeSwing(e, ctx, dt, {
      windup: 800,
      active: 140,
      recover: 320,
      cooldown: 1600,
      arcDeg: 70,
      reach: 62,
      damage: e.dmg,
      knockback: 260,
      color: '#fff4d6',
    });
  },
  modifyIncoming(e, dmg) {
    return directionalShield(e, dmg, WARDEN_ARC, WARDEN_REDUCTION);
  },
};

// -------------------------------------------------------------- Grave Hand

const HandState = {
  Dormant: 0,
  Erupting: 1,
  Active: 2,
  Sinking: 3,
} as const;

/**
 * Response demanded: read the floor; do not sprint blindly.
 *
 * This is the counterweight to speed-stacking builds — the only enemy in the
 * roster that punishes movement rather than rewarding it.
 */
export const GRAVE_HAND: EnemyDef = {
  id: 'grave_hand',
  name: 'Grave Hand',
  stats: {
    hp: 20,
    damage: 8,
    speed: 0,
    radius: 11,
    knockbackResist: 1,
    mass: 6,
    contactDamage: false,
    xp: 2,
    coins: [0, 3],
    souls: 1,
  },
  visual: {
    family: 'spikes',
    body: '#b8ae90',
    accent: '#6b5f76',
    outlineWidth: 1.5,
    draw(c, e) {
      const r = e.r;
      let grow = 0;
      if (e.state === HandState.Erupting) grow = 1 - clamp01(e.stateT / 350);
      else if (e.state === HandState.Active) grow = 1;
      else if (e.state === HandState.Sinking) grow = clamp01(e.stateT / 400);
      if (grow <= 0.01) return;

      c.fillStyle = '#b8ae90';
      spikes(c, 0, r * 0.5, r * 0.75, 3, grow, e.seed);
      c.strokeStyle = '#6b5f76';
      c.lineWidth = 1.2;
      c.globalAlpha = 0.9;
      spikes(c, 0, r * 0.5, r * 0.75, 3, grow, e.seed);
      c.globalAlpha = 1;
    },
  },
  tags: ['immobile', 'undead'],
  pack: [4, 7],
  neverElite: true,
  init(e) {
    e.state = HandState.Dormant;
  },
  drawTelegraph(c, e) {
    // Dormant hands leave a subtle floor discolouration. It is faint on purpose:
    // spotting it is a skill, and once you learn to look you stop getting caught.
    if (e.state !== HandState.Dormant) return;
    c.fillStyle = 'rgba(120,104,80,0.32)';
    c.beginPath();
    c.ellipse(0, 0, e.r * 1.15, e.r * 0.7, 0, 0, TAU);
    c.fill();
    c.strokeStyle = 'rgba(160,142,110,0.35)';
    c.lineWidth = 1;
    c.stroke();
  },
  ai(e, ctx, dt) {
    e.vx = 0;
    e.vy = 0;
    e.stateT -= dt * 1000;
    const dist = distToTarget(e, ctx);

    switch (e.state) {
      case HandState.Dormant:
        if (dist < 90) {
          e.state = HandState.Erupting;
          e.stateT = 350;
          ctx.fx.burst(e.x, e.y, {
            color: '#b8ae90',
            count: 12,
            speed: [60, 180],
            size: [1.8, 3.6],
            life: [260, 520],
            gravity: 300,
            kind: PKind.Chunk,
          });
        }
        break;

      case HandState.Erupting:
        if (e.stateT <= 0) {
          e.state = HandState.Active;
          e.stateT = 1400;
          if (dist < e.r + ctx.target.r + 12) {
            applyDamage(ctx, ctx.target, e.dmg, {
              srcX: e.x,
              srcY: e.y,
              knockback: 60,
            });
            // The root is the real threat: it takes away your escape for long
            // enough that whatever else is nearby gets a free hit.
            ctx.target.stun = Math.max(ctx.target.stun, 600);
          }
        }
        break;

      case HandState.Active:
        faceTarget(e, ctx);
        if (e.stateT <= 0) {
          e.state = HandState.Sinking;
          e.stateT = 400;
        }
        break;

      default:
        if (e.stateT <= 0) {
          e.state = HandState.Dormant;
          e.stateT = 0;
        }
        break;
    }
  },
};

export const CATACOMBS_ENEMIES: EnemyDef[] = [
  BONE_RAT,
  BONE_ARCHER,
  SKELETON_WARDEN,
  GRAVE_HAND,
];
