import { TILE } from '../core/constants';
import type { Rng } from '../core/rng';
import {
  CONSUMABLE_REGISTRY,
  ENEMIES,
  RELIC_REGISTRY,
  WEAPON_REGISTRY,
} from '../content';
import { AFFIXES } from '../world/enemies';
import type { BiomeDef } from '../content/types/biome';
import type { ModifierDef } from '../content/modifiers';
import { Tile, Tilemap } from '../world/tiles';
import { eliteCount, enemyBudget } from '../systems/scaling';
import {
  pickConsumable,
  pickRelic,
  planDrops,
  rollRarity,
  type LootPools,
} from '../systems/loot';
import { Rarity } from '../content/types/item';
import type { Level, LootRecord, Room } from './level';
import { tileDistances } from './connectivity';

/**
 * Enemy and loot placement.
 *
 * Runs on `Stream.Population` and `Stream.Loot`, which are independent of
 * `Stream.Layout`. That independence is the reason a balance tweak to drop
 * rates does not silently change every dungeon layout a shared seed produces.
 */

export interface PopulateInput {
  level: Level;
  biome: BiomeDef;
  modifier: ModifierDef;
  depth: number;
  popRng: Rng;
  lootRng: Rng;
  pools: LootPools;
  /** Wanderer's Scavenger passive. */
  bonusRelics: number;
  /** True when the player arrived below 35% health. See the catch-up rule. */
  needsMercy: boolean;
}

export function populateFloor(input: PopulateInput): void {
  const map = input.level.map;
  const entranceTx = Math.floor(input.level.entrance.x / TILE);
  const entranceTy = Math.floor(input.level.entrance.y / TILE);

  placeEnemies(input, map, entranceTx, entranceTy);
  placeLoot(input, map);
}

// ------------------------------------------------------------------ enemies

interface Candidate {
  tx: number;
  ty: number;
  roomId: number;
}

function collectSpawnTiles(
  map: Tilemap,
  level: Level,
  entranceTx: number,
  entranceTy: number,
): Candidate[] {
  const out: Candidate[] = [];
  const roomKind = new Map<number, string>();
  for (const r of level.rooms) roomKind.set(r.id, r.kind);

  for (let ty = 1; ty < map.h - 1; ty++) {
    for (let tx = 1; tx < map.w - 1; tx++) {
      const t = map.at(tx, ty);
      if (t !== Tile.Floor && t !== Tile.Corridor) continue;

      // Nobody spawns on your doorstep. Arriving on a new floor into a pile of
      // enemies reads as unfair no matter how survivable it is.
      if (Math.abs(tx - entranceTx) <= 6 && Math.abs(ty - entranceTy) <= 6) continue;

      const rid = level.roomAt[ty * map.w + tx];
      const kind = rid >= 0 ? roomKind.get(rid) : undefined;
      // Special rooms get hand-placed occupants (or none at all).
      if (kind === 'shop' || kind === 'shrine' || kind === 'entrance') continue;
      if (kind === 'elite' || kind === 'treasure') continue;

      out.push({ tx, ty, roomId: rid });
    }
  }
  return out;
}

function placeEnemies(
  input: PopulateInput,
  map: Tilemap,
  entranceTx: number,
  entranceTy: number,
): void {
  const { level, biome, modifier, depth, popRng } = input;
  const rng = popRng;

  const walkable = map.countWalkable();
  let budget = Math.round(enemyBudget(depth, walkable) * modifier.countMul);

  const roster = biome.roster.filter((w) => (w.minFloor ?? 1) <= depth && w.weight > 0);
  if (roster.length === 0) return;

  const perFloorCount = new Map<string, number>();
  const candidates = collectSpawnTiles(map, level, entranceTx, entranceTy);
  if (candidates.length === 0) return;
  rng.shuffle(candidates);

  let cursor = 0;
  const take = (): Candidate | null => {
    if (cursor >= candidates.length) return null;
    return candidates[cursor++];
  };

  let guard = 0;
  while (budget > 0 && guard < 600) {
    guard++;
    const entry = rng.weighted(
      roster.map((w) => ({
        value: w,
        weight:
          (w.maxPerFloor !== undefined &&
            (perFloorCount.get(w.id) ?? 0) >= w.maxPerFloor)
            ? 0
            : w.weight,
      })),
    );
    const def = ENEMIES[entry.id];
    if (!def) break;

    const spot = take();
    if (!spot) break;

    // Packs read completely differently from singles: six Bone Rats is a
    // pressure wave, one is a nuisance.
    const packSize = def.pack ? rng.int(def.pack[0], def.pack[1]) : 1;
    for (let i = 0; i < packSize && budget > 0; i++) {
      const px = i === 0 ? spot.tx : spot.tx + rng.int(-2, 2);
      const py = i === 0 ? spot.ty : spot.ty + rng.int(-2, 2);
      if (!map.isWalkable(px, py)) continue;
      level.spawns.push({
        enemyId: def.id,
        x: px * TILE + TILE * 0.5,
        y: py * TILE + TILE * 0.5,
        elite: false,
        affix: '',
        roomId: spot.roomId,
      });
      budget -= entry.cost;
      perFloorCount.set(def.id, (perFloorCount.get(def.id) ?? 0) + 1);
    }
  }

  placeElites(input, map);
  placeVaultGuards(input, map);
  markBounty(input);
}

/** Elites: one per elite room plus a scaling number scattered elsewhere. */
function placeElites(input: PopulateInput, map: Tilemap): void {
  const { level, biome, depth, popRng } = input;
  const rng = popRng;
  const pool = biome.eliteRoster.filter((id) => {
    const def = ENEMIES[id];
    return def !== undefined && !def.neverElite;
  });
  if (pool.length === 0) return;

  const total = eliteCount(depth);
  const eliteRoom = level.rooms.find((r) => r.kind === 'elite');

  for (let i = 0; i < total; i++) {
    const id = rng.pick(pool);
    const affix = rng.pick(AFFIXES).id;

    let tx: number;
    let ty: number;
    let roomId = -1;

    if (i === 0 && eliteRoom) {
      tx = eliteRoom.cx;
      ty = eliteRoom.cy;
      roomId = eliteRoom.id;
      // Escort: an elite alone in a big room is a duel, which is less
      // interesting than an elite you have to fight through a crowd.
      addEscort(input, map, eliteRoom, 4);
    } else {
      const spot = randomFloorTile(rng, map, level);
      if (!spot) continue;
      tx = spot.tx;
      ty = spot.ty;
      roomId = spot.roomId;
    }

    level.spawns.push({
      enemyId: id,
      x: tx * TILE + TILE * 0.5,
      y: ty * TILE + TILE * 0.5,
      elite: true,
      affix,
      roomId,
    });
  }
}

/**
 * The treasure vault: an elite plus an escort, standing between you and a
 * rarity-boosted chest.
 *
 * Deliberately NOT sealed behind a locked door. The original design had the
 * door open when its guards died — but the guards are inside the vault, so the
 * door could never open and the room was a soft-lock (the connectivity fuzz
 * caught it as a 50-250 tile orphaned region). The fight itself is the lock,
 * which is the thing that was actually interesting about it.
 */
function placeVaultGuards(input: PopulateInput, map: Tilemap): void {
  const { level, biome, popRng } = input;
  const vault = level.rooms.find((r) => r.kind === 'treasure');
  if (!vault) return;

  const pool = biome.eliteRoster.filter((id) => ENEMIES[id] && !ENEMIES[id].neverElite);
  if (pool.length > 0) {
    level.spawns.push({
      enemyId: popRng.pick(pool),
      x: vault.cx * TILE + TILE * 0.5,
      y: vault.cy * TILE + TILE * 0.5,
      elite: true,
      affix: popRng.pick(AFFIXES).id,
      roomId: vault.id,
    });
  }
  addEscort(input, map, vault, 4);
}

function addEscort(input: PopulateInput, map: Tilemap, room: Room, count: number): void {
  const { level, biome, depth, popRng } = input;
  const roster = biome.roster.filter(
    (w) => (w.minFloor ?? 1) <= depth && w.weight > 0 && !ENEMIES[w.id]?.tags.includes('immobile'),
  );
  if (roster.length === 0) return;

  for (let i = 0; i < count; i++) {
    const entry = popRng.weighted(roster.map((w) => ({ value: w, weight: w.weight })));
    const tx = popRng.int(room.x + 1, room.x + room.w - 2);
    const ty = popRng.int(room.y + 1, room.y + room.h - 2);
    if (!map.isWalkable(tx, ty)) continue;
    level.spawns.push({
      enemyId: entry.id,
      x: tx * TILE + TILE * 0.5,
      y: ty * TILE + TILE * 0.5,
      elite: false,
      affix: '',
      roomId: room.id,
    });
  }
}

/** The Bounty modifier marks one ordinary enemy as worth triple souls. */
function markBounty(input: PopulateInput): void {
  if (!input.modifier.bounty) return;
  const { level, popRng } = input;
  const plain = level.spawns.filter((s) => !s.elite);
  if (plain.length === 0) return;
  const chosen = plain[popRng.pickIndex(plain.length)];
  chosen.affix = 'bounty';
}

function randomFloorTile(rng: Rng, map: Tilemap, level: Level): Candidate | null {
  for (let attempt = 0; attempt < 80; attempt++) {
    const tx = rng.int(2, map.w - 3);
    const ty = rng.int(2, map.h - 3);
    const t = map.at(tx, ty);
    if (t !== Tile.Floor && t !== Tile.Corridor) continue;
    const rid = level.roomAt[ty * map.w + tx];
    const room = rid >= 0 ? level.rooms[rid] : undefined;
    if (room && (room.kind === 'entrance' || room.kind === 'shop' || room.kind === 'shrine')) {
      continue;
    }
    return { tx, ty, roomId: rid };
  }
  return null;
}

// --------------------------------------------------------------------- loot

function placeLoot(input: PopulateInput, map: Tilemap): void {
  const { level, biome, modifier, depth, lootRng, pools, bonusRelics, needsMercy } = input;
  const rng = lootRng;
  const plan = planDrops(rng, depth, bonusRelics, modifier.extraItems);

  const fromEntrance = tileDistances(
    map,
    Math.floor(level.entrance.x / TILE),
    Math.floor(level.entrance.y / TILE),
  );
  const fromExit = tileDistances(
    map,
    Math.floor(level.exit.x / TILE),
    Math.floor(level.exit.y / TILE),
  );

  // Rooms sorted by how far OFF the main path they are, so exploring pays.
  const scored = level.rooms
    .filter((r) => r.kind === 'normal' || r.kind === 'exit')
    .map((r) => {
      const a = fromEntrance[r.cy * map.w + r.cx];
      const b = fromExit[r.cy * map.w + r.cx];
      const detour = a < 0 || b < 0 ? 0 : a + b - level.mainPathLength;
      return { room: r, detour };
    })
    .sort((x, y) => y.detour - x.detour);

  const push = (rec: LootRecord): void => {
    level.loot.push(rec);
  };

  const spotIn = (room: Room): { x: number; y: number } => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const tx = rng.int(room.x + 1, room.x + room.w - 2);
      const ty = rng.int(room.y + 1, room.y + room.h - 2);
      if (!map.isWalkable(tx, ty)) continue;
      if (map.at(tx, ty) === Tile.HazardStatic) continue;
      return { x: tx * TILE + TILE * 0.5, y: ty * TILE + TILE * 0.5 };
    }
    return { x: room.cx * TILE + TILE * 0.5, y: room.cy * TILE + TILE * 0.5 };
  };

  // ---- relics, one per room, best detours first
  let placed = 0;
  let mercyUsed = false;
  for (const { room } of scored) {
    if (placed >= plan.relics) break;
    const rarity = rollRarity(rng, depth, modifier.rarityBoost);
    let id = pickRelic(rng, pools, rarity, biome.lootBias.relics);

    /**
     * The catch-up rule. If the player arrived under 35% health, silently make
     * one drop a defensive or sustain relic and let the rest roll normally.
     * Undisclosed on purpose: it converts the classic roguelite death spiral
     * (low health, can't fight, lower health) into a recoverable dip without
     * ever telling the player the game went easy on them.
     */
    if (needsMercy && !mercyUsed) {
      const sustain = pools.relics.filter(
        (r) => r === 'iron_shard' || r === 'leech_rune' || r === 'broken_hourglass',
      );
      if (sustain.length > 0) {
        id = rng.pick(sustain);
        mercyUsed = true;
      }
    }

    if (!id) break;
    const p = spotIn(room);
    push({ kind: 'relic', id, x: p.x, y: p.y, roomId: room.id, rarityBoost: 0, price: 0 });
    placed++;
  }

  // Leftovers scatter anywhere walkable, so a small floor still pays out.
  while (placed < plan.relics) {
    const spot = randomFloorTile(rng, map, level);
    if (!spot) break;
    const rarity = rollRarity(rng, depth, modifier.rarityBoost);
    const id = pickRelic(rng, pools, rarity, biome.lootBias.relics);
    if (!id) break;
    push({
      kind: 'relic',
      id,
      x: spot.tx * TILE + TILE * 0.5,
      y: spot.ty * TILE + TILE * 0.5,
      roomId: spot.roomId,
      rarityBoost: 0,
      price: 0,
    });
    placed++;
  }

  // ---- consumables
  for (let i = 0; i < plan.consumables; i++) {
    const spot = randomFloorTile(rng, map, level);
    if (!spot) break;
    const id = pickConsumable(rng, pools);
    if (!id) break;
    push({
      kind: 'consumable',
      id,
      x: spot.tx * TILE + TILE * 0.5,
      y: spot.ty * TILE + TILE * 0.5,
      roomId: spot.roomId,
      rarityBoost: 0,
      price: 0,
    });
  }

  // ---- weapon pedestal
  if (plan.pedestal) {
    const room = scored.length > 0 ? scored[Math.min(1, scored.length - 1)].room : level.rooms[0];
    if (room) {
      const p = spotIn(room);
      push({
        kind: 'pedestal',
        id: '',
        x: p.x,
        y: p.y,
        roomId: room.id,
        rarityBoost: 0,
        price: 0,
        offer: 'weapon',
      });
    }
  }

  // ---- treasure vault chest
  const vault = level.rooms.find((r) => r.kind === 'treasure');
  if (vault) {
    push({
      kind: 'chest',
      id: '',
      x: vault.cx * TILE + TILE * 0.5,
      y: vault.cy * TILE + TILE * 0.5 + TILE,
      roomId: vault.id,
      // A tier above what the floor would normally roll: the reward has to
      // justify a detour past an elite and its escort.
      rarityBoost: 1,
      price: 0,
    });
  }

  // ---- shrine
  const shrineRoom = level.rooms.find((r) => r.kind === 'shrine');
  if (shrineRoom) {
    push({
      kind: 'shrine',
      id: '',
      x: shrineRoom.cx * TILE + TILE * 0.5,
      y: shrineRoom.cy * TILE + TILE * 0.5,
      roomId: shrineRoom.id,
      rarityBoost: 0,
      price: 0,
    });
  }

  // ---- shop stock: two relics, one weapon, one consumable
  const shop = level.rooms.find((r) => r.kind === 'shop');
  if (shop) {
    const stock: Array<{ kind: 'relic' | 'weapon' | 'consumable'; id: string }> = [];
    for (let i = 0; i < 2; i++) {
      const id = pickRelic(rng, pools, rollRarity(rng, depth, 0), biome.lootBias.relics);
      if (id) stock.push({ kind: 'relic', id });
    }
    const weaponId = pools.weapons.length > 0 ? rng.pick(pools.weapons) : null;
    if (weaponId) stock.push({ kind: 'weapon', id: weaponId });
    const consumableId = pickConsumable(rng, pools);
    if (consumableId) stock.push({ kind: 'consumable', id: consumableId });

    const spacing = TILE * 2;
    const startX = shop.cx * TILE + TILE * 0.5 - ((stock.length - 1) * spacing) / 2;
    for (let i = 0; i < stock.length; i++) {
      push({
        kind: 'shop',
        id: stock[i].id,
        x: startX + i * spacing,
        y: shop.cy * TILE + TILE * 0.5,
        roomId: shop.id,
        rarityBoost: 0,
        price: priceFor(stock[i].kind, stock[i].id, depth),
        offer: stock[i].kind,
      });
    }
  }
}

const RARITY_PRICE_BUMP = [0, 12, 30, 60];

function priceFor(kind: 'relic' | 'weapon' | 'consumable', id: string, depth: number): number {
  const base = kind === 'consumable' ? 22 : kind === 'weapon' ? 55 : 40;
  const rarity =
    kind === 'relic'
      ? RELIC_REGISTRY[id]?.rarity ?? Rarity.Common
      : kind === 'weapon'
        ? WEAPON_REGISTRY[id]?.rarity ?? Rarity.Common
        : CONSUMABLE_REGISTRY[id]?.rarity ?? Rarity.Common;
  // Prices drift up with depth, so coin stays meaningful rather than becoming
  // a rounding error by floor 15.
  return Math.round((base + RARITY_PRICE_BUMP[rarity]) * (1 + depth * 0.06));
}
