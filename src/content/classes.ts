import type { GameCtx } from '../world/ctx';
import type { Entity } from '../world/entities';

/**
 * Starting classes.
 *
 * Rule for this whole system: a class must be a DIFFERENT game, never a
 * stronger one. The free class is deliberately the best relic-economy class in
 * the roster and is fully viable to floor 25+, because meta-progression that
 * gates competence behind a grind is how you lose a player on run three.
 */

export interface ClassDef {
  id: string;
  name: string;
  desc: string;
  unlockCost: number;
  hp: number;
  speedMult: number;
  weaponId: string;
  startRelics: string[];
  startConsumable: string | null;
  passive: { name: string; desc: string };
  /** Extra relic drops per floor. Wanderer's whole identity. */
  bonusRelicsPerFloor: number;
  /** Silhouette hints for the player art. */
  visual: {
    bodyShape: 'round' | 'broad' | 'lean' | 'squat';
    accent: string;
    trail: 'dust' | 'heavy' | 'ember' | 'spore';
  };
  onKill?(player: Entity, ctx: GameCtx): void;
  /** Called every tick, for passives that decay or accumulate. */
  onTick?(player: Entity, ctx: GameCtx, dt: number): void;
}

export const WANDERER: ClassDef = {
  id: 'wanderer',
  name: 'Wanderer',
  desc: 'Balanced. Finds more than anyone else.',
  unlockCost: 0,
  hp: 100,
  speedMult: 1,
  weaponId: 'chipped_cleaver',
  startRelics: [],
  startConsumable: 'bandage',
  passive: {
    name: 'Scavenger',
    desc: 'One extra relic drops on every floor.',
  },
  bonusRelicsPerFloor: 1,
  visual: { bodyShape: 'round', accent: '#d8cfae', trail: 'dust' },
};

export const GRAVEBOUND: ClassDef = {
  id: 'gravebound',
  name: 'Gravebound',
  desc: 'Slow, tough, wide swings. Kill to stay alive.',
  unlockCost: 250,
  hp: 130,
  speedMult: 0.92,
  weaponId: 'wardens_halberd',
  startRelics: ['iron_shard'],
  startConsumable: 'bandage',
  passive: {
    name: 'Bulwark',
    desc: 'Each kill grants a 3-point shield, up to 30. Decays if you stop killing.',
  },
  bonusRelicsPerFloor: 0,
  visual: { bodyShape: 'broad', accent: '#6b5f76', trail: 'heavy' },
  onKill(player) {
    const p = player.player;
    if (!p) return;
    p.shieldHp = Math.min(30, p.shieldHp + 3);
    // Four seconds of grace before the shield starts bleeding away, which is
    // exactly long enough that pushing into the next enemy is the right move.
    p.shieldDecayT = 4000;
  },
  onTick(player, _ctx, dt) {
    const p = player.player;
    if (!p) return;
    if (p.shieldDecayT > 0) {
      p.shieldDecayT -= dt * 1000;
      return;
    }
    if (p.shieldHp > 0) p.shieldHp = Math.max(0, p.shieldHp - 2 * dt);
  },
};

export const CLASSES: ClassDef[] = [WANDERER, GRAVEBOUND];

export const CLASS_BY_ID = new Map(CLASSES.map((c) => [c.id, c]));

export function classById(id: string): ClassDef {
  return CLASS_BY_ID.get(id) ?? WANDERER;
}
