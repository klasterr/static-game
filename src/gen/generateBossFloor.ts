import { TILE } from '../core/constants';
import type { Rng } from '../core/rng';
import { Tile, Tilemap } from '../world/tiles';
import { BOSS_PLAN } from '../systems/scaling';
import { fillVoid } from './generateRooms';
import { makeRoom, type Room } from './level';

export interface BossLayout {
  map: Tilemap;
  rooms: Room[];
  antechamber: Room;
  arena: Room;
  vault: Room;
}

/**
 * A fixed boss floor.
 *
 * Antechamber (shop + a healing shrine) -> hall -> arena -> reward vault with
 * the stairs. The vault sitting BEHIND the arena is the whole point: there is
 * no route past the boss, so the fight never feels like an optional detour you
 * skipped by accident.
 */
export function generateBossFloor(rng: Rng): BossLayout {
  const map = new Tilemap(BOSS_PLAN.w, BOSS_PLAN.h, Tile.Wall);

  const antechamber = makeRoom(0, 3, 18, 16, 12);
  const arena = makeRoom(1, 25, 8, 34, 32);
  const vault = makeRoom(2, 65, 19, 10, 10);
  const rooms = [antechamber, arena, vault];

  for (const r of rooms) carve(map, r, Tile.Floor);

  // Two width-4 halls, aligned on the arena's vertical centre.
  const hallY = arena.y + (arena.h >> 1) - 2;
  carveRect(map, 19, hallY, 6, 4, Tile.Corridor);
  carveRect(map, 59, hallY, 6, 4, Tile.Corridor);

  // Thresholds.
  carveRect(map, 19, hallY, 1, 4, Tile.DoorOpen);
  carveRect(map, 24, hallY, 1, 4, Tile.DoorOpen);
  carveRect(map, 59, hallY, 1, 4, Tile.DoorOpen);
  carveRect(map, 64, hallY, 1, 4, Tile.DoorOpen);

  antechamber.kind = 'entrance';
  antechamber.degree = 1;
  arena.kind = 'boss';
  arena.degree = 2;
  vault.kind = 'vault';
  vault.degree = 1;

  // Four symmetric pillars. They give the ring attack something to break line
  // of sight against, and they stop the arena reading as an empty box.
  const px = [arena.x + 7, arena.x + arena.w - 9];
  const py = [arena.y + 7, arena.y + arena.h - 9];
  for (const x of px) {
    for (const y of py) {
      carveRect(map, x, y, 2, 2, Tile.Prop);
    }
  }

  // Stairs at the back of the vault, entrance in the antechamber.
  map.set(vault.x + vault.w - 2, vault.cy, Tile.StairsDown);
  map.set(antechamber.x + 2, antechamber.cy, Tile.StairsUp);

  fillVoid(map);
  void rng;

  return { map, rooms, antechamber, arena, vault };
}

function carve(map: Tilemap, r: Room, tile: number): void {
  carveRect(map, r.x, r.y, r.w, r.h, tile);
}

function carveRect(
  map: Tilemap,
  x: number,
  y: number,
  w: number,
  h: number,
  tile: number,
): void {
  for (let ty = y; ty < y + h; ty++) {
    for (let tx = x; tx < x + w; tx++) {
      if (tx < 1 || ty < 1 || tx >= map.w - 1 || ty >= map.h - 1) continue;
      map.t[ty * map.w + tx] = tile;
    }
  }
}

/** Where the boss itself stands. */
export function bossSpawnPoint(layout: BossLayout): { x: number; y: number } {
  return {
    x: (layout.arena.x + (layout.arena.w >> 1)) * TILE + TILE * 0.5,
    y: (layout.arena.y + (layout.arena.h >> 1)) * TILE + TILE * 0.5,
  };
}
