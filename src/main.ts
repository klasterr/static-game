import { audio } from './core/audio';
import { Input } from './core/input';
import { loadSave, markDirty, registerSaveVocabulary, saveNow } from './core/storage';
import { CLASSES } from './content/classes';
import { assertContentValid } from './content';
import { ALL_UNLOCK_IDS } from './systems/loot';
import { Game } from './game';
import { fx } from './render/fx';
import { setCameraViewSize } from './run/runState';
import { HelpScene, PlayScene, TitleScene } from './ui/scenes';

/**
 * Bootstrap. DOM wiring only — nothing game-logical lives here.
 */

function boot(): void {
  const canvas = document.getElementById('game');
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error('#game canvas is missing from the document');
  }

  // Teach the save layer which ids are real, so `sanitize` can reject stale
  // ones from an older build instead of crashing the Sanctum.
  registerSaveVocabulary(
    ALL_UNLOCK_IDS,
    CLASSES.map((c) => c.id),
  );

  // Content mistakes should surface at boot, not on floor fourteen.
  if (import.meta.env.DEV) assertContentValid();

  const save = loadSave();
  fx.allowFlashes = save.settings.flashes;
  fx.allowDamageNumbers = save.settings.damageNumbers;

  const game = new Game(canvas);
  setCameraViewSize(game.renderer.viewW, game.renderer.viewH);
  game.push(new TitleScene());
  if (!save.seenIntro) game.push(new HelpScene());

  installLifecycle(game, canvas);
  game.start();

  window.__booted = true;
}

function installLifecycle(game: Game, canvas: HTMLCanvasElement): void {
  // Debounced resize. Dragging a window edge fires this dozens of times a
  // second, and each one rebuilds canvas backing stores.
  let resizeHandle: ReturnType<typeof setTimeout> | null = null;
  const scheduleResize = (): void => {
    if (resizeHandle !== null) clearTimeout(resizeHandle);
    resizeHandle = setTimeout(() => {
      resizeHandle = null;
      game.handleResize();
      setCameraViewSize(game.renderer.viewW, game.renderer.viewH);
    }, 100);
  };

  if ('ResizeObserver' in window) {
    new ResizeObserver(scheduleResize).observe(canvas.parentElement ?? canvas);
  }
  window.addEventListener('resize', scheduleResize);
  window.addEventListener('orientationchange', scheduleResize);

  // Audio needs a user gesture before it can start. Unlock on the first one of
  // either kind, then stop listening.
  const unlock = (): void => {
    audio.unlock();
    const s = loadSaveSettings();
    audio.applyVolumes(s.master, s.sfx, s.music);
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return;
    // Pause and flush on the way out. Returning does NOT auto-resume: the
    // player should not come back to a fight already in progress.
    game.pause();
    Input.releaseAll();
    const play = game.scenes.find((s) => s instanceof PlayScene) as PlayScene | undefined;
    play?.run.bankSouls();
    saveNow();
  });

  window.addEventListener('pagehide', () => {
    markDirty();
    saveNow();
  });

  // Touch: enable the virtual stick automatically on coarse pointers.
  if (window.matchMedia('(pointer: coarse)').matches) {
    void import('./core/touch').then((m) => m.installTouchControls(canvas));
  }
}

function loadSaveSettings(): { master: number; sfx: number; music: number } {
  const save = loadSave();
  return save.settings;
}

declare global {
  interface Window {
    __booted?: boolean;
  }
}

try {
  boot();
} catch (err) {
  // A boot failure has to be visible; a blank canvas tells the player nothing.
  const el = document.getElementById('boot-error');
  if (el) {
    el.style.display = 'grid';
    el.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
  }
  throw err;
}
