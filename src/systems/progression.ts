import type { Rng } from '../core/rng';
import { PERKS, type PerkDef } from '../content/perks';
import { addTrauma } from '../render/camera';
import { PKind } from '../render/fx';
import { Tint } from '../render/lighting';
import type { GameCtx } from '../world/ctx';
import type { Entity } from '../world/entities';
import { recomputeStats } from '../world/player';
import { grantsPerk, xpToNext } from './scaling';

/**
 * Levels and perks.
 *
 * The player power curve is meant to LOSE slowly to the enemy curve — about
 * 1.35% of relative capability per floor, which halves over roughly fifty
 * floors. That gentle, smooth decline is what makes a run end because your
 * margin for error ran out rather than because you hit a wall.
 *
 * Level-ups contribute the boring, reliable part of that curve. The exciting,
 * lumpy part is relics and perks.
 */

export function grantXp(ctx: GameCtx, amount: number): void {
  const p = ctx.player.player;
  if (!p || amount <= 0) return;

  p.xp += amount * p.stats.xpMul;
  let leveled = false;

  // A loop, not an if: a boss kill can cross two thresholds at once.
  while (p.xp >= p.xpNext) {
    p.xp -= p.xpNext;
    p.level++;
    p.xpNext = xpToNext(p.level);
    leveled = true;
    if (grantsPerk(p.level)) p.pendingPerks++;
  }

  if (!leveled) return;

  recomputeStats(ctx.player);
  // Level-ups heal the amount of max HP they grant, so gaining a level never
  // silently lowers your health fraction mid-fight.
  ctx.player.hp = Math.min(ctx.player.hpMax, ctx.player.hp + 8);

  ctx.fx.flash('#ffe6a8', 0.18, 6);
  ctx.fx.transientLight(ctx.player.x, ctx.player.y, 240, 480, Tint.Warm);
  ctx.fx.burst(ctx.player.x, ctx.player.y, {
    color: '#ffd24a',
    count: 30,
    speed: [70, 240],
    size: [1.8, 3.8],
    life: [400, 820],
    kind: PKind.Streak,
    additive: true,
    gravity: -60,
  });
  addTrauma(ctx.camera, 0.14);
}

/**
 * Three perks to choose from.
 *
 * Excludes anything already taken, and anything marked `unique` that is
 * already owned — offering a perk that would do nothing is worse than offering
 * a weaker one.
 */
export function offerPerks(rng: Rng, player: Entity, count = 3): PerkDef[] {
  const p = player.player;
  if (!p) return [];
  const owned = new Set(p.perks);
  const pool = PERKS.filter((perk) => !owned.has(perk.id));
  const shuffled = rng.shuffle([...pool]);
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

export function takePerk(ctx: GameCtx, id: string): void {
  const p = ctx.player.player;
  if (!p) return;
  if (p.perks.includes(id)) return;
  p.perks.push(id);
  p.pendingPerks = Math.max(0, p.pendingPerks - 1);
  recomputeStats(ctx.player);
}

/** Fraction of the way to the next level, for the HUD bar. */
export function xpFraction(player: Entity): number {
  const p = player.player;
  if (!p || p.xpNext <= 0) return 0;
  return Math.max(0, Math.min(1, p.xp / p.xpNext));
}
