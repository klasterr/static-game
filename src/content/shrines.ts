import type { GameCtx } from '../world/ctx';
import type { Entity } from '../world/entities';
import { healPlayer } from '../world/combat';

/**
 * Shrines: one per floor, TWO offered, pick one.
 *
 * Offering two and forcing a choice is what makes a shrine a decision rather
 * than a slot machine. Every option below has a real cost, so there is never an
 * obviously correct pick.
 */

export interface ShrineDef {
  id: string;
  name: string;
  desc: string;
  color: string;
  /** True for effects that last the whole run rather than the floor. */
  permanent: boolean;
  /** Returns false if it cannot be used right now (e.g. already full health). */
  activate(player: Entity, ctx: GameCtx): boolean;
  /** Availability gate; Mending locks itself out for two floors after use. */
  available?(state: ShrineState, depth: number): boolean;
  onUse?(state: ShrineState, depth: number): void;
}

/** Cross-floor shrine bookkeeping, owned by the run state. */
export interface ShrineState {
  mendingLockedUntil: number;
  used: string[];
}

export function blankShrineState(): ShrineState {
  return { mendingLockedUntil: 0, used: [] };
}

export const SHRINE_OF_BLOOD: ShrineDef = {
  id: 'blood',
  name: 'Shrine of Blood',
  desc: '+25% damage for the rest of the run, -20% max health.',
  color: '#c2323c',
  permanent: true,
  activate(player) {
    const p = player.player;
    if (!p) return false;
    p.shrineDmgBonus += 0.25;
    p.shrineHpMul *= 0.8;
    return true;
  },
};

export const SHRINE_OF_MENDING: ShrineDef = {
  id: 'mending',
  name: 'Shrine of Mending',
  desc: 'Heal half your maximum health. No shrines for two floors.',
  color: '#7ef2a1',
  permanent: false,
  activate(player, ctx) {
    healPlayer(ctx, player.hpMax * 0.5);
    return true;
  },
  available(state, depth) {
    return depth >= state.mendingLockedUntil;
  },
  onUse(state, depth) {
    // The healing economy is bounded on purpose: if you could top up every
    // floor, health would stop being a resource you spend across a run and low
    // health would stop being a legible signal to play carefully.
    state.mendingLockedUntil = depth + 3;
  },
};

export const SHRINE_OF_RUIN: ShrineDef = {
  id: 'ruin',
  name: 'Shrine of Ruin',
  desc: 'This floor: enemies gain 50% health, but two extra items appear.',
  color: '#ff7a1a',
  permanent: false,
  activate(player, ctx) {
    ctx.ruinActive = true;
    void player;
    return true;
  },
};

export const SHRINE_OF_WEIGHT: ShrineDef = {
  id: 'weight',
  name: 'Shrine of Weight',
  desc: '-15% move speed for the rest of the run, +30 max health.',
  color: '#8f97a3',
  permanent: true,
  activate(player) {
    const p = player.player;
    if (!p) return false;
    p.shrineMoveMul *= 0.85;
    p.shrineHpBonus += 30;
    return true;
  },
};

export const SHRINES: ShrineDef[] = [
  SHRINE_OF_BLOOD,
  SHRINE_OF_MENDING,
  SHRINE_OF_RUIN,
  SHRINE_OF_WEIGHT,
];

export const SHRINE_BY_ID = new Map(SHRINES.map((s) => [s.id, s]));

export function shrineById(id: string): ShrineDef | undefined {
  return SHRINE_BY_ID.get(id);
}
