import { audio } from '../core/audio';
import { Action, Input } from '../core/input';
import { STEP, STEP_S } from '../core/constants';
import { clamp01 } from '../core/math';
import { getSave, markDirty, saveNow, type SaveData } from '../core/storage';
import { CLASSES } from '../content/classes';
import { PERK_BY_ID } from '../content/perks';
import { SHRINE_BY_ID } from '../content/shrines';
import { RELIC_REGISTRY } from '../content';
import { UNLOCKS, unlockAvailable, unlockById } from '../content/unlocks';
import { RARITY_COLOR } from '../content/types/item';
import type { Game, Scene } from '../game';
import { fx, PKind } from '../render/fx';
import { circle } from '../render/glyphs';
import { drawBountyMarker, drawHud, type HudInfo } from '../render/hud';
import { drawMinimap } from '../render/minimap';
import { drawDebugShapes, drawDevOverlay, renderWorld } from '../render/scene';
import { offerPerks, takePerk } from '../systems/progression';
import { soulsEarned } from '../systems/scaling';
import { RunState, setCameraViewSize } from '../run/runState';
import {
  MenuList,
  TextField,
  type MenuItem,
  UI_FONT,
  UI_FONT_HEAD,
  UI_FONT_SMALL,
  UI_FONT_TITLE,
  dimScreen,
  endPanel,
  hint,
  panel,
} from './menu';

/**
 * Scenes.
 *
 * A pause menu suppresses stepping below it but lets rendering through, so the
 * frozen game stays visible underneath. That is the whole reason `Scene` has
 * two separate passthrough flags.
 */

// -------------------------------------------------------------------- title

export class TitleScene implements Scene {
  passthroughStep = false;
  passthroughRender = false;

  private menu = new MenuList([]);
  private seedField = new TextField(8);
  private t = 0;
  private save: SaveData = getSave();

  onEnter(g: Game): void {
    this.save = getSave();
    audio.applyVolumes(
      this.save.settings.master,
      this.save.settings.sfx,
      this.save.settings.music,
    );
    this.refresh();
    void g;
  }

  onExit(): void {
    this.seedField.blur();
  }

  private refresh(): void {
    const unlockedClasses = CLASSES.filter(
      (c) => c.unlockCost === 0 || this.save.unlocks.includes(`class_${c.id}`),
    );
    this.menu.setItems([
      {
        id: 'descend',
        label: 'Descend',
        detail:
          unlockedClasses.length > 1
            ? 'Choose a class and begin a run'
            : 'Begin a run as the Wanderer',
      },
      {
        id: 'sanctum',
        label: 'Sanctum',
        detail: 'Spend souls on permanent unlocks',
        value: `${this.save.souls} souls`,
      },
      { id: 'settings', label: 'Settings', detail: 'Audio, screen shake, accessibility' },
      { id: 'help', label: 'How to play', detail: 'Controls and the basics' },
    ]);
  }

  step(g: Game): void {
    this.t += STEP;

    // Clicking the seed field focuses it; anything else blurs it.
    if (Input.pressed(Action.Interact)) {
      if (this.seedField.focused) this.seedField.blur();
      else this.seedField.focus();
    }

    if (this.seedField.focused) {
      if (Input.pressed(Action.Cancel) || Input.pressed(Action.Pause)) this.seedField.blur();
      return;
    }

    const chosen = this.menu.step(g.renderer);
    if (!chosen) return;

    switch (chosen) {
      case 'descend': {
        const unlocked = CLASSES.filter(
          (c) => c.unlockCost === 0 || this.save.unlocks.includes(`class_${c.id}`),
        );
        if (unlocked.length > 1) g.push(new ClassSelectScene(this.seedField.value));
        else startRun(g, 'wanderer', this.seedField.value);
        break;
      }
      case 'sanctum':
        g.push(new SanctumScene());
        break;
      case 'settings':
        g.push(new SettingsScene());
        break;
      default:
        g.push(new HelpScene());
    }
  }

  render(g: Game): void {
    const r = g.renderer;
    const c = r.ctx;
    r.clear('#07070b');
    r.beginScreen();

    const scale = Math.max(1, Math.min(2, r.dpr));
    c.save();
    c.scale(scale, scale);
    const vw = r.canvas.width / scale;
    const vh = r.canvas.height / scale;

    drawTitleBackdrop(c, vw, vh, this.t);

    r.text('DEPTHS', vw / 2, vh * 0.2, UI_FONT_TITLE, '#d8cfae', 'center');
    r.text(
      'an endless descent',
      vw / 2,
      vh * 0.2 + 26,
      UI_FONT_SMALL,
      '#8f97a3',
      'center',
    );

    const w = Math.min(420, vw - 60);
    const x = (vw - w) / 2;
    const y = vh * 0.32;
    this.menu.draw(r, x, y, w, 44);

    // Seed entry sits below the menu, optional and clearly secondary.
    const seedY = y + this.menu.items.length * 50 + 12;
    r.text('Seed', x, seedY + 15, UI_FONT_SMALL, '#8f97a3', 'left', 'middle');
    this.seedField.draw(r, x + 44, seedY, w - 44, 30, 'random', this.t);
    hint(r, this.seedField.focused ? 'typing seed — E to finish' : 'E to enter a seed', seedY + 52);

    if (this.save.bestDepth > 0) {
      r.text(
        `best depth ${this.save.bestDepth}   ·   ${this.save.runs} runs`,
        vw / 2,
        vh - 24,
        UI_FONT_SMALL,
        '#5a5466',
        'center',
      );
    }

    c.restore();
  }
}

/** Slow drifting motes, so the title screen is not a static image. */
function drawTitleBackdrop(
  c: CanvasRenderingContext2D,
  vw: number,
  vh: number,
  t: number,
): void {
  for (let i = 0; i < 40; i++) {
    const seed = i * 977;
    const x = ((seed % 1000) / 1000) * vw;
    const speed = 6 + (seed % 17);
    const y = (((t * 0.001 * speed + (seed % 733)) % (vh + 40)) - 20);
    c.globalAlpha = 0.1 + ((seed % 7) / 7) * 0.12;
    c.fillStyle = '#d8cfae';
    circle(c, x, y, 1 + (seed % 3) * 0.5);
  }
  c.globalAlpha = 1;
}

// ------------------------------------------------------------ class select

export class ClassSelectScene implements Scene {
  passthroughStep = false;
  passthroughRender = false;

  private menu = new MenuList([]);
  private save = getSave();

  constructor(private seed: string) {}

  onEnter(): void {
    this.save = getSave();
    this.menu.setItems(
      CLASSES.filter(
        (c) => c.unlockCost === 0 || this.save.unlocks.includes(`class_${c.id}`),
      ).map((c) => ({
        id: c.id,
        label: c.name,
        detail: `${c.passive.name} — ${c.passive.desc}`,
        value: `${c.hp} hp`,
        color: c.visual.accent,
      })),
    );
  }

  step(g: Game): void {
    if (Input.pressed(Action.Pause) || Input.pressed(Action.Cancel)) {
      g.pop();
      return;
    }
    const chosen = this.menu.step(g.renderer);
    if (chosen) startRun(g, chosen, this.seed);
  }

  render(g: Game): void {
    const r = g.renderer;
    r.clear('#07070b');
    const box = panel(r, Math.min(520, r.canvas.width / r.dpr - 40), 320, 'Choose a class', 'every class is a different game, not a stronger one');
    this.menu.draw(r, box.x, box.y, box.w, 56);
    hint(r, 'Esc to go back', box.y + this.menu.items.length * 62 + 24);
    endPanel(r);
  }
}

function startRun(g: Game, classId: string, seedInput: string): void {
  const run = new RunState();
  setCameraViewSize(g.renderer.viewW, g.renderer.viewH);
  run.start(classId, seedInput);
  audio.setBiome(run.biome.audio);
  g.replace(new PlayScene(run));
}

// ------------------------------------------------------------------ sanctum

export class SanctumScene implements Scene {
  passthroughStep = false;
  passthroughRender = false;

  private menu = new MenuList([]);
  private save = getSave();
  private message = '';
  private messageMs = 0;

  onEnter(): void {
    this.save = getSave();
    this.refresh();
  }

  private refresh(): void {
    const items: MenuItem[] = [];

    for (const u of UNLOCKS) {
      if (!unlockAvailable(u, this.save.soulsSpent)) continue;
      const owned = this.save.unlocks.includes(u.id);
      items.push({
        id: u.id,
        label: u.name,
        detail: u.desc,
        value: owned ? 'owned' : `${u.cost}`,
        disabled: owned || this.save.souls < u.cost,
        color: owned ? '#7ef2a1' : undefined,
      });
    }

    // Gated tiers are shown greyed out rather than hidden: knowing what is
    // coming is most of what makes an unlock tree feel like progress.
    for (const u of UNLOCKS) {
      if (unlockAvailable(u, this.save.soulsSpent)) continue;
      items.push({
        id: `locked_${u.id}`,
        label: u.name,
        detail: `Spend ${u.requiresSpent} souls in total to reach this`,
        value: `${u.cost}`,
        disabled: true,
      });
    }

    items.push({ id: 'back', label: 'Back' });
    this.menu.setItems(items);
  }

  step(g: Game): void {
    if (this.messageMs > 0) this.messageMs -= STEP;
    if (Input.pressed(Action.Pause) || Input.pressed(Action.Cancel)) {
      g.pop();
      return;
    }

    const chosen = this.menu.step(g.renderer);
    if (!chosen) return;
    if (chosen === 'back') {
      g.pop();
      return;
    }
    if (chosen.startsWith('locked_')) return;

    const u = unlockById(chosen);
    if (!u || this.save.unlocks.includes(u.id) || this.save.souls < u.cost) return;

    this.save.souls -= u.cost;
    this.save.soulsSpent += u.cost;
    this.save.unlocks.push(u.id);
    saveNow();
    audio.pickup(2);
    this.message = `${u.name} unlocked`;
    this.messageMs = 2200;
    this.refresh();
  }

  render(g: Game): void {
    const r = g.renderer;
    r.clear('#07070b');
    const vw = r.canvas.width / Math.max(1, Math.min(2, r.dpr));
    const box = panel(
      r,
      Math.min(560, vw - 40),
      Math.min(520, r.canvas.height / Math.max(1, Math.min(2, r.dpr)) - 40),
      'Sanctum',
      `${this.save.souls} souls · every unlock adds variety, never power`,
    );
    this.menu.draw(r, box.x, box.y, box.w, 46);
    if (this.messageMs > 0) {
      r.text(
        this.message,
        box.x + box.w / 2,
        box.y + this.menu.items.length * 52 + 18,
        UI_FONT_SMALL,
        '#7ef2a1',
        'center',
      );
    }
    endPanel(r);
  }
}

// ----------------------------------------------------------------- settings

export class SettingsScene implements Scene {
  passthroughStep = false;
  passthroughRender = true;

  private menu = new MenuList([]);
  private save = getSave();

  onEnter(): void {
    this.save = getSave();
    this.refresh();
  }

  private refresh(): void {
    const s = this.save.settings;
    const pct = (v: number): string => `${Math.round(v * 100)}%`;
    this.menu.setItems([
      { id: 'master', label: 'Master volume', value: pct(s.master) },
      { id: 'music', label: 'Music', value: pct(s.music) },
      { id: 'sfx', label: 'Sound effects', value: pct(s.sfx) },
      {
        id: 'shake',
        label: 'Screen shake',
        detail: 'Set to 0 if motion bothers you',
        value: pct(s.shake),
      },
      {
        id: 'flashes',
        label: 'Full-screen flashes',
        detail: 'Turn off for photosensitivity',
        value: s.flashes ? 'on' : 'off',
      },
      { id: 'damageNumbers', label: 'Damage numbers', value: s.damageNumbers ? 'on' : 'off' },
      {
        id: 'autoAttack',
        label: 'Hold to attack',
        detail: 'Attack continuously while the key is held',
        value: s.autoAttack ? 'on' : 'off',
      },
      { id: 'back', label: 'Back' },
    ]);
  }

  step(g: Game): void {
    if (Input.pressed(Action.Pause) || Input.pressed(Action.Cancel)) {
      g.pop();
      return;
    }

    // Left/right adjust the highlighted setting rather than moving selection.
    const item = this.menu.items[this.menu.index];
    const delta = Input.pressed(Action.Right) ? 1 : Input.pressed(Action.Left) ? -1 : 0;
    if (delta !== 0 && item && item.id !== 'back') {
      this.adjust(item.id, delta);
      this.refresh();
      audio.ui(delta > 0);
      return;
    }

    if (Input.pressed(Action.Up)) this.menu.index = Math.max(0, this.menu.index - 1);
    if (Input.pressed(Action.Down)) {
      this.menu.index = Math.min(this.menu.items.length - 1, this.menu.index + 1);
    }

    if (Input.menuConfirm()) {
      const current = this.menu.items[this.menu.index];
      if (!current) return;
      if (current.id === 'back') {
        g.pop();
        return;
      }
      this.adjust(current.id, 1);
      this.refresh();
    }
  }

  private adjust(id: string, delta: number): void {
    const s = this.save.settings;
    const bump = (v: number): number => Math.max(0, Math.min(1, Math.round((v + delta * 0.1) * 10) / 10));
    switch (id) {
      case 'master':
        s.master = bump(s.master);
        break;
      case 'music':
        s.music = bump(s.music);
        break;
      case 'sfx':
        s.sfx = bump(s.sfx);
        break;
      case 'shake':
        s.shake = bump(s.shake);
        break;
      case 'flashes':
        s.flashes = !s.flashes;
        fx.allowFlashes = s.flashes;
        break;
      case 'damageNumbers':
        s.damageNumbers = !s.damageNumbers;
        fx.allowDamageNumbers = s.damageNumbers;
        break;
      case 'autoAttack':
        s.autoAttack = !s.autoAttack;
        break;
      default:
        break;
    }
    audio.applyVolumes(s.master, s.sfx, s.music);
    markDirty();
  }

  render(g: Game): void {
    const r = g.renderer;
    dimScreen(r, 0.75);
    const scale = Math.max(1, Math.min(2, r.dpr));
    const box = panel(
      r,
      Math.min(500, r.canvas.width / scale - 40),
      Math.min(520, r.canvas.height / scale - 40),
      'Settings',
      'left and right to adjust',
    );
    this.menu.draw(r, box.x, box.y, box.w, 44);
    endPanel(r);
  }
}

// --------------------------------------------------------------------- help

export class HelpScene implements Scene {
  passthroughStep = false;
  passthroughRender = true;

  step(g: Game): void {
    if (Input.menuConfirm() || Input.pressed(Action.Pause) || Input.pressed(Action.Cancel)) {
      const save = getSave();
      if (!save.seenIntro) {
        save.seenIntro = true;
        markDirty();
      }
      g.pop();
    }
  }

  render(g: Game): void {
    const r = g.renderer;
    dimScreen(r, 0.8);
    const scale = Math.max(1, Math.min(2, r.dpr));
    const box = panel(
      r,
      Math.min(520, r.canvas.width / scale - 40),
      430,
      'How to play',
      'the stairs work the moment you find them',
    );

    const rows: Array<[string, string]> = [
      ['WASD / arrows', 'move'],
      ['mouse or aim direction', 'aim'],
      ['click / space', 'attack'],
      ['shift', 'dash — invulnerable while dashing'],
      ['E', 'interact, and descend on the stairs'],
      ['Q / F', 'use a consumable'],
      ['Enter', 'choose a perk when you level up'],
      ['Tab', 'toggle the map'],
      ['Esc', 'pause'],
      ['`', 'developer overlay'],
    ];

    rows.forEach(([key, what], i) => {
      const y = box.y + i * 24 + 8;
      r.text(key, box.x + 8, y, UI_FONT_SMALL, '#a8e6ff', 'left');
      r.text(what, box.x + 170, y, UI_FONT_SMALL, '#b9b3a6', 'left');
    });

    const tipY = box.y + rows.length * 24 + 26;
    r.text('Souls bank when you descend, not when you die.', box.x + 8, tipY, UI_FONT_SMALL, '#e0c4ff', 'left');
    r.text('Damage over time ignores shields and armour.', box.x + 8, tipY + 18, UI_FONT_SMALL, '#ff9a3a', 'left');
    r.text('Hazards hurt enemies too. Knock them in.', box.x + 8, tipY + 36, UI_FONT_SMALL, '#a8f06e', 'left');

    hint(r, 'press Enter to continue', tipY + 70);
    endPanel(r);
  }
}

// --------------------------------------------------------------------- play

export class PlayScene implements Scene {
  passthroughStep = true;
  passthroughRender = false;

  private deathT = 0;
  private deathStarted = false;
  private mapVisible = true;
  private legendMs = 4000;
  private lastHp = 0;

  constructor(public run: RunState) {}

  onEnter(g: Game): void {
    setCameraViewSize(g.renderer.viewW, g.renderer.viewH);
    this.lastHp = this.run.ctx.player.hp;
    const save = getSave();
    if (!save.seenIntro) g.push(new HelpScene());
  }

  step(g: Game): void {
    const run = this.run;

    if (Input.pressed(Action.Debug)) g.showDebug = !g.showDebug;
    if (Input.pressed(Action.Map)) this.mapVisible = !this.mapVisible;
    if (this.legendMs > 0) this.legendMs -= STEP;

    if (Input.pressed(Action.Pause) && !this.deathStarted) {
      g.push(new PauseScene());
      return;
    }

    // Death sequence: slow motion, then the summary. Reading the moment you
    // died matters more than getting to the menu quickly.
    if (this.deathStarted) {
      this.deathT -= STEP;
      if (this.deathT <= 0) {
        const award = run.finishRun();
        g.replace(new GameOverScene(run, award));
      }
      return;
    }

    // A pending overlay: hand off and let it resolve.
    if (run.pendingChoice) {
      g.push(new ChoiceScene(run));
      return;
    }

    const player = run.ctx.player.player;
    if (player && player.pendingPerks > 0 && Input.pressed(Action.Confirm)) {
      const options = offerPerks(run.combatRng, run.ctx.player).map((p) => p.id);
      if (options.length > 0) {
        run.pendingChoice = { kind: 'perk', options, sourceId: -1 };
        g.push(new ChoiceScene(run));
        return;
      }
    }

    // Aim in world space, recomputed each tick from the stored screen position.
    run.ctx.aimWorldX = g.renderer.screenToWorldX(Input.mouseSX);
    run.ctx.aimWorldY = g.renderer.screenToWorldY(Input.mouseSY);

    if (Input.pressed(Action.Interact)) {
      if (run.wantsDescend) {
        g.push(new DescendScene(run));
        return;
      }
      run.interact();
    }

    spawnAmbient(run);

    const result = run.step();
    if (result.hitstop > 0) g.addHitstop(result.hitstop);
    if (result.slowmoMs > 0) g.setTimescale(result.slowmoScale, result.slowmoMs);

    // Sound, driven off state changes rather than from inside the sim.
    const hp = run.ctx.player.hp;
    if (hp < this.lastHp - 0.5) audio.hurt();
    this.lastHp = hp;
    audio.update(STEP_S);

    if (run.dead && !this.deathStarted) {
      this.deathStarted = true;
      this.deathT = 900;
      g.setTimescale(0.2, 900);
      audio.death();
      fx.flash('#3a0810', 0.5, 1.2);
    }
  }

  render(g: Game, alpha: number): void {
    const run = this.run;
    renderWorld(g, run, alpha);

    const info: HudInfo = {
      depth: run.depth,
      clearFraction: run.clearFraction,
      floorMs: run.floorMs,
      modifier: run.modifier.id === 'none' ? null : run.modifier,
      bannerMs: run.bannerMs,
      prompt: run.wantsDescend
        ? `E  descend to depth ${run.depth + 1}`
        : (run.interactTarget?.prompt ?? null),
      seedText: run.seedText,
      showMinimapHint: this.legendMs > 0,
    };

    drawHud(g.renderer, run.ctx, info);
    drawMinimap(g.renderer, run.ctx, run.level, !this.mapVisible || run.modifier.hideMinimap);
    drawBountyMarker(g.renderer, run.ctx);
    drawToast(g, run);

    if (g.showDebug) {
      drawDebugShapes(g, run, alpha);
      drawDevOverlay(g, run);
    }
  }
}

function drawToast(g: Game, run: RunState): void {
  if (run.toastMs <= 0) return;
  const r = g.renderer;
  const c = r.ctx;
  r.beginScreen();
  const scale = Math.max(1, Math.min(2, r.dpr));
  c.save();
  c.scale(scale, scale);
  const vw = r.canvas.width / scale;
  const vh = r.canvas.height / scale;
  const alpha = clamp01(run.toastMs / 400);
  c.globalAlpha = alpha;
  r.text(run.toast, vw / 2, vh * 0.62, UI_FONT_HEAD, run.toastColor, 'center');
  c.globalAlpha = 1;
  c.restore();
}

/** Biome ambience: drifting motes, spores, embers. Cosmetic, so `Math.random`. */
function spawnAmbient(run: RunState): void {
  const a = run.biome.ambient;
  const want = Math.round(a.count * fx.budget);
  // Emit a small slice each tick rather than topping up to a target count,
  // which keeps the cost flat and the density stable.
  const perTick = Math.max(1, Math.round(want / 60));
  const r = run.ctx;
  for (let i = 0; i < perTick; i++) {
    const x = r.player.x + (Math.random() - 0.5) * 900;
    const y = r.player.y + (Math.random() - 0.5) * 620;
    fx.particle(
      x,
      y,
      a.driftX[0] + Math.random() * (a.driftX[1] - a.driftX[0]),
      a.driftY[0] + Math.random() * (a.driftY[1] - a.driftY[0]),
      a.color,
      a.size[0] + Math.random() * (a.size[1] - a.size[0]),
      a.life[0] + Math.random() * (a.life[1] - a.life[0]),
      PKind.Dot,
      a.additive,
      0.7,
    );
  }
}

// -------------------------------------------------------------------- pause

export class PauseScene implements Scene {
  passthroughStep = false;
  passthroughRender = true;

  private menu = new MenuList([
    { id: 'resume', label: 'Resume' },
    { id: 'settings', label: 'Settings' },
    { id: 'help', label: 'How to play' },
    { id: 'abandon', label: 'Abandon run', detail: 'Banked souls are kept', color: '#ff8080' },
  ]);

  onEnter(g: Game): void {
    g.pause();
  }

  onExit(g: Game): void {
    g.resume();
  }

  step(g: Game): void {
    if (Input.pressed(Action.Pause) || Input.pressed(Action.Cancel)) {
      g.pop();
      return;
    }
    const chosen = this.menu.step(g.renderer);
    if (!chosen) return;

    switch (chosen) {
      case 'resume':
        g.pop();
        break;
      case 'settings':
        g.push(new SettingsScene());
        break;
      case 'help':
        g.push(new HelpScene());
        break;
      default: {
        // Abandoning still banks and still awards for the depth reached: the
        // player has to be able to stop playing without being punished for it.
        const play = g.scenes.find((s) => s instanceof PlayScene) as PlayScene | undefined;
        if (play) {
          const award = play.run.finishRun();
          g.replace(new GameOverScene(play.run, award));
        } else {
          g.replace(new TitleScene());
        }
        break;
      }
    }
  }

  render(g: Game): void {
    const r = g.renderer;
    dimScreen(r, 0.7);
    const scale = Math.max(1, Math.min(2, r.dpr));
    const box = panel(r, Math.min(380, r.canvas.width / scale - 40), 300, 'Paused');
    this.menu.draw(r, box.x, box.y, box.w, 42);
    endPanel(r);
  }
}

// ------------------------------------------------------------------- choice

/** Perk and shrine overlays: the two places the game stops for a decision. */
export class ChoiceScene implements Scene {
  passthroughStep = false;
  passthroughRender = true;

  private menu = new MenuList([]);

  constructor(private run: RunState) {}

  onEnter(): void {
    const choice = this.run.pendingChoice;
    if (!choice) return;

    if (choice.kind === 'perk') {
      this.menu.setItems(
        choice.options.map((id) => {
          const p = PERK_BY_ID.get(id);
          return {
            id,
            label: p?.name ?? id,
            detail: p?.desc ?? '',
            color: p?.color,
          };
        }),
      );
    } else {
      this.menu.setItems(
        choice.options.map((id) => {
          const s = SHRINE_BY_ID.get(id);
          return {
            id,
            label: s?.name ?? id,
            detail: s?.desc ?? '',
            color: s?.color,
          };
        }),
      );
    }
  }

  step(g: Game): void {
    const choice = this.run.pendingChoice;
    if (!choice) {
      g.pop();
      return;
    }

    // A shrine can be walked away from; a perk cannot, because it is owed.
    if (choice.kind === 'shrine' && (Input.pressed(Action.Cancel) || Input.pressed(Action.Pause))) {
      this.run.pendingChoice = null;
      g.pop();
      return;
    }

    const chosen = this.menu.step(g.renderer);
    if (!chosen) return;

    if (choice.kind === 'perk') {
      takePerk(this.run.ctx, chosen);
      this.run.pendingChoice = null;
      audio.levelUp();
    } else {
      this.run.resolveChoice(chosen);
      audio.pickup(2);
    }
    g.pop();
  }

  render(g: Game): void {
    const choice = this.run.pendingChoice;
    const r = g.renderer;
    dimScreen(r, 0.68);
    const scale = Math.max(1, Math.min(2, r.dpr));
    const isPerk = choice?.kind === 'perk';
    const box = panel(
      r,
      Math.min(520, r.canvas.width / scale - 40),
      330,
      isPerk ? 'Level up' : 'Shrine',
      isPerk ? 'choose one' : 'choose one — both have a cost',
    );
    this.menu.draw(r, box.x, box.y, box.w, 60);
    if (!isPerk) hint(r, 'Esc to walk away', box.y + this.menu.items.length * 66 + 20);
    endPanel(r);
  }
}

// ------------------------------------------------------------------ descend

/**
 * The floor transition.
 *
 * Generation is a 15-40ms blocking call, which is a visible stutter. Hiding it
 * behind a fade means it lands on a frame where nothing is animating, so the
 * hitch is invisible. Making generation incremental instead would be far more
 * complexity for the same result.
 */
export class DescendScene implements Scene {
  passthroughStep = false;
  passthroughRender = true;

  private phase: 'out' | 'in' = 'out';
  private t = 0;
  private generated = false;

  private static readonly FADE_MS = 260;

  constructor(private run: RunState) {}

  onEnter(): void {
    audio.descend();
  }

  step(g: Game): void {
    this.t += STEP;

    if (this.phase === 'out') {
      if (this.t < DescendScene.FADE_MS) return;
      if (!this.generated) {
        this.generated = true;
        this.run.enterFloor(this.run.depth + 1);
        setCameraViewSize(g.renderer.viewW, g.renderer.viewH);
        audio.setBiome(this.run.biome.audio);
        return;
      }
      this.phase = 'in';
      this.t = 0;
      return;
    }

    if (this.t >= DescendScene.FADE_MS) g.pop();
  }

  render(g: Game): void {
    const r = g.renderer;
    const c = r.ctx;
    r.beginScreen();

    const p = clamp01(this.t / DescendScene.FADE_MS);
    const alpha = this.phase === 'out' ? p : 1 - p;
    c.globalAlpha = alpha;
    c.fillStyle = '#05050a';
    c.fillRect(0, 0, r.canvas.width, r.canvas.height);

    if (alpha > 0.6) {
      c.globalAlpha = (alpha - 0.6) / 0.4;
      const scale = Math.max(1, Math.min(2, r.dpr));
      c.save();
      c.scale(scale, scale);
      const vw = r.canvas.width / scale;
      const vh = r.canvas.height / scale;
      r.text(`Depth ${this.run.depth}`, vw / 2, vh / 2, UI_FONT_HEAD, '#d8cfae', 'center', 'middle');
      c.restore();
    }
    c.globalAlpha = 1;
  }
}

// ---------------------------------------------------------------- game over

export class GameOverScene implements Scene {
  passthroughStep = false;
  passthroughRender = false;

  private menu = new MenuList([
    { id: 'again', label: 'Descend again' },
    { id: 'sanctum', label: 'Sanctum', detail: 'Spend what you earned' },
    { id: 'title', label: 'Title screen' },
  ]);
  private t = 0;
  private save = getSave();

  constructor(
    private run: RunState,
    private award: number,
  ) {}

  onEnter(): void {
    this.save = getSave();
  }

  step(g: Game): void {
    this.t += STEP;
    // Brief lockout so a held attack key does not skip the summary.
    if (this.t < 500) return;

    const chosen = this.menu.step(g.renderer);
    if (!chosen) return;

    switch (chosen) {
      case 'again':
        startRun(g, this.run.ctx.player.player?.classId ?? 'wanderer', '');
        break;
      case 'sanctum':
        g.replace(new TitleScene());
        g.push(new SanctumScene());
        break;
      default:
        g.replace(new TitleScene());
    }
  }

  render(g: Game): void {
    const r = g.renderer;
    const c = r.ctx;
    r.clear('#07070b');
    r.beginScreen();

    const scale = Math.max(1, Math.min(2, r.dpr));
    c.save();
    c.scale(scale, scale);
    const vw = r.canvas.width / scale;
    const vh = r.canvas.height / scale;

    const s = this.run.summary;
    const beat = s.deepestFloor >= this.save.bestDepth && s.deepestFloor > 0;

    r.text(
      this.run.dead ? 'You died' : 'Run ended',
      vw / 2,
      vh * 0.18,
      UI_FONT_TITLE,
      '#c2323c',
      'center',
    );
    r.text(
      `depth ${s.deepestFloor}${beat ? '  — new best' : ''}`,
      vw / 2,
      vh * 0.18 + 30,
      UI_FONT_HEAD,
      beat ? '#ffd24a' : '#d8cfae',
      'center',
    );

    const rows: Array<[string, string]> = [
      ['kills', `${s.kills}`],
      ['elites', `${s.elitesKilled}`],
      ['bosses', `${s.bossesKilled}`],
      ['souls earned', `${this.award}`],
      ['souls banked', `${this.save.souls}`],
      ['seed', this.run.seedText],
    ];
    const listY = vh * 0.32;
    rows.forEach(([k, v], i) => {
      const y = listY + i * 20;
      r.text(k, vw / 2 - 110, y, UI_FONT_SMALL, '#8f97a3', 'left');
      r.text(v, vw / 2 + 110, y, UI_FONT, '#efe7d4', 'right');
    });

    // Show the build that got them there — the run's story in one line.
    const relics = Object.entries(this.run.ctx.player.player?.relics ?? {}).filter(
      ([, n]) => n > 0,
    );
    if (relics.length > 0) {
      const startX = vw / 2 - Math.min(relics.length, 14) * 11;
      relics.slice(0, 14).forEach(([id, stacks], i) => {
        const def = RELIC_REGISTRY[id];
        if (!def) return;
        const x = startX + i * 22;
        const y = listY + rows.length * 20 + 22;
        c.strokeStyle = RARITY_COLOR[def.rarity];
        c.lineWidth = 1;
        c.strokeRect(x - 8.5, y - 8.5, 17, 17);
        c.save();
        c.translate(x, y);
        def.glyph(c, 6, def.color, this.t);
        c.restore();
        if (stacks > 1) {
          r.text(`${stacks}`, x + 8, y + 12, UI_FONT_SMALL, '#b9b3a6', 'right');
        }
      });
    }

    const w = Math.min(320, vw - 60);
    this.menu.draw(r, (vw - w) / 2, vh * 0.62, w, 40);
    c.restore();
  }
}

/** Preview of what the next unlock costs; used by the game-over hint line. */
export function nextUnlockHint(save: SaveData): string | null {
  const affordable = UNLOCKS.filter(
    (u) => !save.unlocks.includes(u.id) && unlockAvailable(u, save.soulsSpent),
  ).sort((a, b) => a.cost - b.cost)[0];
  if (!affordable) return null;
  if (save.souls >= affordable.cost) return `${affordable.name} is available in the Sanctum`;
  return `${affordable.cost - save.souls} more souls for ${affordable.name}`;
}

/** Estimate souls for a hypothetical run; used by the tests. */
export function previewSouls(depth: number, bestDepth: number): number {
  return soulsEarned(
    { deepestFloor: depth, bossesKilled: Math.floor(depth / 5), elitesKilled: depth, kills: depth * 30 },
    bestDepth,
  );
}
