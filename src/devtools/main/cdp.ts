import type { BrowserWindow, WebContents } from 'electron';

/**
 * Wraps `webContents.debugger.attach('1.3')` and exposes typed helpers
 * for the Chrome DevTools Protocol calls used by the inspection bridge.
 *
 * Single attach per window. Subsequent `attach()` calls are no-ops.
 * `detach()` is wired into the dev-only shutdown hook so the debugger
 * is released cleanly on app quit.
 *
 * Console.messageAdded events feed an internal ring buffer so the
 * `/console` endpoint can return the last N messages without keeping
 * a live websocket open. Buffer size is fixed at 500 entries.
 */

const CDP_VERSION = '1.3';
const CONSOLE_RING_SIZE = 500;

interface AttachedState {
  webContents: WebContents;
  consoleRing: ConsoleEntry[];
  consoleListener: (event: Electron.Event, method: string, params: unknown) => void;
  detachListener: (event: Electron.Event, reason: string) => void;
}

export interface ConsoleEntry {
  ts: string;
  level: 'log' | 'warn' | 'error' | 'info' | 'debug' | 'verbose';
  text: string;
  url: string | null;
  lineNumber: number | null;
}

const attached = new WeakMap<WebContents, AttachedState>();

export function attachDebugger(window: BrowserWindow): boolean {
  const webContents = window.webContents;
  if (attached.has(webContents)) return true;
  try {
    webContents.debugger.attach(CDP_VERSION);
  } catch {
    return false;
  }
  const state: AttachedState = {
    webContents,
    consoleRing: [],
    consoleListener: (_event, method, params) => {
      if (method === 'Console.messageAdded') {
        const message = (params as { message: ConsoleMessage }).message;
        state.consoleRing.push({
          ts: new Date().toISOString(),
          level: normalizeLevel(message.level),
          text: message.text ?? '',
          url: message.url ?? null,
          lineNumber: typeof message.line === 'number' ? message.line : null,
        });
        while (state.consoleRing.length > CONSOLE_RING_SIZE) {
          state.consoleRing.shift();
        }
      }
    },
    detachListener: (_event, _reason) => {
      // Fires when the debugger is detached for any reason: explicit
      // `webContents.debugger.detach()` from us, the user opening
      // DevTools (which steals the connection), or the webContents being
      // destroyed. Drop the WeakMap entry so subsequent calls see "not
      // attached" instead of stale state - they'll either return null /
      // 5xx through the inspection-server, or the bridge can re-attach
      // explicitly via attachDebugger() when appropriate. We deliberately
      // do NOT auto-reattach: the typical cause is the user opening
      // DevTools, and stealing it back would be hostile.
      attached.delete(state.webContents);
    },
  };
  webContents.debugger.on('message', state.consoleListener);
  webContents.debugger.on('detach', state.detachListener);
  // Enable the domains we use. Each `sendCommand` is fire-and-forget;
  // failures during enable are non-fatal and the corresponding endpoint
  // returns 5xx if its capability is missing. Console.* is technically
  // deprecated in modern CDP in favor of Runtime.consoleAPICalled, but
  // it still works on Chromium 120+ which is what current Electron ships.
  void webContents.debugger.sendCommand('Console.enable').catch(() => {});
  void webContents.debugger.sendCommand('DOM.enable').catch(() => {});
  void webContents.debugger.sendCommand('Runtime.enable').catch(() => {});
  void webContents.debugger.sendCommand('CSS.enable').catch(() => {});
  attached.set(webContents, state);
  return true;
}

export function detachDebugger(window: BrowserWindow): void {
  const state = attached.get(window.webContents);
  if (!state) return;
  try {
    state.webContents.debugger.removeListener('message', state.consoleListener);
    state.webContents.debugger.removeListener('detach', state.detachListener);
    state.webContents.debugger.detach();
  } catch {
    // best-effort
  }
  attached.delete(window.webContents);
}

/**
 * Returns true when CDP is currently attached to the given window's
 * webContents. The HTTP server's CDP-backed endpoints can use this to
 * fail-fast with a clear error instead of waiting for the underlying
 * sendCommand to reject.
 */
export function isDebuggerAttached(window: BrowserWindow): boolean {
  return attached.has(window.webContents);
}

interface ConsoleMessage {
  level?: string;
  text?: string;
  url?: string;
  line?: number;
}

function normalizeLevel(level: string | undefined): ConsoleEntry['level'] {
  switch (level) {
    case 'log':
    case 'warn':
    case 'error':
    case 'info':
    case 'debug':
    case 'verbose':
      return level;
    default:
      return 'log';
  }
}

export function getConsoleEntries(window: BrowserWindow): ConsoleEntry[] {
  const state = attached.get(window.webContents);
  return state ? [...state.consoleRing] : [];
}

// ---------------------------------------------------------------------------
// Page / Screenshot
// ---------------------------------------------------------------------------

export interface ScreenshotOptions {
  format?: 'png' | 'jpeg';
  quality?: number;
  clip?: { x: number; y: number; width: number; height: number; scale?: number };
  fullPage?: boolean;
}

export async function captureScreenshot(
  window: BrowserWindow,
  options: ScreenshotOptions = {},
): Promise<string | null> {
  const result = (await window.webContents.debugger.sendCommand('Page.captureScreenshot', {
    format: options.format ?? 'png',
    quality: options.quality,
    clip: options.clip
      ? { ...options.clip, scale: options.clip.scale ?? 1 }
      : undefined,
    captureBeyondViewport: options.fullPage ?? false,
  })) as { data: string };
  return result.data ?? null;
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

interface DocumentRoot {
  root: { nodeId: number; backendNodeId: number };
}

interface QueriedNode {
  nodeId: number;
}

interface OuterHtml {
  outerHTML: string;
}

interface BoxModel {
  model: {
    width: number;
    height: number;
    border: number[];
    content: number[];
    margin: number[];
    padding: number[];
  };
}

async function resolveSelector(window: BrowserWindow, selector: string): Promise<number | null> {
  const root = (await window.webContents.debugger.sendCommand('DOM.getDocument', {
    depth: 0,
  })) as DocumentRoot;
  const queried = (await window.webContents.debugger.sendCommand('DOM.querySelector', {
    nodeId: root.root.nodeId,
    selector,
  })) as QueriedNode;
  return queried.nodeId || null;
}

export async function getOuterHtml(
  window: BrowserWindow,
  selector: string,
): Promise<string | null> {
  const nodeId = await resolveSelector(window, selector);
  if (!nodeId) return null;
  const result = (await window.webContents.debugger.sendCommand('DOM.getOuterHTML', {
    nodeId,
  })) as OuterHtml;
  return result.outerHTML ?? null;
}

export async function getBoundingBox(
  window: BrowserWindow,
  selector: string,
): Promise<BoxModel['model'] | null> {
  const nodeId = await resolveSelector(window, selector);
  if (!nodeId) return null;
  try {
    const result = (await window.webContents.debugger.sendCommand('DOM.getBoxModel', {
      nodeId,
    })) as BoxModel;
    return result.model;
  } catch {
    return null;
  }
}

export async function getComputedStyle(
  window: BrowserWindow,
  selector: string,
): Promise<Record<string, string> | null> {
  const nodeId = await resolveSelector(window, selector);
  if (!nodeId) return null;
  try {
    const result = (await window.webContents.debugger.sendCommand(
      'CSS.getComputedStyleForNode',
      { nodeId },
    )) as { computedStyle: { name: string; value: string }[] };
    const out: Record<string, string> = {};
    for (const entry of result.computedStyle) out[entry.name] = entry.value;
    return out;
  } catch {
    return null;
  }
}

export async function getAccessibilityTree(
  window: BrowserWindow,
): Promise<unknown> {
  try {
    return await window.webContents.debugger.sendCommand('Accessibility.getFullAXTree');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Input (mouse + keyboard)
// ---------------------------------------------------------------------------

export type MouseEventType = 'mousePressed' | 'mouseReleased' | 'mouseMoved';
export type MouseButton = 'none' | 'left' | 'middle' | 'right';

export interface MouseEventOptions {
  type: MouseEventType;
  x: number;
  y: number;
  button?: MouseButton;
  clickCount?: number;
}

export async function dispatchMouseEvent(
  window: BrowserWindow,
  options: MouseEventOptions,
): Promise<void> {
  await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: options.type,
    x: options.x,
    y: options.y,
    button: options.button ?? (options.type === 'mouseMoved' ? 'none' : 'left'),
    clickCount: options.clickCount ?? (options.type === 'mouseMoved' ? 0 : 1),
  });
}

export async function clickAtCenterOfSelector(
  window: BrowserWindow,
  selector: string,
): Promise<boolean> {
  const box = await getBoundingBox(window, selector);
  if (!box || !Array.isArray(box.content) || box.content.length < 8) return false;
  // `content` is a quad: x0,y0, x1,y1, x2,y2, x3,y3 (top-left, top-right,
  // bottom-right, bottom-left). Compute the centroid.
  const cx = (box.content[0] + box.content[4]) / 2;
  const cy = (box.content[1] + box.content[5]) / 2;
  await dispatchMouseEvent(window, { type: 'mousePressed', x: cx, y: cy });
  await dispatchMouseEvent(window, { type: 'mouseReleased', x: cx, y: cy });
  return true;
}

export async function dragFromTo(
  window: BrowserWindow,
  fromSelector: string,
  toSelector: string,
  options: { steps?: number } = {},
): Promise<boolean> {
  const fromBox = await getBoundingBox(window, fromSelector);
  const toBox = await getBoundingBox(window, toSelector);
  if (!fromBox || !toBox) return false;
  const sourceX = (fromBox.content[0] + fromBox.content[4]) / 2;
  const sourceY = (fromBox.content[1] + fromBox.content[5]) / 2;
  const targetX = (toBox.content[0] + toBox.content[4]) / 2;
  const targetY = (toBox.content[1] + toBox.content[5]) / 2;
  const steps = Math.max(2, options.steps ?? 10);

  await dispatchMouseEvent(window, { type: 'mousePressed', x: sourceX, y: sourceY });
  for (let stepIndex = 1; stepIndex <= steps; stepIndex++) {
    const fraction = stepIndex / steps;
    await dispatchMouseEvent(window, {
      type: 'mouseMoved',
      x: sourceX + (targetX - sourceX) * fraction,
      y: sourceY + (targetY - sourceY) * fraction,
    });
  }
  await dispatchMouseEvent(window, { type: 'mouseReleased', x: targetX, y: targetY });
  return true;
}

export interface KeyEventOptions {
  type: 'keyDown' | 'keyUp' | 'char' | 'rawKeyDown';
  text?: string;
  key?: string;
  code?: string;
  windowsVirtualKeyCode?: number;
  modifiers?: number;
}

export async function dispatchKeyEvent(
  window: BrowserWindow,
  options: KeyEventOptions,
): Promise<void> {
  await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', options);
}

/**
 * Type a string by dispatching one `char` event per character. The CDP
 * `char` event handles printable text properly (no key-code mapping
 * needed). Special keys go through `dispatchKeypress`.
 */
export async function typeText(window: BrowserWindow, text: string): Promise<void> {
  for (const character of text) {
    await dispatchKeyEvent(window, { type: 'char', text: character });
  }
}

const SPECIAL_KEY_MAP: Record<string, { code: string; key: string; vk: number }> = {
  Enter: { code: 'Enter', key: 'Enter', vk: 13 },
  Escape: { code: 'Escape', key: 'Escape', vk: 27 },
  Tab: { code: 'Tab', key: 'Tab', vk: 9 },
  Backspace: { code: 'Backspace', key: 'Backspace', vk: 8 },
  ArrowUp: { code: 'ArrowUp', key: 'ArrowUp', vk: 38 },
  ArrowDown: { code: 'ArrowDown', key: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', key: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', key: 'ArrowRight', vk: 39 },
  Space: { code: 'Space', key: ' ', vk: 32 },
};

const MODIFIER_FLAGS: Record<string, number> = {
  Alt: 1,
  Ctrl: 2,
  Meta: 4,
  Shift: 8,
  Cmd: 4, // alias for Meta
};

/**
 * Parse a chord like `Ctrl+Shift+P` and dispatch the keyDown / keyUp
 * pair. Single-character segments fall through to `typeText` so
 * `dispatchKeypress('a')` types the letter.
 */
export async function dispatchKeypress(
  window: BrowserWindow,
  combo: string,
): Promise<boolean> {
  const parts = combo.split('+').map((part) => part.trim());
  if (parts.length === 0) return false;
  const target = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);

  let modifierFlags = 0;
  for (const modifier of modifiers) {
    const flag = MODIFIER_FLAGS[modifier];
    if (flag === undefined) return false;
    modifierFlags |= flag;
  }

  const special = SPECIAL_KEY_MAP[target];
  if (special) {
    await dispatchKeyEvent(window, {
      type: 'keyDown',
      key: special.key,
      code: special.code,
      windowsVirtualKeyCode: special.vk,
      modifiers: modifierFlags,
    });
    await dispatchKeyEvent(window, {
      type: 'keyUp',
      key: special.key,
      code: special.code,
      windowsVirtualKeyCode: special.vk,
      modifiers: modifierFlags,
    });
    return true;
  }

  if (target.length === 1) {
    if (modifierFlags === 0) {
      await typeText(window, target);
      return true;
    }
    const upper = target.toUpperCase();
    const vk = upper.charCodeAt(0);
    await dispatchKeyEvent(window, {
      type: 'keyDown',
      key: target,
      code: `Key${upper}`,
      windowsVirtualKeyCode: vk,
      modifiers: modifierFlags,
    });
    await dispatchKeyEvent(window, {
      type: 'keyUp',
      key: target,
      code: `Key${upper}`,
      windowsVirtualKeyCode: vk,
      modifiers: modifierFlags,
    });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Runtime.evaluate
// ---------------------------------------------------------------------------

export async function runtimeEvaluate<T = unknown>(
  window: BrowserWindow,
  expression: string,
  options: { awaitPromise?: boolean; returnByValue?: boolean } = {},
): Promise<{ value: T | null; error: string | null }> {
  try {
    const result = (await window.webContents.debugger.sendCommand('Runtime.evaluate', {
      expression,
      awaitPromise: options.awaitPromise ?? true,
      returnByValue: options.returnByValue ?? true,
    })) as { result: { value?: T }; exceptionDetails?: { text?: string } };
    if (result.exceptionDetails) {
      return { value: null, error: result.exceptionDetails.text ?? 'evaluation error' };
    }
    return { value: (result.result.value as T | undefined) ?? null, error: null };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) };
  }
}
