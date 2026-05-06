import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { app, type BrowserWindow } from 'electron';
import {
  captureScreenshot,
  clickAtCenterOfSelector,
  dispatchKeyEvent,
  dispatchKeypress,
  dispatchMouseEvent,
  dragFromTo,
  getAccessibilityTree,
  getBoundingBox,
  getComputedStyle,
  getConsoleEntries,
  getOuterHtml,
  isDebuggerAttached,
  runtimeEvaluate,
  typeText,
} from './cdp';
import { getProcessMetrics } from '../../main/diagnostics/process-metrics';
import type { SessionManager } from '../../main/pty/session-manager';

/**
 * Localhost-only HTTP inspection bridge. Bound to a random port via
 * `.listen(0)` so multiple preview instances on the same machine never
 * collide. The port is published into the per-worktree lockfile so
 * external tools can discover it.
 *
 * No auth: localhost-bound is the boundary. Production builds drop this
 * entire module via `__KANGENTIC_DEV__` dead-code elimination, so the
 * server cannot be enabled in shipped binaries.
 *
 * Endpoint dispatch is a flat `if/else` ladder rather than a router
 * library - the surface is small enough that the explicit form is
 * easier to grep than a registration DSL.
 */

interface InspectionServerOptions {
  getMainWindow: () => BrowserWindow | null;
  getEvalEnabled: () => boolean;
  getSessionManager: () => SessionManager | null;
  getProjectRoot: () => string | null;
}

let server: http.Server | null = null;
let boundPort: number | null = null;
let activeOptions: InspectionServerOptions | null = null;

export async function startInspectionServer(
  options: InspectionServerOptions,
): Promise<number | null> {
  if (server !== null) return boundPort;
  activeOptions = options;

  const httpServer = http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      respondError(response, 500, 'internal-error', error instanceof Error ? error.message : String(error));
    });
  });

  return new Promise((resolve) => {
    httpServer.on('error', () => {
      server = null;
      boundPort = null;
      resolve(null);
    });
    httpServer.listen(0, '127.0.0.1', () => {
      const address = httpServer.address();
      if (typeof address === 'object' && address !== null && 'port' in address) {
        server = httpServer;
        boundPort = address.port;
        resolve(boundPort);
      } else {
        resolve(null);
      }
    });
  });
}

export function stopInspectionServer(): void {
  if (server) {
    try {
      server.close();
    } catch {
      // best-effort
    }
    server = null;
    boundPort = null;
    activeOptions = null;
  }
}

async function handleRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  const options = activeOptions;
  if (!options) {
    return respondError(response, 503, 'not-installed', 'Inspection server is not active.');
  }
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const method = request.method ?? 'GET';
  const route = `${method} ${url.pathname}`;

  if (route === 'GET /info') {
    return respondJson(response, 200, buildInfo(options));
  }

  if (route === 'GET /process-metrics') {
    return respondJson(response, 200, getProcessMetrics());
  }

  if (route === 'GET /logs') {
    return respondLogs(options, url, response);
  }

  if (route === 'GET /crashes') {
    return respondCrashes(options, url, response);
  }

  if (route === 'GET /ipc-log') {
    return respondIpcLog(options, url, response);
  }

  if (route === 'GET /engine-state') {
    return respondEngineState(options, url, response);
  }

  if (route === 'GET /renderer-state') {
    return respondRendererState(options, response);
  }

  if (route === 'GET /console') {
    return respondConsole(options, url, response);
  }

  // CDP-backed endpoints from this point on need a main window AND an
  // attached debugger. The debugger can be externally detached at any
  // time (most commonly: the user opened DevTools, which steals the
  // connection). Fail fast with an actionable error instead of letting
  // each endpoint reject with a generic "not attached" message.
  const window = options.getMainWindow();
  if (!window) {
    return respondError(response, 503, 'no-main-window', 'Main window is not available yet.');
  }
  if (!isDebuggerAttached(window)) {
    return respondError(
      response,
      503,
      'cdp-not-attached',
      'Chrome DevTools Protocol is not currently attached to the main window. Close DevTools (if open) and toggle Settings -> Developer -> Preview Inspection Server off and on to re-attach.',
    );
  }

  if (route === 'GET /screenshot') {
    return respondScreenshot(window, url, response);
  }

  if (route === 'GET /screenshot-element') {
    return respondScreenshotElement(window, url, response);
  }

  if (route === 'GET /dom') {
    return respondDom(window, url, response);
  }

  if (route === 'GET /computed-style') {
    return respondComputedStyle(window, url, response);
  }

  if (route === 'GET /bounding-box') {
    return respondBoundingBox(window, url, response);
  }

  if (route === 'GET /accessibility-tree') {
    const tree = await getAccessibilityTree(window);
    return respondJson(response, 200, tree ?? { nodes: [] });
  }

  if (route === 'GET /react-component') {
    return respondReactComponent(window, url, response);
  }

  if (route === 'GET /react-tree') {
    return respondReactTree(window, url, response);
  }

  if (route === 'GET /react-recent-renders') {
    return respondReactRecentRenders(window, url, response);
  }

  if (route === 'GET /mutations') {
    return respondMutations(window, url, response);
  }

  if (method === 'POST') {
    return handlePostRequest(route, options, window, request, response);
  }

  return respondError(response, 404, 'unknown-route', route);
}

async function handlePostRequest(
  route: string,
  options: InspectionServerOptions,
  window: BrowserWindow,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  const body = await readJsonBody(request);
  if (body === null) {
    return respondError(response, 400, 'invalid-json', 'Request body must be valid JSON.');
  }

  if (route === 'POST /click') {
    return respondClick(window, body, response);
  }

  if (route === 'POST /type') {
    return respondType(window, body, response);
  }

  if (route === 'POST /keypress') {
    return respondKeypress(window, body, response);
  }

  if (route === 'POST /drag') {
    return respondDrag(window, body, response);
  }

  if (route === 'POST /wait') {
    return respondWait(window, body, response);
  }

  if (route === 'POST /script') {
    return respondScript(options, window, body, response);
  }

  if (route === 'POST /pty-input') {
    return respondPtyInput(options, body, response);
  }

  if (route === 'POST /eval') {
    if (!options.getEvalEnabled()) {
      return respondError(
        response,
        403,
        'eval-disabled',
        'Settings → Developer → Allow Eval is off.',
      );
    }
    return respondEval(window, body, response);
  }

  if (route === 'POST /inject-session-event') {
    if (!options.getEvalEnabled()) {
      return respondError(
        response,
        403,
        'eval-disabled',
        'Settings → Developer → Allow Eval is off (gates session-event injection).',
      );
    }
    return respondInjectSessionEvent(options, body, response);
  }

  return respondError(response, 404, 'unknown-route', route);
}

// ---------------------------------------------------------------------------
// /info
// ---------------------------------------------------------------------------

function buildInfo(options: InspectionServerOptions): Record<string, unknown> {
  const sessionManager = options.getSessionManager();
  const sessionIds = sessionManager
    ? sessionManager.listSessions().map((session) => session.id)
    : [];
  return {
    pid: process.pid,
    port: boundPort ?? 0,
    sessionIds,
    ts: new Date().toISOString(),
    evalEnabled: options.getEvalEnabled(),
    mainWindowAttached: options.getMainWindow() !== null,
    kangenticVersion: app.getVersion(),
    worktreePath: options.getProjectRoot() ?? null,
  };
}

// ---------------------------------------------------------------------------
// Product diagnostics passthroughs
// ---------------------------------------------------------------------------

interface JsonLineFilter {
  since?: string;
  level?: string;
  source?: string;
  channel?: string;
  limit: number;
}

function respondLogs(
  options: InspectionServerOptions,
  url: URL,
  response: http.ServerResponse,
): void {
  const projectRoot = options.getProjectRoot();
  if (!projectRoot) {
    return respondJson(response, 200, []);
  }
  const date = url.searchParams.get('date') ?? today();
  const filter: JsonLineFilter = {
    since: url.searchParams.get('since') ?? undefined,
    level: url.searchParams.get('level') ?? undefined,
    source: url.searchParams.get('source') ?? undefined,
    limit: clampLimit(url.searchParams.get('limit'), 200, 2000),
  };
  const file = path.join(projectRoot, '.kangentic', 'logs', `${date}.log`);
  const entries = readJsonLines<Record<string, unknown>>(file);
  const filtered = entries.filter((entry) => {
    if (filter.since && typeof entry.ts === 'string' && entry.ts < filter.since) return false;
    if (filter.level && entry.level !== filter.level) return false;
    if (filter.source && entry.source !== filter.source) return false;
    return true;
  });
  respondJson(response, 200, filtered.slice(-filter.limit));
}

function respondCrashes(
  options: InspectionServerOptions,
  url: URL,
  response: http.ServerResponse,
): void {
  const projectRoot = options.getProjectRoot();
  if (!projectRoot) return respondJson(response, 200, []);
  const directory = path.join(projectRoot, '.kangentic', 'logs', 'crashes');
  let files: string[];
  try {
    files = fs.readdirSync(directory).filter((name) => name.endsWith('.json'));
  } catch {
    return respondJson(response, 200, []);
  }
  files.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const since = url.searchParams.get('since') ?? undefined;
  const limit = clampLimit(url.searchParams.get('limit'), 10, 50);
  const records: unknown[] = [];
  for (const name of files) {
    if (records.length >= limit) break;
    try {
      const raw = fs.readFileSync(path.join(directory, name), 'utf-8');
      const record = JSON.parse(raw) as { ts?: string };
      if (since && record.ts && record.ts < since) continue;
      records.push(record);
    } catch {
      // Skip corrupt file
    }
  }
  respondJson(response, 200, records);
}

function respondIpcLog(
  options: InspectionServerOptions,
  url: URL,
  response: http.ServerResponse,
): void {
  const projectRoot = options.getProjectRoot();
  if (!projectRoot) return respondJson(response, 200, []);
  const date = url.searchParams.get('date') ?? today();
  const filter: JsonLineFilter = {
    since: url.searchParams.get('since') ?? undefined,
    channel: url.searchParams.get('channel') ?? undefined,
    limit: clampLimit(url.searchParams.get('limit'), 200, 2000),
  };
  const file = path.join(projectRoot, '.kangentic', 'logs', `ipc-${date}.jsonl`);
  const entries = readJsonLines<Record<string, unknown>>(file);
  const filtered = entries.filter((entry) => {
    if (filter.since && typeof entry.ts === 'string' && entry.ts < filter.since) return false;
    if (filter.channel && entry.channel !== filter.channel) return false;
    return true;
  });
  respondJson(response, 200, filtered.slice(-filter.limit));
}

// ---------------------------------------------------------------------------
// Engine state (live, in-memory)
// ---------------------------------------------------------------------------

function respondEngineState(
  options: InspectionServerOptions,
  url: URL,
  response: http.ServerResponse,
): void {
  const sessionManager = options.getSessionManager();
  if (!sessionManager) {
    return respondError(response, 503, 'no-session-manager', 'SessionManager is not available.');
  }
  // SessionManager exposes the active engine via session-manager + telemetry
  // accessors. We surface the per-session ActivityStatsSnapshot through the
  // existing IPC channels (session:getActivityStats); reuse the same code
  // path here by reaching into the telemetry directly. Defensive null
  // checks keep this resilient to API drift.
  type EngineHolder = {
    telemetry?: { activityEngine?: { getStatsSnapshot(id: string): unknown } };
  };
  const holder = sessionManager as unknown as EngineHolder;
  const engine = holder.telemetry?.activityEngine;
  if (!engine || typeof engine.getStatsSnapshot !== 'function') {
    return respondError(response, 503, 'no-engine', 'Activity engine is not exposed.');
  }
  const sessionIdParam = url.searchParams.get('sessionId');
  if (sessionIdParam) {
    return respondJson(response, 200, engine.getStatsSnapshot(sessionIdParam));
  }
  const out: Record<string, unknown> = {};
  for (const session of sessionManager.listSessions()) {
    out[session.id] = engine.getStatsSnapshot(session.id);
  }
  respondJson(response, 200, out);
}

// ---------------------------------------------------------------------------
// Renderer state (Runtime.evaluate'd window globals)
// ---------------------------------------------------------------------------

async function respondRendererState(
  options: InspectionServerOptions,
  response: http.ServerResponse,
): Promise<void> {
  const window = options.getMainWindow();
  if (!window) {
    return respondError(response, 503, 'no-main-window', 'Main window is not available yet.');
  }
  const result = await runtimeEvaluate(
    window,
    `(() => {
      const builder = window.__kangenticPreviewSnapshot;
      if (typeof builder !== 'function') return null;
      try {
        return builder();
      } catch (error) {
        return { error: String(error) };
      }
    })()`,
  );
  if (result.error) {
    return respondError(response, 500, 'evaluate-failed', result.error);
  }
  if (result.value === null) {
    return respondError(
      response,
      503,
      'mirror-not-installed',
      'window.__kangenticPreviewSnapshot is not installed yet.',
    );
  }
  respondJson(response, 200, result.value);
}

function respondConsole(
  options: InspectionServerOptions,
  url: URL,
  response: http.ServerResponse,
): void {
  const window = options.getMainWindow();
  if (!window) return respondJson(response, 200, []);
  const since = url.searchParams.get('since') ?? undefined;
  const level = url.searchParams.get('level') ?? undefined;
  const limit = clampLimit(url.searchParams.get('limit'), 100, 500);
  const entries = getConsoleEntries(window).filter((entry) => {
    if (since && entry.ts < since) return false;
    if (level && level !== 'all' && entry.level !== level) return false;
    return true;
  });
  respondJson(response, 200, entries.slice(-limit));
}

// ---------------------------------------------------------------------------
// CDP-backed endpoints
// ---------------------------------------------------------------------------

async function respondScreenshot(
  window: BrowserWindow,
  url: URL,
  response: http.ServerResponse,
): Promise<void> {
  const format = (url.searchParams.get('format') as 'png' | 'jpeg' | null) ?? 'png';
  const qualityParam = url.searchParams.get('quality');
  const quality = qualityParam ? Number.parseInt(qualityParam, 10) : undefined;
  const fullPage = url.searchParams.get('fullPage') === 'true';
  const data = await captureScreenshot(window, { format, quality, fullPage });
  if (!data) {
    return respondError(response, 500, 'screenshot-failed', 'Page.captureScreenshot returned no data.');
  }
  respondJson(response, 200, { format, base64: data });
}

async function respondScreenshotElement(
  window: BrowserWindow,
  url: URL,
  response: http.ServerResponse,
): Promise<void> {
  const selector = url.searchParams.get('selector');
  if (!selector) {
    return respondError(response, 400, 'missing-selector', 'selector query parameter is required.');
  }
  const box = await getBoundingBox(window, selector);
  if (!box || !Array.isArray(box.content) || box.content.length < 8) {
    return respondError(response, 404, 'selector-not-found', `No element matched ${selector}.`);
  }
  // BoxModel `content` is a quad: [x0,y0, x1,y1, x2,y2, x3,y3]
  const xs = [box.content[0], box.content[2], box.content[4], box.content[6]];
  const ys = [box.content[1], box.content[3], box.content[5], box.content[7]];
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  const data = await captureScreenshot(window, {
    format: 'png',
    clip: { x: minX, y: minY, width: maxX - minX, height: maxY - minY, scale: 1 },
  });
  if (!data) {
    return respondError(response, 500, 'screenshot-failed', 'Element clip capture returned no data.');
  }
  respondJson(response, 200, { format: 'png', base64: data });
}

async function respondDom(
  window: BrowserWindow,
  url: URL,
  response: http.ServerResponse,
): Promise<void> {
  const selector = url.searchParams.get('selector') ?? 'html';
  const html = await getOuterHtml(window, selector);
  if (html === null) {
    return respondError(response, 404, 'selector-not-found', `No element matched ${selector}.`);
  }
  respondJson(response, 200, { selector, outerHTML: html });
}

async function respondComputedStyle(
  window: BrowserWindow,
  url: URL,
  response: http.ServerResponse,
): Promise<void> {
  const selector = url.searchParams.get('selector');
  if (!selector) {
    return respondError(response, 400, 'missing-selector', 'selector query parameter is required.');
  }
  const styles = await getComputedStyle(window, selector);
  if (!styles) {
    return respondError(response, 404, 'selector-not-found', `No element matched ${selector}.`);
  }
  respondJson(response, 200, { selector, computedStyle: styles });
}

async function respondBoundingBox(
  window: BrowserWindow,
  url: URL,
  response: http.ServerResponse,
): Promise<void> {
  const selector = url.searchParams.get('selector');
  if (!selector) {
    return respondError(response, 400, 'missing-selector', 'selector query parameter is required.');
  }
  const box = await getBoundingBox(window, selector);
  if (!box) {
    return respondError(response, 404, 'selector-not-found', `No element matched ${selector}.`);
  }
  respondJson(response, 200, { selector, ...box });
}

async function respondReactComponent(
  window: BrowserWindow,
  url: URL,
  response: http.ServerResponse,
): Promise<void> {
  const selector = url.searchParams.get('selector');
  if (!selector) {
    return respondError(response, 400, 'missing-selector', 'selector query parameter is required.');
  }
  const result = await runtimeEvaluate(
    window,
    `(() => {
      const bridge = window.__kangenticPreviewReact;
      if (!bridge || typeof bridge.query !== 'function') return null;
      try {
        return bridge.query(${JSON.stringify(selector)});
      } catch (error) {
        return { error: String(error) };
      }
    })()`,
  );
  if (result.error) return respondError(response, 500, 'evaluate-failed', result.error);
  if (result.value === null) {
    return respondError(
      response,
      503,
      'react-bridge-not-installed',
      'window.__kangenticPreviewReact is not installed yet.',
    );
  }
  respondJson(response, 200, result.value);
}

async function respondReactTree(
  window: BrowserWindow,
  url: URL,
  response: http.ServerResponse,
): Promise<void> {
  const rootSelector = url.searchParams.get('rootSelector') ?? 'body';
  const maxDepth = clampLimit(url.searchParams.get('maxDepth'), 6, 20);
  const result = await runtimeEvaluate(
    window,
    `(() => {
      const bridge = window.__kangenticPreviewReact;
      if (!bridge || typeof bridge.tree !== 'function') return null;
      return bridge.tree(${JSON.stringify(rootSelector)}, ${maxDepth});
    })()`,
  );
  if (result.error) return respondError(response, 500, 'evaluate-failed', result.error);
  respondJson(response, 200, result.value ?? null);
}

async function respondReactRecentRenders(
  window: BrowserWindow,
  url: URL,
  response: http.ServerResponse,
): Promise<void> {
  const limit = clampLimit(url.searchParams.get('limit'), 50, 100);
  const result = await runtimeEvaluate(
    window,
    `(() => {
      const bridge = window.__kangenticPreviewReact;
      if (!bridge || typeof bridge.recentRenders !== 'function') return [];
      return bridge.recentRenders(${limit});
    })()`,
  );
  if (result.error) return respondError(response, 500, 'evaluate-failed', result.error);
  respondJson(response, 200, result.value ?? []);
}

async function respondMutations(
  window: BrowserWindow,
  url: URL,
  response: http.ServerResponse,
): Promise<void> {
  const sinceMs = Number.parseInt(url.searchParams.get('sinceMs') ?? '5000', 10);
  const result = await runtimeEvaluate(
    window,
    `(() => {
      const bridge = window.__kangenticPreviewMutations;
      if (typeof bridge !== 'function') return [];
      return bridge(${Number.isFinite(sinceMs) ? sinceMs : 5000});
    })()`,
  );
  if (result.error) return respondError(response, 500, 'evaluate-failed', result.error);
  respondJson(response, 200, result.value ?? []);
}

// ---------------------------------------------------------------------------
// Interaction (POST /click /type /keypress /drag /wait /script)
// ---------------------------------------------------------------------------

interface ClickBody {
  selector?: string;
  x?: number;
  y?: number;
}

async function respondClick(
  window: BrowserWindow,
  body: unknown,
  response: http.ServerResponse,
): Promise<void> {
  const click = body as ClickBody;
  if (typeof click.selector === 'string') {
    const ok = await clickAtCenterOfSelector(window, click.selector);
    if (!ok) {
      return respondError(response, 404, 'selector-not-found', `No element matched ${click.selector}.`);
    }
    return respondJson(response, 200, { ok: true });
  }
  if (typeof click.x === 'number' && typeof click.y === 'number') {
    await dispatchMouseEvent(window, { type: 'mousePressed', x: click.x, y: click.y });
    await dispatchMouseEvent(window, { type: 'mouseReleased', x: click.x, y: click.y });
    return respondJson(response, 200, { ok: true });
  }
  return respondError(response, 400, 'missing-target', 'Provide either `selector` or both `x` and `y`.');
}

interface TypeBody {
  selector?: string;
  text: string;
  clearFirst?: boolean;
}

async function respondType(
  window: BrowserWindow,
  body: unknown,
  response: http.ServerResponse,
): Promise<void> {
  const params = body as TypeBody;
  if (typeof params.text !== 'string') {
    return respondError(response, 400, 'missing-text', '`text` is required.');
  }
  if (typeof params.selector === 'string') {
    const ok = await clickAtCenterOfSelector(window, params.selector);
    if (!ok) {
      return respondError(response, 404, 'selector-not-found', `No element matched ${params.selector}.`);
    }
    if (params.clearFirst) {
      await dispatchKeypress(window, 'Ctrl+a');
      await dispatchKeyEvent(window, { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      await dispatchKeyEvent(window, { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    }
  }
  await typeText(window, params.text);
  respondJson(response, 200, { ok: true });
}

interface KeypressBody {
  keys: string;
}

async function respondKeypress(
  window: BrowserWindow,
  body: unknown,
  response: http.ServerResponse,
): Promise<void> {
  const params = body as KeypressBody;
  if (typeof params.keys !== 'string') {
    return respondError(response, 400, 'missing-keys', '`keys` is required.');
  }
  const ok = await dispatchKeypress(window, params.keys);
  if (!ok) {
    return respondError(response, 400, 'unknown-key', `Could not parse key combo: ${params.keys}.`);
  }
  respondJson(response, 200, { ok: true });
}

interface DragBody {
  fromSelector: string;
  toSelector: string;
  steps?: number;
}

async function respondDrag(
  window: BrowserWindow,
  body: unknown,
  response: http.ServerResponse,
): Promise<void> {
  const params = body as DragBody;
  if (typeof params.fromSelector !== 'string' || typeof params.toSelector !== 'string') {
    return respondError(
      response,
      400,
      'missing-selectors',
      '`fromSelector` and `toSelector` are required.',
    );
  }
  const ok = await dragFromTo(window, params.fromSelector, params.toSelector, {
    steps: params.steps,
  });
  if (!ok) {
    return respondError(response, 404, 'selector-not-found', 'Drag source or target selector did not match.');
  }
  respondJson(response, 200, { ok: true });
}

interface WaitBody {
  selector?: string;
  domText?: string;
  timeoutMs?: number;
  intervalMs?: number;
}

async function respondWait(
  window: BrowserWindow,
  body: unknown,
  response: http.ServerResponse,
): Promise<void> {
  const params = body as WaitBody;
  const timeoutMs = clampNumber(params.timeoutMs, 30000, 60000);
  const intervalMs = clampNumber(params.intervalMs, 100, 1000);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (params.selector) {
      const html = await getOuterHtml(window, params.selector);
      if (html !== null) {
        if (!params.domText || html.includes(params.domText)) {
          return respondJson(response, 200, { ok: true, matchedAt: new Date().toISOString() });
        }
      }
    } else if (params.domText) {
      const html = await getOuterHtml(window, 'body');
      if (html !== null && html.includes(params.domText)) {
        return respondJson(response, 200, { ok: true, matchedAt: new Date().toISOString() });
      }
    } else {
      return respondError(response, 400, 'missing-condition', 'Provide either `selector` or `domText`.');
    }
    await sleep(intervalMs);
  }
  respondError(response, 408, 'timeout', `Condition not met within ${timeoutMs}ms.`);
}

interface ScriptStep {
  type: 'click' | 'type' | 'keypress' | 'drag' | 'wait' | 'screenshot' | 'eval';
  [key: string]: unknown;
}

async function respondScript(
  options: InspectionServerOptions,
  window: BrowserWindow,
  body: unknown,
  response: http.ServerResponse,
): Promise<void> {
  const params = body as { steps?: ScriptStep[]; abortOnError?: boolean };
  if (!Array.isArray(params.steps)) {
    return respondError(response, 400, 'missing-steps', '`steps` array is required.');
  }
  const trace: { index: number; type: string; ok: boolean; durationMs: number; error?: string }[] = [];
  for (let stepIndex = 0; stepIndex < params.steps.length; stepIndex++) {
    const step = params.steps[stepIndex];
    const stepStart = performance.now();
    try {
      await runScriptStep(options, window, step);
      trace.push({ index: stepIndex, type: step.type, ok: true, durationMs: performance.now() - stepStart });
    } catch (error) {
      trace.push({
        index: stepIndex,
        type: step.type,
        ok: false,
        durationMs: performance.now() - stepStart,
        error: error instanceof Error ? error.message : String(error),
      });
      if (params.abortOnError !== false) break;
    }
  }
  respondJson(response, 200, { trace });
}

async function runScriptStep(
  options: InspectionServerOptions,
  window: BrowserWindow,
  step: ScriptStep,
): Promise<void> {
  switch (step.type) {
    case 'click': {
      const selector = step.selector as string | undefined;
      if (!selector) throw new Error('click step requires `selector`.');
      const ok = await clickAtCenterOfSelector(window, selector);
      if (!ok) throw new Error(`No element matched ${selector}.`);
      return;
    }
    case 'type': {
      const text = step.text as string | undefined;
      if (typeof text !== 'string') throw new Error('type step requires `text`.');
      const selector = step.selector as string | undefined;
      if (selector) {
        const focused = await clickAtCenterOfSelector(window, selector);
        if (!focused) throw new Error(`No element matched ${selector}.`);
      }
      await typeText(window, text);
      return;
    }
    case 'keypress': {
      const keys = step.keys as string | undefined;
      if (!keys) throw new Error('keypress step requires `keys`.');
      const ok = await dispatchKeypress(window, keys);
      if (!ok) throw new Error(`Unknown key combo: ${keys}.`);
      return;
    }
    case 'drag': {
      const fromSelector = step.fromSelector as string | undefined;
      const toSelector = step.toSelector as string | undefined;
      if (!fromSelector || !toSelector) throw new Error('drag step requires `fromSelector` + `toSelector`.');
      const ok = await dragFromTo(window, fromSelector, toSelector);
      if (!ok) throw new Error('drag selectors did not match.');
      return;
    }
    case 'wait': {
      const ms = clampNumber(step.ms as number | undefined, 250, 30000);
      await sleep(ms);
      return;
    }
    case 'screenshot': {
      // Returned as part of the trace would balloon the response; the
      // /screenshot endpoint exists for the actual capture. This step
      // exists so a script can fail loudly when an expected screenshot
      // step is reachable but the agent forgot to follow it up.
      return;
    }
    case 'eval': {
      if (!options.getEvalEnabled()) throw new Error('eval step requires `previewEvalEnabled`.');
      const expression = step.expression as string | undefined;
      if (typeof expression !== 'string') throw new Error('eval step requires `expression`.');
      const result = await runtimeEvaluate(window, expression);
      if (result.error) throw new Error(result.error);
      return;
    }
    default:
      throw new Error(`Unknown step type: ${step.type}.`);
  }
}

interface PtyInputBody {
  sessionId: string;
  keys?: string;
  bytes?: string;
}

async function respondPtyInput(
  options: InspectionServerOptions,
  body: unknown,
  response: http.ServerResponse,
): Promise<void> {
  const params = body as PtyInputBody;
  const sessionManager = options.getSessionManager();
  if (!sessionManager) {
    return respondError(response, 503, 'no-session-manager', 'SessionManager is not available.');
  }
  if (typeof params.sessionId !== 'string') {
    return respondError(response, 400, 'missing-sessionId', '`sessionId` is required.');
  }
  let toWrite: string | null = null;
  if (typeof params.keys === 'string') {
    toWrite = mapKeysToBytes(params.keys);
  } else if (typeof params.bytes === 'string') {
    if (!options.getEvalEnabled()) {
      return respondError(
        response,
        403,
        'eval-disabled',
        'Raw `bytes` form requires Settings → Developer → Allow Eval.',
      );
    }
    toWrite = Buffer.from(params.bytes, 'base64').toString('utf-8');
  } else {
    return respondError(response, 400, 'missing-input', 'Provide `keys` or `bytes`.');
  }
  if (toWrite === null) {
    return respondError(response, 400, 'unknown-keys', `Could not map keys: ${params.keys}.`);
  }
  type SessionWriter = { write(sessionId: string, data: string): void | boolean };
  const writer = sessionManager as unknown as SessionWriter;
  if (typeof writer.write !== 'function') {
    return respondError(response, 503, 'no-writer', 'SessionManager.write is not exposed.');
  }
  writer.write(params.sessionId, toWrite);
  respondJson(response, 200, { ok: true });
}

function mapKeysToBytes(keys: string): string | null {
  const map: Record<string, string> = {
    Enter: '\r',
    Escape: '\x1b',
    Tab: '\t',
    Backspace: '\x7f',
    'Ctrl+C': '\x03',
    'Ctrl+D': '\x04',
    Up: '\x1b[A',
    Down: '\x1b[B',
    Left: '\x1b[D',
    Right: '\x1b[C',
  };
  if (map[keys]) return map[keys];
  // Unknown chord: treat as literal text (the caller probably wants that).
  return keys;
}

interface EvalBody {
  expression: string;
}

async function respondEval(
  window: BrowserWindow,
  body: unknown,
  response: http.ServerResponse,
): Promise<void> {
  const params = body as EvalBody;
  if (typeof params.expression !== 'string') {
    return respondError(response, 400, 'missing-expression', '`expression` is required.');
  }
  const result = await runtimeEvaluate(window, params.expression);
  if (result.error) return respondError(response, 500, 'evaluate-failed', result.error);
  respondJson(response, 200, { value: result.value });
}

interface InjectSessionEventBody {
  sessionId: string;
  event: unknown;
}

function respondInjectSessionEvent(
  options: InspectionServerOptions,
  body: unknown,
  response: http.ServerResponse,
): void {
  const params = body as InjectSessionEventBody;
  const sessionManager = options.getSessionManager();
  if (!sessionManager) {
    return respondError(response, 503, 'no-session-manager', 'SessionManager is not available.');
  }
  type EventInjector = {
    telemetry?: { ingestEvents(sessionId: string, events: unknown[]): void };
  };
  const injector = sessionManager as unknown as EventInjector;
  if (typeof injector.telemetry?.ingestEvents !== 'function') {
    return respondError(response, 503, 'no-injector', 'telemetry.ingestEvents is not exposed.');
  }
  if (typeof params.sessionId !== 'string' || params.event === undefined) {
    return respondError(response, 400, 'missing-fields', '`sessionId` and `event` are required.');
  }
  injector.telemetry.ingestEvents(params.sessionId, [params.event]);
  respondJson(response, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readJsonBody(request: http.IncomingMessage): Promise<unknown | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(null);
      }
    });
    request.on('error', () => resolve(null));
  });
}

function readJsonLines<T>(filePath: string): T[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // skip corrupt
    }
  }
  return out;
}

function respondJson(
  response: http.ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(body));
}

function respondError(
  response: http.ServerResponse,
  statusCode: number,
  kind: string,
  detail: string,
): void {
  respondJson(response, statusCode, { ok: false, error: { kind, detail } });
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function clampLimit(value: string | null, defaultValue: number, max: number): number {
  if (!value) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return Math.min(parsed, max);
}

function clampNumber(value: number | undefined, defaultValue: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return defaultValue;
  return Math.min(value, max);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
