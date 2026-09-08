import { Action, Input } from '../core/input';
import { audio } from '../core/audio';
import type { Renderer } from '../render/renderer';

/**
 * Canvas menu widgets.
 *
 * All UI is drawn on the canvas rather than in the DOM. One rendering path
 * means no CSS, no z-index fights, no font-loading flash, and no divergence
 * between how the game and the menus scale.
 */

export const UI_FONT = '600 14px ui-monospace, "Cascadia Mono", monospace';
export const UI_FONT_SMALL = '600 11px ui-monospace, "Cascadia Mono", monospace';
export const UI_FONT_TITLE = '700 44px ui-monospace, "Cascadia Mono", monospace';
export const UI_FONT_HEAD = '700 20px ui-monospace, "Cascadia Mono", monospace';

export interface MenuItem {
  id: string;
  label: string;
  /** Second line, dimmer. */
  detail?: string;
  /** Right-aligned value, e.g. a cost or a setting's current state. */
  value?: string;
  disabled?: boolean;
  color?: string;
}

interface Row {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Keyboard + mouse list. One instance per menu, reused across frames. */
export class MenuList {
  index = 0;
  private rows: Row[] = [];
  private lastHover = -1;

  constructor(public items: MenuItem[]) {}

  setItems(items: MenuItem[]): void {
    this.items = items;
    if (this.index >= items.length) this.index = Math.max(0, items.length - 1);
  }

  private firstEnabled(from: number, dir: number): number {
    const n = this.items.length;
    if (n === 0) return 0;
    let i = from;
    for (let step = 0; step < n; step++) {
      i = (i + dir + n) % n;
      if (!this.items[i].disabled) return i;
    }
    return from;
  }

  /** Advance selection. Returns the chosen id when confirmed, else null. */
  step(r: Renderer): string | null {
    if (this.items.length === 0) return null;

    if (Input.pressed(Action.Up) || Input.pressed(Action.Left)) {
      this.index = this.firstEnabled(this.index, -1);
      audio.ui(true);
    }
    if (Input.pressed(Action.Down) || Input.pressed(Action.Right)) {
      this.index = this.firstEnabled(this.index, 1);
      audio.ui(false);
    }

    // Mouse hover follows the pointer, so both input styles stay live.
    const hover = this.hitTest(r);
    if (hover >= 0 && hover !== this.lastHover && !this.items[hover].disabled) {
      this.index = hover;
      this.lastHover = hover;
      audio.ui(true);
    }

    if (Input.pointerPressed && hover >= 0 && !this.items[hover].disabled) {
      return this.items[hover].id;
    }
    if (Input.menuConfirm() && !this.items[this.index].disabled) {
      return this.items[this.index].id;
    }
    return null;
  }

  private hitTest(r: Renderer): number {
    const mx = Input.mouseSX * r.dpr;
    const my = Input.mouseSY * r.dpr;
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i];
      if (mx >= row.x && mx <= row.x + row.w && my >= row.y && my <= row.y + row.h) return i;
    }
    return -1;
  }

  /** Draw, and record hit rects for the next frame's mouse test. */
  draw(r: Renderer, x: number, y: number, w: number, rowH = 40): number {
    const c = r.ctx;
    this.rows.length = 0;

    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      const top = y + i * (rowH + 6);
      const selected = i === this.index;
      this.rows.push({ x, y: top, w, h: rowH });

      c.globalAlpha = item.disabled ? 0.35 : 1;
      c.fillStyle = selected ? 'rgba(216,207,174,0.14)' : 'rgba(8,8,14,0.6)';
      c.fillRect(x, top, w, rowH);
      c.strokeStyle = selected ? item.color ?? '#d8cfae' : 'rgba(216,207,174,0.18)';
      c.lineWidth = selected ? 2 : 1;
      c.strokeRect(x + 0.5, top + 0.5, w - 1, rowH - 1);

      // Selection caret. Small, but it makes keyboard state unambiguous.
      if (selected) {
        c.fillStyle = item.color ?? '#d8cfae';
        c.beginPath();
        c.moveTo(x - 10, top + rowH / 2 - 5);
        c.lineTo(x - 2, top + rowH / 2);
        c.lineTo(x - 10, top + rowH / 2 + 5);
        c.closePath();
        c.fill();
      }

      const labelY = item.detail ? top + 17 : top + rowH / 2 + 1;
      r.text(
        item.label,
        x + 14,
        labelY,
        UI_FONT,
        item.color ?? '#efe7d4',
        'left',
        item.detail ? 'alphabetic' : 'middle',
      );
      if (item.detail) {
        r.text(item.detail, x + 14, top + 32, UI_FONT_SMALL, '#8f97a3', 'left');
      }
      if (item.value) {
        r.text(
          item.value,
          x + w - 14,
          top + rowH / 2 + 1,
          UI_FONT,
          '#b9b3a6',
          'right',
          'middle',
        );
      }
      c.globalAlpha = 1;
    }

    return this.items.length * (rowH + 6);
  }
}

/**
 * A single-line text field for seed entry.
 *
 * Installs its own keydown listener while focused rather than routing through
 * the action map, because seed entry needs raw characters and the action map is
 * deliberately physical-key based.
 */
export class TextField {
  value = '';
  focused = false;
  private handler: ((e: KeyboardEvent) => void) | null = null;

  constructor(
    public maxLength = 8,
    public allow = /^[A-Za-z0-9]$/,
  ) {}

  focus(): void {
    if (this.focused) return;
    this.focused = true;
    this.handler = (e: KeyboardEvent) => {
      if (e.key === 'Backspace') {
        this.value = this.value.slice(0, -1);
        e.preventDefault();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Escape') return;
      if (e.key.length !== 1 || !this.allow.test(e.key)) return;
      if (this.value.length >= this.maxLength) return;
      this.value += e.key.toUpperCase();
      e.preventDefault();
    };
    window.addEventListener('keydown', this.handler);
  }

  blur(): void {
    if (!this.focused) return;
    this.focused = false;
    if (this.handler) window.removeEventListener('keydown', this.handler);
    this.handler = null;
  }

  draw(
    r: Renderer,
    x: number,
    y: number,
    w: number,
    h: number,
    placeholder: string,
    timeMs: number,
  ): void {
    const c = r.ctx;
    c.fillStyle = 'rgba(8,8,14,0.7)';
    c.fillRect(x, y, w, h);
    c.strokeStyle = this.focused ? '#a8e6ff' : 'rgba(216,207,174,0.25)';
    c.lineWidth = this.focused ? 2 : 1;
    c.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

    const shown = this.value.length > 0 ? this.value : placeholder;
    r.text(
      shown,
      x + 12,
      y + h / 2 + 1,
      UI_FONT,
      this.value.length > 0 ? '#efe7d4' : '#5a5466',
      'left',
      'middle',
    );

    if (this.focused && Math.floor(timeMs / 500) % 2 === 0) {
      const caretX = x + 12 + r.measure(this.value, UI_FONT) + 2;
      c.fillStyle = '#a8e6ff';
      c.fillRect(caretX, y + 8, 2, h - 16);
    }
  }
}

/** Dim the whole screen. Used behind every overlay. */
export function dimScreen(r: Renderer, alpha: number): void {
  const c = r.ctx;
  r.beginScreen();
  c.globalAlpha = alpha;
  c.fillStyle = '#05050a';
  c.fillRect(0, 0, r.canvas.width, r.canvas.height);
  c.globalAlpha = 1;
}

/** A titled panel. Returns the content origin. */
export function panel(
  r: Renderer,
  w: number,
  h: number,
  title: string,
  subtitle?: string,
): { x: number; y: number; w: number } {
  const c = r.ctx;
  r.beginScreen();
  const scale = Math.max(1, Math.min(2, r.dpr));
  c.save();
  c.scale(scale, scale);

  const vw = r.canvas.width / scale;
  const vh = r.canvas.height / scale;
  const x = (vw - w) / 2;
  const y = (vh - h) / 2;

  c.fillStyle = 'rgba(6,6,12,0.9)';
  c.fillRect(x, y, w, h);
  c.strokeStyle = 'rgba(216,207,174,0.25)';
  c.lineWidth = 1;
  c.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

  r.text(title, x + w / 2, y + 34, UI_FONT_HEAD, '#d8cfae', 'center');
  if (subtitle) {
    r.text(subtitle, x + w / 2, y + 54, UI_FONT_SMALL, '#8f97a3', 'center');
  }

  return { x: x + 28, y: y + (subtitle ? 76 : 58), w: w - 56 };
}

export function endPanel(r: Renderer): void {
  r.ctx.restore();
}

/** Footer hint line, e.g. key reminders. */
export function hint(r: Renderer, text: string, y: number): void {
  const scale = Math.max(1, Math.min(2, r.dpr));
  const vw = r.canvas.width / scale;
  r.text(text, vw / 2, y, UI_FONT_SMALL, '#5a5466', 'center');
}
