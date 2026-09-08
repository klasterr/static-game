import type { Tilemap } from '../world/tiles';

export type RoomKind =
  | 'normal'
  | 'entrance'
  | 'exit'
  | 'treasure'
  | 'shrine'
  | 'elite'
  | 'shop'
  | 'boss'
  | 'vault';

export interface Room {
  id: number;
  /** Tile coords; the room covers x..x+w-1, y..y+h-1 inclusive. */
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
  kind: RoomKind;
  /** Number of corridors attached. Degree 1 rooms make good vaults. */
  degree: number;
  /** BFS room-graph distance from the entrance. */
  distFromEntrance: number;
  neighbors: number[];
  /** True once the player has been inside. Drives the trickle spawner. */
  visited: boolean;
}

export interface SpawnRecord {
  enemyId: string;
  x: number;
  y: number;
  elite: boolean;
  affix: string;
  roomId: number;
  boss?: boolean;
}

export type LootKind =
  | 'relic'
  | 'consumable'
  | 'coin'
  | 'chest'
  | 'pedestal'
  | 'shrine'
  | 'heal'
  /** Priced stock in a shop room. */
  | 'shop';

export interface LootRecord {
  kind: LootKind;
  /** Item id where applicable; chests and shrines resolve theirs on open. */
  id: string;
  x: number;
  y: number;
  roomId: number;
  /** Bumps the rarity roll a tier. Treasure vaults use this. */
  rarityBoost: number;
  /** Coin cost. 0 means free. */
  price: number;
  /** For shop stock and pedestals: what kind of thing is on offer. */
  offer?: 'relic' | 'weapon' | 'consumable';
}

export interface EmitterRecord {
  x: number;
  y: number;
  radius: number;
  tint: number;
  /** Torches flicker; ambient sources are steady. */
  flickers: boolean;
}

export interface Level {
  depth: number;
  seed: number;
  biomeId: string;
  modifierId: string | null;
  map: Tilemap;
  rooms: Room[];
  /** World-pixel positions. */
  entrance: { x: number; y: number };
  exit: { x: number; y: number };
  spawns: SpawnRecord[];
  loot: LootRecord[];
  emitters: EmitterRecord[];
  /** Tile distance from entrance to exit along the room graph. */
  mainPathLength: number;
  /** Tile index -> room id, or -1. */
  roomAt: Int16Array;
  isBoss: boolean;
  /** Generation attempts used. Non-zero means a regenerate happened. */
  attempts: number;
}

export function roomContains(r: Room, tx: number, ty: number): boolean {
  return tx >= r.x && ty >= r.y && tx < r.x + r.w && ty < r.y + r.h;
}

export function roomArea(r: Room): number {
  return r.w * r.h;
}

/** Rectangles overlap when expanded by `margin` on every side. */
export function roomsOverlap(a: Room, b: Room, margin: number): boolean {
  return (
    a.x - margin < b.x + b.w + margin &&
    a.x + a.w + margin > b.x - margin &&
    a.y - margin < b.y + b.h + margin &&
    a.y + a.h + margin > b.y - margin
  );
}

export function makeRoom(id: number, x: number, y: number, w: number, h: number): Room {
  return {
    id,
    x,
    y,
    w,
    h,
    cx: x + (w >> 1),
    cy: y + (h >> 1),
    kind: 'normal',
    degree: 0,
    distFromEntrance: 0,
    neighbors: [],
    visited: false,
  };
}

/** Fill `roomAt` from the room list. Later rooms win on overlap. */
export function indexRooms(map: Tilemap, rooms: Room[]): Int16Array {
  const out = new Int16Array(map.w * map.h).fill(-1);
  for (const r of rooms) {
    for (let ty = r.y; ty < r.y + r.h; ty++) {
      if (ty < 0 || ty >= map.h) continue;
      for (let tx = r.x; tx < r.x + r.w; tx++) {
        if (tx < 0 || tx >= map.w) continue;
        out[ty * map.w + tx] = r.id;
      }
    }
  }
  return out;
}

export function roomIdAt(level: Level, tx: number, ty: number): number {
  const map = level.map;
  if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) return -1;
  return level.roomAt[ty * map.w + tx];
}
