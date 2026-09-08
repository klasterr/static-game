import { STEP_S, TILE } from '../core/constants';
import { Stream, floorRng, makeRng, parseSeedInput, type Rng } from '../core/rng';
import { getSave, markDirty, saveNow, type SaveData } from '../core/storage';
import { CONSUMABLE_REGISTRY, ENEMIES, RELIC_REGISTRY, WEAPON_REGISTRY } from '../content';
import { classById } from '../content/classes';
import { NO_MODIFIER, modifierById, type ModifierDef } from '../content/modifiers';
import { SHRINES, blankShrineState, type ShrineDef, type ShrineState } from '../content/shrines';
import type { BiomeDef } from '../content/types/biome';
import { RARITY_COLOR } from '../content/types/item';
import { generateFloor } from '../gen/floor';
import type { Level } from '../gen/level';
import {
  addTrauma,
  makeCamera,
  snapCamera,
  updateCamera,
  type Camera,
} from '../render/camera';
import { InteractKind, PickupKind } from '../render/entityart';
import { fx, PKind } from '../render/fx';
import { Tint } from '../render/lighting';
import { grantXp } from '../systems/progression';
import { pickRelic, poolsFor, rollRarity, soulValue, type LootPools } from '../systems/loot';
import {
  bossHp,
  dmgMult,
  hpMult,
  soulsEarned,
  speedMult,
  xpPerKill,
  type RunSummary,
} from '../systems/scaling';
import {
  blankTrickleState,
  updateTrickle,
  updateVisitedRooms,
  type TrickleState,
} from '../systems/trickle';
import { setRewardHooks } from '../world/combat';
import { contactDamagePass } from '../world/combat';
import { escalationFor, type GameCtx } from '../world/ctx';
import {
  EKind,
  Flags,
  TEAM_PLAYER,
  blankPlayerState,
  makePlayer,
  type Entity,
} from '../world/entities';
import { spawnEnemyIn, tileHazardPass, updateEnemies } from '../world/enemies';
import { FlowField } from '../world/flowfield';
import {
  giveConsumable,
  grantRelic,
  onStairs,
  recomputeStats,
  updatePlayer,
} from '../world/player';
import { updateHazardEntities, updateProjectiles, updateStatuses } from '../world/projectiles';
import { Tile } from '../world/tiles';
import { World } from '../world/world';

/**
 * The run.
 *
 * Owns the world, the current floor, and the simulation order. Also the place
 * where the reward economy lives, because rewards need both the content
 * registries and the save — neither of which `world/` is allowed to know about.
 */

export type ChoiceKind = 'perk' | 'shrine';

export interface PendingChoice {
  kind: ChoiceKind;
  /** Ids into the perk or shrine registries. */
  options: string[];
  /** The shrine entity, so it can be marked used once resolved. */
  sourceId: number;
}

export interface InteractTarget {
  entity: Entity;
  prompt: string;
}

export class RunState {
  readonly world = new World();
  readonly camera: Camera = makeCamera();
  readonly flow = new FlowField();

  level!: Level;
  biome!: BiomeDef;
  modifier: ModifierDef = NO_MODIFIER;
  ctx!: GameCtx;

  depth = 0;
  runSeed = 0;
  seedText = '';
  save: SaveData = getSave();
  pools: LootPools = poolsFor(this.save);

  trickle: TrickleState = blankTrickleState(1);
  shrines: ShrineState = blankShrineState();
  recentModifiers: string[] = [];

  /** Seeded per floor. Crit rolls and AI jitter. */
  combatRng: Rng = makeRng(1, 'combat');
  /** Separate stream for trickle spawn choices. */
  trickleRng: Rng = makeRng(2, 'trickle');

  bannerMs = 0;
  floorMs = 0;
  /** Set when the player steps onto the stairs, so the scene can descend. */
  wantsDescend = false;
  pendingChoice: PendingChoice | null = null;
  interactTarget: InteractTarget | null = null;
  /** Latest pickup name, for a brief on-screen toast. */
  toast = '';
  toastMs = 0;
  toastColor = '#ffffff';

  dead = false;
  summary: RunSummary = { deepestFloor: 0, bossesKilled: 0, elitesKilled: 0, kills: 0 };

  constructor() {
    setRewardHooks({ onEnemyKilled: (ctx, e) => this.onEnemyKilled(ctx, e) });
  }

  // ------------------------------------------------------------ lifecycle

  start(classId: string, seedInput: string): void {
    this.save = getSave();
    this.pools = poolsFor(this.save);
    const parsed = parseSeedInput(seedInput);
    this.runSeed = parsed.seed;
    this.seedText = parsed.text;

    this.shrines = blankShrineState();
    this.recentModifiers = [];
    this.dead = false;
    this.summary = { deepestFloor: 0, bossesKilled: 0, elitesKilled: 0, kills: 0 };

    this.save.runs++;
    markDirty();

    this.depth = 0;
    this.enterFloor(1, classId);
  }

  /**
   * Build the next floor.
   *
   * Souls are banked HERE rather than on death, so a crash or a closed tab
   * mid-run never costs the whole run's progress.
   */
  enterFloor(depth: number, classId?: string): void {
    const carriedPlayer = classId === undefined ? this.snapshotPlayer() : null;
    if (carriedPlayer) this.bankSouls();

    this.depth = depth;
    this.summary.deepestFloor = Math.max(this.summary.deepestFloor, depth);

    const cls = classById(classId ?? carriedPlayer?.classId ?? 'wanderer');
    const needsMercy =
      carriedPlayer !== null && carriedPlayer.hpFraction < 0.35;

    const result = generateFloor({
      depth,
      runSeed: this.runSeed,
      save: this.save,
      bonusRelics: cls.bonusRelicsPerFloor,
      needsMercy,
      recentModifiers: this.recentModifiers,
    });

    this.level = result.level;
    this.biome = result.biome;
    this.modifier = modifierById(result.level.modifierId) ?? NO_MODIFIER;
    if (this.modifier.id !== 'none') this.recentModifiers.push(this.modifier.id);

    this.combatRng = floorRng(this.runSeed, depth, Stream.Combat);
    this.trickleRng = floorRng(this.runSeed, depth, Stream.Population, 'trickle');
    this.trickle = blankTrickleState(depth);
    this.floorMs = 0;
    this.bannerMs = 1500;
    this.wantsDescend = false;
    this.pendingChoice = null;
    this.interactTarget = null;

    this.world.reset(this.level.map);
    fx.clearWorld();

    const player = this.world.spawn(EKind.Player, this.level.entrance.x, this.level.entrance.y, TEAM_PLAYER);
    makePlayer(player, WEAPON_REGISTRY[cls.weaponId], this.level.entrance.x, this.level.entrance.y);
    this.world.player = player;

    if (carriedPlayer) {
      player.player = carriedPlayer.state;
      player.hpMax = carriedPlayer.hpMax;
      player.hp = Math.max(1, carriedPlayer.hp);
      recomputeStats(player);
    } else {
      const state = blankPlayerState(WEAPON_REGISTRY[cls.weaponId]);
      state.classId = cls.id;
      state.slotCount = this.save.unlocks.includes('second_pocket') ? 2 : 1;
      player.player = state;
      recomputeStats(player);
      player.hp = player.hpMax;
      for (const id of cls.startRelics) grantRelic(this.makeCtx(player), id);
      if (cls.startConsumable) giveConsumable(player, cls.startConsumable);
    }

    this.ctx = this.makeCtx(player);
    snapCamera(this.camera, player.x, player.y);
    this.camera.shakeScale = this.save.settings.shake;
    fx.allowFlashes = this.save.settings.flashes;
    fx.allowDamageNumbers = this.save.settings.damageNumbers;

    this.spawnLevelContents();
    this.world.lockThreatBaseline();
    this.flow.compute(this.level.map, player.x, player.y);

    if (!this.save.seenBiomes.includes(this.biome.id)) {
      this.save.seenBiomes.push(this.biome.id);
    }
    saveNow();
  }

  private snapshotPlayer(): {
    state: NonNullable<Entity['player']>;
    hp: number;
    hpMax: number;
    hpFraction: number;
    classId: string;
  } | null {
    const p = this.world.player;
    if (!p?.player) return null;
    return {
      state: p.player,
      hp: p.hp,
      hpMax: p.hpMax,
      hpFraction: p.hpMax > 0 ? p.hp / p.hpMax : 1,
      classId: p.player.classId,
    };
  }

  private makeCtx(player: Entity): GameCtx {
    const depth = this.depth;
    return {
      world: this.world,
      map: this.level.map,
      player,
      target: player,
      flow: this.flow,
      fx,
      camera: this.camera,
      rng: this.combatRng,
      depth,
      hpMult: hpMult(depth) * this.modifier.hpMul * (this.ctx?.ruinActive ? 1.5 : 1),
      dmgMult: dmgMult(depth) * this.modifier.dmgMul,
      speedMult: speedMult(depth),
      timeMs: 0,
      biome: this.biome,
      esc: escalationFor(depth),
      hitstopRequest: 0,
      slowmoScale: 1,
      slowmoMs: 0,
      playerDied: false,
      ruinActive: false,
      aimWorldX: player.x + 1,
      aimWorldY: player.y,
      autoAttack: this.save.settings.autoAttack,
      lightMul: this.modifier.lightMul,
      wraithWarning: 0,
      collectPickup: (ctx, item) => this.collectPickup(ctx, item),
    };
  }

  // -------------------------------------------------------- level contents

  private spawnLevelContents(): void {
    for (const s of this.level.spawns) {
      const def = ENEMIES[s.enemyId];
      if (!def) continue;
      const e = spawnEnemyIn(this.ctx, def, s.x, s.y, {
        elite: s.elite,
        affix: s.affix === 'bounty' ? '' : s.affix,
        roomId: s.roomId,
        boss: s.boss === true,
      });
      if (s.affix === 'bounty') e.affix = 'bounty';
      if (s.boss) {
        e.hpMax = bossHp(def.stats.hp, this.depth);
        e.hp = e.hpMax;
      }
    }

    for (const l of this.level.loot) {
      switch (l.kind) {
        case 'relic':
          this.spawnPickup(l.x, l.y, PickupKind.Relic, l.id);
          break;
        case 'consumable':
          this.spawnPickup(l.x, l.y, PickupKind.Consumable, l.id);
          break;
        case 'heal':
          this.spawnPickup(l.x, l.y, PickupKind.Heal, '');
          break;
        case 'coin':
          this.spawnPickup(l.x, l.y, PickupKind.Coin, '');
          break;
        case 'pedestal':
          this.spawnInteractive(l.x, l.y, InteractKind.Pedestal, this.rollPedestalWeapon(), 0);
          break;
        case 'chest':
          this.spawnInteractive(l.x, l.y, InteractKind.Chest, '', 0, l.rarityBoost);
          break;
        case 'shrine':
          this.spawnInteractive(l.x, l.y, InteractKind.Shrine, l.id, 0);
          break;
        case 'shop':
          this.spawnInteractive(l.x, l.y, InteractKind.Shop, l.id, l.price, 0, l.offer);
          break;
        default:
          break;
      }
    }
  }

  private rollPedestalWeapon(): string {
    const rng = floorRng(this.runSeed, this.depth, Stream.Loot, 'pedestal');
    const current = this.world.player?.player?.weapon.id ?? null;
    const options = this.pools.weapons.filter((id) => id !== current);
    if (options.length === 0) return this.pools.weapons[0] ?? 'chipped_cleaver';
    const biased = options.filter((id) => this.biome.lootBias.weapons.includes(id));
    return biased.length > 0 && rng.chance(0.5) ? rng.pick(biased) : rng.pick(options);
  }

  spawnPickup(x: number, y: number, kind: number, id: string, value = 0): Entity {
    const e = this.world.spawn(EKind.Pickup, x, y, TEAM_PLAYER);
    e.flags = Flags.Pickupable;
    e.r = 7;
    e.payload = kind;
    e.tag = id;
    e.bx = value;
    e.light = kind === PickupKind.Soul ? 24 : kind === PickupKind.Relic ? 20 : 0;
    e.lightTint = kind === PickupKind.Soul ? Tint.Purple : Tint.Warm;
    // Motes expire so a floor cannot be left littered with a thousand pickups.
    if (kind === PickupKind.Soul || kind === PickupKind.Coin || kind === PickupKind.Heal) {
      e.life = 26000;
      e.hasLife = true;
    }
    return e;
  }

  private spawnInteractive(
    x: number,
    y: number,
    kind: number,
    id: string,
    price: number,
    rarityBoost = 0,
    offer?: 'relic' | 'weapon' | 'consumable',
  ): Entity {
    const e = this.world.spawn(EKind.Interactive, x, y, TEAM_PLAYER);
    e.r = 14;
    e.payload = kind;
    e.tag = id;
    e.bx = price;
    e.by = rarityBoost;
    e.ax = offer === 'weapon' ? 1 : offer === 'consumable' ? 2 : 0;
    e.light = 40;
    e.lightTint = kind === InteractKind.Shrine ? Tint.Cold : Tint.Warm;
    return e;
  }

  // ------------------------------------------------------------- the tick

  /** One fixed simulation step. Returns requested hitstop in ms. */
  step(): { hitstop: number; slowmoScale: number; slowmoMs: number } {
    const ctx = this.ctx;
    const dt = STEP_S;

    ctx.hitstopRequest = 0;
    ctx.slowmoMs = 0;
    ctx.map = this.level.map;
    ctx.timeMs = this.world.timeMs;
    ctx.target = this.world.aggroTarget();
    ctx.autoAttack = this.save.settings.autoAttack;
    if (ctx.wraithWarning > 0) ctx.wraithWarning -= dt * 1000;

    this.world.timeMs += dt * 1000;
    this.floorMs += dt * 1000;
    if (this.bannerMs > 0) this.bannerMs -= dt * 1000;
    if (this.toastMs > 0) this.toastMs -= dt * 1000;

    // A choice overlay is up: freeze the world but keep effects alive.
    if (this.pendingChoice) {
      return { hitstop: 0, slowmoScale: 1, slowmoMs: 0 };
    }

    updatePlayer(ctx, dt);
    updateVisitedRooms(ctx, this.level);

    // The flow field only rebuilds when the target's tile has actually moved a
    // couple of tiles, which is what makes per-enemy pathfinding unnecessary.
    if (this.flow.needsUpdate(ctx.target.x, ctx.target.y, 2)) {
      this.flow.compute(this.level.map, ctx.target.x, ctx.target.y);
    }

    updateEnemies(ctx, dt);
    updateProjectiles(ctx, dt);
    updateHazardEntities(ctx, dt);
    updateStatuses(ctx, dt);
    tileHazardPass(ctx, dt);
    contactDamagePass(ctx);
    updateTrickle(ctx, this.trickle, this.level, this.biome, this.trickleRng, dt);

    this.updateInteract();
    this.updateCameraFollow(dt);
    this.checkStairs();

    if (ctx.playerDied) this.dead = true;

    this.world.flush();
    return {
      hitstop: ctx.hitstopRequest,
      slowmoScale: ctx.slowmoScale,
      slowmoMs: ctx.slowmoMs,
    };
  }

  private updateCameraFollow(dt: number): void {
    const p = this.ctx.player;
    const ps = p.player;
    // The camera runs inside the fixed step, so its px/py interpolation works
    // identically to every entity's — and so it stays deterministic.
    updateCamera(
      this.camera,
      p.x,
      p.y,
      ps?.aimX ?? 1,
      ps?.aimY ?? 0,
      dt,
      this.level.map,
      viewW,
      viewH,
    );
  }

  private checkStairs(): void {
    // The stairs work the moment you find them. Every floor is therefore a
    // greed decision — descend intact, or sweep for the vault and the elite
    // drop — which lets the player author their own floor length.
    this.wantsDescend = onStairs(this.ctx);
  }

  // ---------------------------------------------------------- interaction

  private updateInteract(): void {
    const p = this.ctx.player;
    let best: Entity | null = null;
    let bestD2 = 44 * 44;

    for (const e of this.world.ents) {
      if (!e.alive || e.kind !== EKind.Interactive) continue;
      if (e.state === 1) continue;
      const dx = e.x - p.x;
      const dy = e.y - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = e;
      }
    }

    this.interactTarget = best ? { entity: best, prompt: this.promptFor(best) } : null;
  }

  private promptFor(e: Entity): string {
    switch (e.payload) {
      case InteractKind.Chest:
        return 'E  open the vault chest';
      case InteractKind.Shrine:
        return 'E  approach the shrine';
      case InteractKind.Shop: {
        const name = this.itemName(e.tag);
        const affordable = (this.ctx.player.player?.coins ?? 0) >= e.bx;
        return affordable
          ? `E  buy ${name} — ${e.bx} coin`
          : `${name} — ${e.bx} coin (not enough)`;
      }
      default: {
        const offered = WEAPON_REGISTRY[e.tag];
        const current = this.ctx.player.player?.weapon;
        if (!offered || !current) return 'E  take the weapon';
        const dps = (w: typeof offered): number =>
          (w.dmg * w.hits) / ((w.windup + w.active + w.recovery) / 1000);
        const delta = dps(offered) - dps(current);
        const sign = delta >= 0 ? '+' : '';
        return `E  swap to ${offered.name} (${sign}${delta.toFixed(1)} dps, ${offered.reach}px reach)`;
      }
    }
  }

  private itemName(id: string): string {
    return (
      RELIC_REGISTRY[id]?.name ??
      WEAPON_REGISTRY[id]?.name ??
      CONSUMABLE_REGISTRY[id]?.name ??
      id
    );
  }

  /** Called by the scene when the interact key is pressed. */
  interact(): void {
    const target = this.interactTarget;
    if (!target) return;
    const e = target.entity;
    const p = this.ctx.player.player;
    if (!p) return;

    switch (e.payload) {
      case InteractKind.Chest: {
        const rng = floorRng(this.runSeed, this.depth, Stream.Loot, `chest${e.id}`);
        const rarity = rollRarity(rng, this.depth, e.by);
        const id = pickRelic(rng, this.pools, rarity, this.biome.lootBias.relics);
        if (id) {
          this.spawnPickup(e.x, e.y - 18, PickupKind.Relic, id);
          fx.burst(e.x, e.y, {
            color: '#ffd24a',
            count: 26,
            speed: [60, 220],
            size: [1.8, 3.6],
            life: [320, 700],
            additive: true,
            gravity: -40,
          });
          fx.transientLight(e.x, e.y, 200, 420, Tint.Warm);
        }
        e.state = 1;
        break;
      }

      case InteractKind.Shrine: {
        // Two offered, pick one. The choice is what makes a shrine a decision
        // rather than a slot machine.
        const rng = floorRng(this.runSeed, this.depth, Stream.Shrine, `s${e.id}`);
        const usable = SHRINES.filter(
          (s) => s.available === undefined || s.available(this.shrines, this.depth),
        );
        const forced = e.tag ? SHRINES.find((s) => s.id === e.tag) : undefined;
        const pool = rng.shuffle([...usable]);
        const options: string[] = [];
        if (forced) options.push(forced.id);
        for (const s of pool) {
          if (options.length >= 2) break;
          if (!options.includes(s.id)) options.push(s.id);
        }
        if (options.length === 0) {
          e.state = 1;
          break;
        }
        this.pendingChoice = { kind: 'shrine', options, sourceId: e.id };
        break;
      }

      case InteractKind.Shop: {
        if (p.coins < e.bx) {
          this.showToast('Not enough coin', '#ff8080');
          return;
        }
        if (!this.giveOffer(e)) return;
        p.coins -= e.bx;
        e.state = 1;
        fx.burst(e.x, e.y, {
          color: '#7ef2a1',
          count: 14,
          speed: [40, 150],
          size: [1.4, 3],
          life: [220, 460],
          additive: true,
        });
        break;
      }

      default: {
        const offered = WEAPON_REGISTRY[e.tag];
        if (!offered) return;
        const old = p.weapon.id;
        p.weapon = offered;
        // The old weapon lands back on the pedestal, so a swap is reversible
        // and trying something out never costs you your build.
        e.tag = old;
        this.showToast(offered.name, offered.color);
        fx.transientLight(e.x, e.y, 150, 260, Tint.White);
        break;
      }
    }
  }

  private giveOffer(e: Entity): boolean {
    const kind = e.ax;
    if (kind === 1) {
      const w = WEAPON_REGISTRY[e.tag];
      const p = this.ctx.player.player;
      if (!w || !p) return false;
      p.weapon = w;
      this.showToast(w.name, w.color);
      return true;
    }
    if (kind === 2) {
      if (!giveConsumable(this.ctx.player, e.tag)) {
        this.showToast('Both pockets are full', '#ff8080');
        return false;
      }
      this.showToast(CONSUMABLE_REGISTRY[e.tag]?.name ?? e.tag, '#ffd24a');
      return true;
    }
    if (!grantRelic(this.ctx, e.tag)) return false;
    const def = RELIC_REGISTRY[e.tag];
    this.showToast(def?.name ?? e.tag, def ? RARITY_COLOR[def.rarity] : '#ffffff');
    return true;
  }

  /** Resolve whichever overlay was up. */
  resolveChoice(optionId: string): void {
    const choice = this.pendingChoice;
    if (!choice) return;
    this.pendingChoice = null;

    if (choice.kind === 'shrine') {
      const def: ShrineDef | undefined = SHRINES.find((s) => s.id === optionId);
      const source = this.world.ents.find((e) => e.id === choice.sourceId);
      if (source) source.state = 1;
      if (!def) return;
      if (!def.activate(this.ctx.player, this.ctx)) return;
      def.onUse?.(this.shrines, this.depth);
      this.shrines.used.push(def.id);
      recomputeStats(this.ctx.player);
      this.showToast(def.name, def.color);
      if (this.ctx.ruinActive) this.applyRuin();
      fx.transientLight(this.ctx.player.x, this.ctx.player.y, 240, 460, Tint.Cold);
    }
  }

  /** Shrine of Ruin: buff the floor's live enemies and drop two extra items. */
  private applyRuin(): void {
    for (const e of this.world.ents) {
      if (!e.alive || e.kind !== EKind.Enemy) continue;
      e.hpMax = Math.round(e.hpMax * 1.5);
      e.hp = Math.round(e.hp * 1.5);
    }
    const rng = floorRng(this.runSeed, this.depth, Stream.Loot, 'ruin');
    for (let i = 0; i < 2; i++) {
      const id = pickRelic(rng, this.pools, rollRarity(rng, this.depth, 0), this.biome.lootBias.relics);
      if (!id) break;
      const a = rng.float(0, Math.PI * 2);
      this.spawnPickup(
        this.ctx.player.x + Math.cos(a) * 40,
        this.ctx.player.y + Math.sin(a) * 40,
        PickupKind.Relic,
        id,
      );
    }
  }

  // ------------------------------------------------------------- rewards

  private onEnemyKilled(ctx: GameCtx, e: Entity): void {
    const p = ctx.player.player;
    if (!p) return;
    const def = e.def;
    if (!def) return;

    const isElite = (e.flags & Flags.Elite) !== 0;
    const isBoss = (e.flags & Flags.Boss) !== 0;
    const trickle = (e.flags & Flags.Trickle) !== 0;
    const isBounty = e.affix === 'bounty';

    p.kills++;
    this.summary.kills++;
    if (isElite) {
      p.elitesKilled++;
      this.summary.elitesKilled++;
    }
    if (isBoss) {
      p.bossesKilled++;
      this.summary.bossesKilled++;
      this.save.bossKills++;
    }

    // Trickle spawns give 40% experience and no loot roll: pressure, not a farm.
    const xpScale = trickle ? 0.4 : 1;
    grantXp(ctx, (def.stats.xp + xpPerKill(this.depth) * 0.1) * xpScale);

    const rng = ctx.rng;
    const souls = soulValue(def.stats.souls, isElite, trickle) * (isBounty ? 3 : 1);
    for (let i = 0; i < Math.min(6, souls); i++) {
      const a = rng.float(0, Math.PI * 2);
      const mote = this.spawnPickup(
        e.x + Math.cos(a) * 8,
        e.y + Math.sin(a) * 8,
        PickupKind.Soul,
        '',
        Math.max(1, Math.round(souls / Math.min(6, souls))),
      );
      mote.vx = Math.cos(a) * 90;
      mote.vy = Math.sin(a) * 90;
    }

    if (!trickle) {
      const coins = rng.int(def.stats.coins[0], def.stats.coins[1]);
      for (let i = 0; i < coins; i++) {
        const a = rng.float(0, Math.PI * 2);
        const coin = this.spawnPickup(e.x, e.y, PickupKind.Coin, '', 1);
        coin.vx = Math.cos(a) * 110;
        coin.vy = Math.sin(a) * 110;
      }
    }

    // Corpse Bloom style heal motes.
    if (p.stats.healMoteChance > 0 && rng.chance(p.stats.healMoteChance)) {
      this.spawnPickup(e.x, e.y, PickupKind.Heal, '', 3);
    }

    // Elites and bosses always drop a relic. That guarantee is what makes a
    // detour to the elite room worth taking every single floor.
    if ((isElite || isBoss) && !trickle) {
      const lootRng = floorRng(this.runSeed, this.depth, Stream.Loot, `elite${e.id}`);
      const rarity = rollRarity(lootRng, this.depth, isBoss ? 2 : lootRng.chance(0.2) ? 1 : 0);
      const id = pickRelic(lootRng, this.pools, rarity, this.biome.lootBias.relics);
      if (id) this.spawnPickup(e.x, e.y - 10, PickupKind.Relic, id);
    }

    if (isBounty) {
      fx.flash('#ffd24a', 0.22, 5);
      this.showToast('Bounty claimed', '#ffd24a');
    }

    classById(p.classId).onKill?.(ctx.player, ctx);
    if (p.stats.killRefreshesDodge) p.dashCd = 0;

    if (p.stats.decoyChance > 0 && rng.chance(p.stats.decoyChance)) {
      this.spawnDecoy(e.x, e.y);
    }
  }

  private spawnDecoy(x: number, y: number): void {
    const d = this.world.spawn(EKind.Decoy, x, y, TEAM_PLAYER);
    d.r = 11;
    d.life = 3000;
    d.hasLife = true;
    d.light = 60;
    d.lightTint = Tint.Purple;
  }

  private collectPickup(ctx: GameCtx, item: Entity): void {
    const p = ctx.player.player;
    if (!p) return;

    switch (item.payload) {
      case PickupKind.Relic: {
        const def = RELIC_REGISTRY[item.tag];
        if (!def) break;
        grantRelic(ctx, item.tag);
        this.showToast(def.name, RARITY_COLOR[def.rarity]);
        fx.burst(item.x, item.y, {
          color: RARITY_COLOR[def.rarity],
          count: 14,
          speed: [40, 160],
          size: [1.4, 3],
          life: [260, 520],
          additive: true,
        });
        if (def.rarity >= 2) addTrauma(this.camera, 0.1);
        break;
      }
      case PickupKind.Consumable: {
        if (!giveConsumable(ctx.player, item.tag)) {
          // Refuse rather than destroy it: leave it on the floor to come back to.
          return;
        }
        this.showToast(CONSUMABLE_REGISTRY[item.tag]?.name ?? item.tag, '#ffd24a');
        break;
      }
      case PickupKind.Coin:
        p.coins += Math.max(1, Math.round(item.bx * p.stats.coinMul));
        break;
      case PickupKind.Heal:
        ctx.player.hp = Math.min(ctx.player.hpMax, ctx.player.hp + Math.max(1, item.bx));
        break;
      default:
        p.soulsPending += Math.max(1, Math.round(item.bx * p.stats.soulMul));
        fx.particle(item.x, item.y, 0, -40, '#e0c4ff', 2.4, 300, PKind.Dot, true, 0.3);
        break;
    }

    this.world.kill(item);
  }

  showToast(text: string, color: string): void {
    this.toast = text;
    this.toastColor = color;
    this.toastMs = 1600;
  }

  // --------------------------------------------------------------- souls

  /** Move pending souls into the save. Called on descent and on death. */
  bankSouls(): void {
    const p = this.world.player?.player;
    if (!p) return;
    if (p.soulsPending <= 0) return;
    this.save.souls += p.soulsPending;
    this.save.soulsLifetime += p.soulsPending;
    p.soulsBanked += p.soulsPending;
    p.soulsPending = 0;
    saveNow();
  }

  /** End-of-run bookkeeping. Returns the souls awarded for the run itself. */
  finishRun(): number {
    this.bankSouls();
    const before = this.save.bestDepth;
    const award = soulsEarned(this.summary, before);
    this.save.souls += award;
    this.save.soulsLifetime += award;
    this.save.deaths++;
    this.save.bestDepth = Math.max(before, this.summary.deepestFloor);
    saveNow();
    return award;
  }

  // ------------------------------------------------------------- helpers

  /** Open the exit doors of a cleared vault, if any remain sealed. */
  openClearedDoors(): void {
    const map = this.level.map;
    for (let i = 0; i < map.t.length; i++) {
      if (map.t[i] === Tile.DoorSealed) map.t[i] = Tile.DoorOpen;
    }
  }

  get clearFraction(): number {
    return this.world.clearFraction();
  }

  playerTileRoom(): number {
    const tx = Math.floor(this.ctx.player.x / TILE);
    const ty = Math.floor(this.ctx.player.y / TILE);
    if (tx < 0 || ty < 0 || tx >= this.level.map.w || ty >= this.level.map.h) return -1;
    return this.level.roomAt[ty * this.level.map.w + tx];
  }
}

/**
 * Visible world size, pushed in by the renderer on resize.
 *
 * The camera needs it to clamp to level bounds, but the run has no business
 * knowing about canvas dimensions, so it arrives through this seam.
 */
let viewW = 640;
let viewH = 360;

export function setCameraViewSize(w: number, h: number): void {
  viewW = w;
  viewH = h;
}
