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
  let webContents: WebContents;
  try {
    // `before-quit` may fire after the window is destroyed; the `webContents`
    // getter throws "Object has been destroyed" in that case.
    if (window.isDestroyed()) return;
    webContents = window.webContents;
  } catch {
    return;
  }
  const state = attached.get(webContents);
  if (!state) return;
  try {
    webContents.debugger.removeListener('message', state.consoleListener);
    webContents.debugger.removeListener('detach', state.detachListener);
    webContents.debugger.detach();
  } catch {
    // best-effort
  }
  attached.delete(webContents);
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

export interface LayoutMetrics {
  /** Layout viewport in CSS pixels (matches `window.innerWidth/Height`). */
  viewportWidth: number;
  viewportHeight: number;
  /** Device pixel ratio applied by `Page.captureScreenshot` to produce raster output. */
  deviceScaleFactor: number;
  /** Full document size in CSS pixels (used by `fullPage: true` capture). */
  contentWidth: number;
  contentHeight: number;
}

/**
 * Returns the layout viewport, device scale factor, and full content size.
 * Used by the screenshot response to surface scale metadata so the agent
 * can map image-space coordinates back to viewport-space without guessing.
 */
export async function getLayoutMetrics(window: BrowserWindow): Promise<LayoutMetrics | null> {
  try {
    const result = (await window.webContents.debugger.sendCommand('Page.getLayoutMetrics')) as {
      cssLayoutViewport?: { clientWidth: number; clientHeight: number };
      layoutViewport?: { clientWidth: number; clientHeight: number };
      cssVisualViewport?: { scale?: number };
      visualViewport?: { scale?: number };
      cssContentSize?: { width: number; height: number };
      contentSize?: { width: number; height: number };
    };
    const viewport = result.cssLayoutViewport ?? result.layoutViewport;
    const content = result.cssContentSize ?? result.contentSize;
    if (!viewport) return null;
    const deviceScaleFactorResult = (await window.webContents.debugger.sendCommand('Runtime.evaluate', {
      expression: 'window.devicePixelRatio',
      returnByValue: true,
    })) as { result: { value?: number } };
    const deviceScaleFactor =
      typeof deviceScaleFactorResult.result.value === 'number'
        ? deviceScaleFactorResult.result.value
        : 1;
    return {
      viewportWidth: viewport.clientWidth,
      viewportHeight: viewport.clientHeight,
      deviceScaleFactor,
      contentWidth: content?.width ?? viewport.clientWidth,
      contentHeight: content?.height ?? viewport.clientHeight,
    };
  } catch {
    return null;
  }
}

/**
 * Parse PNG/JPEG header bytes to recover the rasterized image dimensions.
 * Avoids paying for a separate CDP roundtrip just to learn what we
 * already produced. PNG dimensions live at offset 16/20; JPEG SOF
 * markers carry them in the marker payload.
 */
export function decodeImageDimensions(
  format: 'png' | 'jpeg',
  buffer: Buffer,
): { width: number; height: number } | null {
  if (format === 'png') {
    if (buffer.length < 24) return null;
    if (buffer.readUInt32BE(0) !== 0x89504e47) return null;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset < buffer.length - 9) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1];
    const segmentLength = buffer.readUInt16BE(offset + 2);
    const isStartOfFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isStartOfFrame) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + segmentLength;
  }
  return null;
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

/**
 * Selector spec parsed out of the user-supplied string. Supports the
 * standard CSS form plus three convenience prefixes that match
 * Playwright vocabulary:
 *
 *   - `text="Cancel"` (or `text=Cancel`)         -> exact visible-text match
 *   - `text*="Cancel"` (or `text*=Cancel`)       -> substring visible-text match
 *   - `aria="Cancel"` (or `aria=Cancel`)         -> accessible name match
 *   - `:has-text("Cancel")`                       -> alias for text*=
 *
 * Anything that doesn't match those prefixes falls through to plain
 * CSS, so existing callers continue to work without changes.
 */
interface SelectorSpec {
  kind: 'css' | 'text' | 'text-contains' | 'aria';
  value: string;
}

const TEXT_RE = /^text=(?:"([^"]*)"|'([^']*)'|(.+))$/;
const TEXT_CONTAINS_RE = /^text\*=(?:"([^"]*)"|'([^']*)'|(.+))$/;
const ARIA_RE = /^aria=(?:"([^"]*)"|'([^']*)'|(.+))$/;
const HAS_TEXT_RE = /:has-text\((?:"([^"]*)"|'([^']*)')\)/;

export function parseSelectorSpec(selector: string): SelectorSpec {
  const trimmed = selector.trim();
  let match = trimmed.match(TEXT_RE);
  if (match) return { kind: 'text', value: match[1] ?? match[2] ?? match[3] ?? '' };
  match = trimmed.match(TEXT_CONTAINS_RE);
  if (match) return { kind: 'text-contains', value: match[1] ?? match[2] ?? match[3] ?? '' };
  match = trimmed.match(ARIA_RE);
  if (match) return { kind: 'aria', value: match[1] ?? match[2] ?? match[3] ?? '' };
  match = trimmed.match(HAS_TEXT_RE);
  if (match) return { kind: 'text-contains', value: match[1] ?? match[2] ?? '' };
  return { kind: 'css', value: trimmed };
}

interface EvaluateNodeResult {
  result: { objectId?: string; subtype?: string };
  exceptionDetails?: unknown;
}

async function resolveSelector(window: BrowserWindow, selector: string): Promise<number | null> {
  const spec = parseSelectorSpec(selector);
  if (spec.kind === 'css') {
    const root = (await window.webContents.debugger.sendCommand('DOM.getDocument', {
      depth: 0,
    })) as DocumentRoot;
    const queried = (await window.webContents.debugger.sendCommand('DOM.querySelector', {
      nodeId: root.root.nodeId,
      selector: spec.value,
    })) as QueriedNode;
    return queried.nodeId || null;
  }
  const expression = buildSelectorExpression(spec);
  const evalResult = (await window.webContents.debugger.sendCommand('Runtime.evaluate', {
    expression,
    returnByValue: false,
  })) as EvaluateNodeResult;
  if (evalResult.exceptionDetails) return null;
  const objectId = evalResult.result?.objectId;
  if (!objectId || evalResult.result.subtype === 'null') return null;
  try {
    const nodeResult = (await window.webContents.debugger.sendCommand('DOM.requestNode', {
      objectId,
    })) as { nodeId: number };
    return nodeResult.nodeId || null;
  } finally {
    try {
      await window.webContents.debugger.sendCommand('Runtime.releaseObject', { objectId });
    } catch {
      // best-effort
    }
  }
}

export function buildSelectorExpression(spec: SelectorSpec): string {
  const targetLiteral = JSON.stringify(spec.value);
  // Limit the candidate pool to interactive / labeled elements so we don't
  // accidentally match a parent <div> that contains the text. The pool is
  // intentionally generous - missing a candidate is worse than a benign
  // over-match because the agent gets a clear "not found" signal.
  const candidatesJs =
    "document.querySelectorAll('button, a, input, textarea, select, label, summary, [role], [aria-label], [aria-labelledby], [contenteditable=\"true\"]')";
  if (spec.kind === 'text') {
    return `(() => {
      const target = ${targetLiteral};
      for (const element of ${candidatesJs}) {
        const ariaLabel = element.getAttribute('aria-label');
        const visibleText = (ariaLabel ?? element.innerText ?? element.textContent ?? '').trim();
        if (visibleText === target) return element;
      }
      return null;
    })()`;
  }
  if (spec.kind === 'text-contains') {
    return `(() => {
      const target = ${targetLiteral};
      for (const element of ${candidatesJs}) {
        const ariaLabel = element.getAttribute('aria-label');
        const visibleText = (ariaLabel ?? element.innerText ?? element.textContent ?? '').trim();
        if (visibleText.includes(target)) return element;
      }
      return null;
    })()`;
  }
  // aria= -- prefer aria-label, fall back to text content for unlabeled
  // elements whose name derives from their content per the WAI-ARIA spec
  // (button, link, heading, etc.).
  return `(() => {
    const target = ${targetLiteral};
    for (const element of document.querySelectorAll('[aria-label]')) {
      if ((element.getAttribute('aria-label') ?? '').trim() === target) return element;
    }
    for (const element of document.querySelectorAll('button, a, [role="button"], [role="link"], [role="menuitem"], [role="tab"], h1, h2, h3, h4, h5, h6')) {
      const visibleText = (element.innerText ?? element.textContent ?? '').trim();
      if (visibleText === target) return element;
    }
    return null;
  })()`;
}

export async function getOuterHtml(
  window: BrowserWindow,
  selector: string,
): Promise<string | null> {
  const nodeId = await resolveSelector(window, selector);
  if (!nodeId) return null;
  return getOuterHtmlByNodeId(window, nodeId);
}

export async function getOuterHtmlByNodeId(
  window: BrowserWindow,
  nodeId: number,
): Promise<string | null> {
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
  return getBoundingBoxByNodeId(window, nodeId);
}

export async function getBoundingBoxByNodeId(
  window: BrowserWindow,
  nodeId: number,
): Promise<BoxModel['model'] | null> {
  try {
    const result = (await window.webContents.debugger.sendCommand('DOM.getBoxModel', {
      nodeId,
    })) as BoxModel;
    return result.model;
  } catch {
    return null;
  }
}

/**
 * Public selector resolver. Useful when callers want to do multiple CDP
 * operations against the same element without re-running DOM.querySelector
 * each time. Returns null when the selector doesn't match.
 */
export async function resolveSelectorPublic(
  window: BrowserWindow,
  selector: string,
): Promise<number | null> {
  return resolveSelector(window, selector);
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
