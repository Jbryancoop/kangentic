import * as http from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { enumeratePreviewInstances } from '../main/instances';
import { readLockfile, isLockfilePidAlive } from '../main/lockfile';
import type { PreviewInstanceRecord } from '../shared/types';

/**
 * Dev-only MCP tools that wrap the localhost inspection bridge. Each
 * tool resolves a preview instance via its lockfile, calls the bridge's
 * HTTP endpoint over 127.0.0.1, and returns the response as the tool's
 * single text content block.
 *
 * Tool naming: every tool starts with `kangentic_devtools_` so the
 * dev-only surface is clearly separable from the product MCP tools
 * (`kangentic_*`) that ship in all builds.
 *
 * Instance resolution: each tool accepts an optional `instanceId` which
 * matches `WorktreePath`. When omitted, the tool defaults to the only
 * running responding instance and returns a structured error when
 * multiple are running (so the agent picks deliberately).
 *
 * Error envelope: every tool returns either
 *   { content: [{ type: 'text', text: <success body or stringified data> }] }
 * or
 *   { content: [{ type: 'text', text: '...' }], isError: true }
 * The error text is a JSON-encoded `{ kind, detail }` shape so callers
 * can program against it.
 */

const DEFAULT_TIMEOUT_MS = 5000;

interface CallBridgeOptions {
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  instanceId?: string;
  timeoutMs?: number;
}

interface BridgeSuccess {
  ok: true;
  data: unknown;
}

interface BridgeFailure {
  ok: false;
  error: { kind: string; detail: string };
}

type BridgeResult = BridgeSuccess | BridgeFailure;

/**
 * Resolve a preview instance by its `worktreePath` (the stable id).
 * When `instanceId` is omitted, picks the unique responding instance
 * and errors when there are 0 or >1.
 */
async function resolveInstance(
  instanceId: string | undefined,
): Promise<{ port: number } | BridgeFailure> {
  if (instanceId) {
    const lockfile = readLockfile(instanceId);
    if (!lockfile) {
      return {
        ok: false,
        error: {
          kind: 'no-lockfile',
          detail: `No preview lockfile found at ${instanceId}/.kangentic/preview.lock.`,
        },
      };
    }
    if (!isLockfilePidAlive(lockfile)) {
      return {
        ok: false,
        error: {
          kind: 'stale-lockfile',
          detail: `Lockfile at ${instanceId} references PID ${lockfile.pid} which is no longer running.`,
        },
      };
    }
    return { port: lockfile.port };
  }

  const instances = await enumeratePreviewInstances();
  const responding = instances.filter((entry) => entry.lockfileStatus === 'responding');
  if (responding.length === 0) {
    return {
      ok: false,
      error: {
        kind: 'no-instance',
        detail: 'No responding preview instance. Make sure a kangentic dev session is running and `developer.previewInspectionServer` is on.',
      },
    };
  }
  if (responding.length > 1) {
    return {
      ok: false,
      error: {
        kind: 'multiple-instances',
        detail: `${responding.length} responding instances found. Pass instanceId (worktreePath) to disambiguate. Candidates: ${responding
          .map((entry: PreviewInstanceRecord) => entry.path)
          .join(', ')}.`,
      },
    };
  }
  return { port: responding[0].lockfile!.port };
}

async function callBridge(options: CallBridgeOptions): Promise<BridgeResult> {
  const resolved = await resolveInstance(options.instanceId);
  if ('ok' in resolved && resolved.ok === false) return resolved;
  const port = (resolved as { port: number }).port;
  const queryString = options.query
    ? '?' +
      new URLSearchParams(
        Object.fromEntries(
          Object.entries(options.query)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => [key, String(value)]),
        ),
      ).toString()
    : '';
  const body = options.body !== undefined ? JSON.stringify(options.body) : undefined;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `${options.path}${queryString}`,
        method: options.method,
        timeout: timeoutMs,
        headers: body
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
          : undefined,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let parsed: unknown;
          try {
            parsed = raw.trim() ? JSON.parse(raw) : null;
          } catch {
            parsed = raw;
          }
          if (response.statusCode && response.statusCode >= 400) {
            const detail =
              parsed && typeof parsed === 'object' && parsed !== null && 'error' in parsed
                ? String((parsed as { error: { detail?: string } }).error?.detail ?? raw)
                : raw;
            resolve({
              ok: false,
              error: {
                kind: parsed && typeof parsed === 'object' && parsed !== null && 'error' in parsed
                  ? String((parsed as { error: { kind?: string } }).error?.kind ?? `http-${response.statusCode}`)
                  : `http-${response.statusCode}`,
                detail,
              },
            });
            return;
          }
          resolve({ ok: true, data: parsed });
        });
        response.on('error', (error) => {
          resolve({
            ok: false,
            error: { kind: 'response-error', detail: error.message },
          });
        });
      },
    );
    request.on('error', (error) => {
      resolve({ ok: false, error: { kind: 'request-error', detail: error.message } });
    });
    request.on('timeout', () => {
      request.destroy();
      resolve({
        ok: false,
        error: { kind: 'timeout', detail: `No response within ${timeoutMs}ms.` },
      });
    });
    if (body) request.write(body);
    request.end();
  });
}

function toolResult(result: BridgeResult): {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: true;
} {
  if (result.ok) {
    const text = typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2);
    const structured = toStructuredContent(result.data);
    return structured
      ? { content: [{ type: 'text', text }], structuredContent: structured }
      : { content: [{ type: 'text', text }] };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(result.error, null, 2) }],
    structuredContent: { error: result.error },
    isError: true,
  };
}

/**
 * MCP `structuredContent` is required to be an object (`{ [key: string]: unknown }`).
 * Wrap arrays under `items` so the LLM still gets typed JSON access; pass plain
 * objects through; skip primitives (text-only response is sufficient there).
 */
function toStructuredContent(data: unknown): Record<string, unknown> | null {
  if (data === null || data === undefined) return null;
  if (Array.isArray(data)) return { items: data };
  if (typeof data !== 'object') return null;
  return data as Record<string, unknown>;
}

/**
 * Standard annotations applied to read-only inspection tools. The LLM treats
 * tools with `readOnlyHint: true` and `idempotentHint: true` as safe to call
 * speculatively (e.g. parallel reads, retries) without worrying about side
 * effects.
 */
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
} as const;

/**
 * Annotations for tools that mutate UI / session / engine state. `readOnlyHint:
 * false` signals "this changes something visible"; `idempotentHint: false`
 * signals "calling twice is not the same as calling once" (e.g. clicking a
 * button advances state).
 */
const MUTATING_ANNOTATIONS = {
  readOnlyHint: false,
  idempotentHint: false,
} as const;

const INSTANCE_ARG_DESCRIPTION =
  'Optional instanceId - the absolute worktree path identifying the preview to target. Omit to use the single running instance; the call errors if more than one is running. Use kangentic_devtools_list_instances to discover instanceIds.';

export function registerDevtoolsPreviewTools(server: McpServer): void {
  // ── Discovery ────────────────────────────────────────────────────────
  server.registerTool(
    'kangentic_devtools_list_instances',
    {
      description:
        'Enumerate every kangentic worktree on this machine and report whether a /preview is currently bound to each. Each entry has worktree path, branch, dirty flag, lockfile presence, and lockfileStatus (responding | stale | absent). Use the worktree path as `instanceId` for any other devtools tool. Dev-only.',
      inputSchema: z.object({}),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      try {
        const instances = await enumeratePreviewInstances();
        return {
          content: [{ type: 'text', text: JSON.stringify(instances, null, 2) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  kind: 'enumerate-failed',
                  detail: error instanceof Error ? error.message : String(error),
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ── State ────────────────────────────────────────────────────────────
  server.registerTool(
    'kangentic_devtools_engine_state',
    {
      description:
        'Live ActivityStatsSnapshot for one or every running session in the inspected preview. Returns the in-memory engine state (counters, dominant reason, recent transitions) - strictly fresher than the disk dump. Dev-only.',
      inputSchema: z.object({
        sessionId: z.string().optional().describe('Limit to one session. Omit for all sessions.'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ sessionId, instanceId }) =>
      toolResult(
        await callBridge({
          method: 'GET',
          path: '/engine-state',
          query: { sessionId },
          instanceId,
        }),
      ),
  );

  server.registerTool(
    'kangentic_devtools_renderer_state',
    {
      description:
        'Aggregated Zustand snapshot for the inspected preview: board, session, project, config, backlog, toast, transient, scroll, focus, plus ring buffers (recentToasts, dialogHistory, recentIpcErrors). Useful for "what does the renderer currently think is true". Dev-only.',
      inputSchema: z.object({
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ instanceId }) =>
      toolResult(await callBridge({ method: 'GET', path: '/renderer-state', instanceId })),
  );

  // ── Visual / DOM ─────────────────────────────────────────────────────
  server.registerTool(
    'kangentic_devtools_screenshot',
    {
      description:
        'Capture a PNG screenshot of the inspected preview window. Returns base64-encoded image bytes. Use kangentic_devtools_screenshot_element for a clipped capture of one element. Dev-only.',
      inputSchema: z.object({
        format: z.enum(['png', 'jpeg']).optional().describe('Image format. Default png.'),
        quality: z.number().int().min(1).max(100).optional().describe('JPEG quality 1-100. Ignored for PNG.'),
        fullPage: z.boolean().optional().describe('Capture beyond the viewport. Default false.'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ format, quality, fullPage, instanceId }) =>
      toolResult(
        await callBridge({
          method: 'GET',
          path: '/screenshot',
          query: { format, quality, fullPage: fullPage ? 'true' : undefined },
          instanceId,
          timeoutMs: 10000,
        }),
      ),
  );

  server.registerTool(
    'kangentic_devtools_screenshot_element',
    {
      description:
        'Capture a PNG of just the element matching `selector`, clipped to its bounding box. Useful for visual debugging of a specific component without the surrounding chrome. Dev-only.',
      inputSchema: z.object({
        selector: z.string().describe('CSS selector. Defaults to clipping the matched element\'s box.'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ selector, instanceId }) =>
      toolResult(
        await callBridge({
          method: 'GET',
          path: '/screenshot-element',
          query: { selector },
          instanceId,
          timeoutMs: 10000,
        }),
      ),
  );

  server.registerTool(
    'kangentic_devtools_query_dom',
    {
      description:
        'Return the outer HTML of the first element matching `selector`. Useful to verify what is rendered: check whether a dialog opened, a button is enabled, an error banner is showing. Dev-only.',
      inputSchema: z.object({
        selector: z.string().describe('CSS selector.'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ selector, instanceId }) =>
      toolResult(
        await callBridge({ method: 'GET', path: '/dom', query: { selector }, instanceId }),
      ),
  );

  server.registerTool(
    'kangentic_devtools_computed_style',
    {
      description:
        'Return the full computed CSS style for the first element matching `selector`. Useful for "is this rendered but invisible?" debugging. Dev-only.',
      inputSchema: z.object({
        selector: z.string().describe('CSS selector.'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ selector, instanceId }) =>
      toolResult(
        await callBridge({
          method: 'GET',
          path: '/computed-style',
          query: { selector },
          instanceId,
        }),
      ),
  );

  server.registerTool(
    'kangentic_devtools_bounding_box',
    {
      description:
        'Return the layout box (content / padding / border / margin quads + width / height) of the first element matching `selector`. Dev-only.',
      inputSchema: z.object({
        selector: z.string().describe('CSS selector.'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ selector, instanceId }) =>
      toolResult(
        await callBridge({
          method: 'GET',
          path: '/bounding-box',
          query: { selector },
          instanceId,
        }),
      ),
  );

  server.registerTool(
    'kangentic_devtools_accessibility_tree',
    {
      description:
        'Return the full accessibility tree for the inspected preview window. Semantic structure (roles + names + values) - much smaller and easier to reason about than the raw DOM. Dev-only.',
      inputSchema: z.object({
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ instanceId }) =>
      toolResult(
        await callBridge({ method: 'GET', path: '/accessibility-tree', instanceId, timeoutMs: 10000 }),
      ),
  );

  server.registerTool(
    'kangentic_devtools_mutations',
    {
      description:
        'Return DOM mutations recorded in the last `sinceMs` milliseconds. Each mutation reports target (selector), kind (childList | attributes | characterData), counts of added / removed nodes. Useful for "what changed when I clicked X?". Dev-only.',
      inputSchema: z.object({
        sinceMs: z.number().int().positive().max(60000).optional().describe('Window in ms. Default 5000.'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ sinceMs, instanceId }) =>
      toolResult(
        await callBridge({
          method: 'GET',
          path: '/mutations',
          query: { sinceMs },
          instanceId,
        }),
      ),
  );

  // ── React inspection ─────────────────────────────────────────────────
  server.registerTool(
    'kangentic_devtools_react_query',
    {
      description:
        'Find the nearest React component to the DOM element matching `selector`, return its name, source `file:line:column` (where available), props (sanitized), hook values, and ancestor chain. Useful for "why is this component rendering wrong props?". Dev-only.',
      inputSchema: z.object({
        selector: z.string().describe('CSS selector for the DOM node to start the fiber walk from.'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ selector, instanceId }) =>
      toolResult(
        await callBridge({
          method: 'GET',
          path: '/react-component',
          query: { selector },
          instanceId,
        }),
      ),
  );

  server.registerTool(
    'kangentic_devtools_react_tree',
    {
      description:
        'Return a names-only tree of React components rooted at `rootSelector`. Useful for spotting "which component is mounted where". Dev-only.',
      inputSchema: z.object({
        rootSelector: z.string().optional().describe('CSS selector for the root. Default body.'),
        maxDepth: z.number().int().min(1).max(20).optional().describe('Recursion depth. Default 6.'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ rootSelector, maxDepth, instanceId }) =>
      toolResult(
        await callBridge({
          method: 'GET',
          path: '/react-tree',
          query: { rootSelector, maxDepth },
          instanceId,
        }),
      ),
  );

  server.registerTool(
    'kangentic_devtools_react_recent_renders',
    {
      description:
        'Return the most recent React commits captured by onCommitFiberRoot. Each entry has timestamp, root component name, source file (when available), and render duration. Useful for "what re-rendered when I did X?". Dev-only.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).optional().describe('Max entries. Default 50.'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ limit, instanceId }) =>
      toolResult(
        await callBridge({
          method: 'GET',
          path: '/react-recent-renders',
          query: { limit },
          instanceId,
        }),
      ),
  );

  // ── Console (CDP ring, separate from product log mirror) ──────────
  server.registerTool(
    'kangentic_devtools_console',
    {
      description:
        'Read the last N renderer Console messages captured by the CDP `Console.messageAdded` event. Separate from `kangentic_tail_logs` which reads the persistent product log file: the CDP ring is in-memory, lossy, and includes browser-emitted console messages that may not flow through console.*. Dev-only.',
      inputSchema: z.object({
        since: z.string().optional().describe('Filter to entries with ts >= since (ISO 8601).'),
        level: z
          .enum(['log', 'warn', 'error', 'info', 'debug', 'verbose', 'all'])
          .optional()
          .describe('Filter by level. Default all.'),
        limit: z.number().int().positive().max(500).optional().describe('Max entries. Default 100.'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ since, level, limit, instanceId }) =>
      toolResult(
        await callBridge({
          method: 'GET',
          path: '/console',
          query: { since, level, limit },
          instanceId,
        }),
      ),
  );

  // ── Drive (interaction) ──────────────────────────────────────────────
  server.registerTool(
    'kangentic_devtools_click',
    {
      description:
        'Dispatch a real mouse click. Either pass `selector` to click the centroid of the matched element, or pass `x` and `y` for absolute coordinates. Dev-only.',
      inputSchema: z.object({
        selector: z.string().optional().describe('CSS selector to click.'),
        x: z.number().optional().describe('Absolute X coordinate (alternative to selector).'),
        y: z.number().optional().describe('Absolute Y coordinate.'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ selector, x, y, instanceId }) =>
      toolResult(
        await callBridge({
          method: 'POST',
          path: '/click',
          body: { selector, x, y },
          instanceId,
        }),
      ),
  );

  server.registerTool(
    'kangentic_devtools_type',
    {
      description:
        'Type text into the focused field. Pass `selector` to focus + click first; pass `clearFirst: true` to Ctrl+A then Backspace before typing. Use kangentic_devtools_keypress for chord shortcuts. Dev-only.',
      inputSchema: z.object({
        selector: z.string().optional().describe('CSS selector to focus before typing.'),
        text: z.string().describe('Literal text to type.'),
        clearFirst: z.boolean().optional().describe('Clear the field before typing. Default false.'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ selector, text, clearFirst, instanceId }) =>
      toolResult(
        await callBridge({
          method: 'POST',
          path: '/type',
          body: { selector, text, clearFirst },
          instanceId,
        }),
      ),
  );

  server.registerTool(
    'kangentic_devtools_keypress',
    {
      description:
        'Dispatch a keyboard chord like `Ctrl+Shift+P`, `Escape`, `Enter`, `Tab`, `ArrowUp`, etc. Modifiers: Ctrl, Shift, Alt, Meta (alias Cmd). Single-character keys like `a` work. Dev-only.',
      inputSchema: z.object({
        keys: z.string().describe('Key combo (e.g. "Ctrl+Shift+P", "Escape").'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ keys, instanceId }) =>
      toolResult(
        await callBridge({ method: 'POST', path: '/keypress', body: { keys }, instanceId }),
      ),
  );

  server.registerTool(
    'kangentic_devtools_drag',
    {
      description:
        'Simulate a drag: press at the centroid of `fromSelector`, smooth-move through `steps` intermediate positions to the centroid of `toSelector`, release. Use this to drag tasks between columns or reorder items. Dev-only.',
      inputSchema: z.object({
        fromSelector: z.string().describe('CSS selector of the element to drag from.'),
        toSelector: z.string().describe('CSS selector of the drop target.'),
        steps: z.number().int().min(2).max(50).optional().describe('Number of intermediate mouseMove events. Default 10.'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ fromSelector, toSelector, steps, instanceId }) =>
      toolResult(
        await callBridge({
          method: 'POST',
          path: '/drag',
          body: { fromSelector, toSelector, steps },
          instanceId,
        }),
      ),
  );

  server.registerTool(
    'kangentic_devtools_wait',
    {
      description:
        'Block until a selector resolves, contains `domText`, or the timeout elapses. Replaces "click then poll DOM 5 times" round-trips with one server-side wait. Dev-only.',
      inputSchema: z.object({
        selector: z.string().optional().describe('CSS selector that must resolve.'),
        domText: z.string().optional().describe('Substring that must appear in the DOM (or in selector, when both are given).'),
        timeoutMs: z.number().int().positive().max(60000).optional().describe('Hard timeout. Default 30000.'),
        intervalMs: z.number().int().min(50).max(1000).optional().describe('Polling cadence. Default 100.'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ selector, domText, timeoutMs, intervalMs, instanceId }) =>
      toolResult(
        await callBridge({
          method: 'POST',
          path: '/wait',
          body: { selector, domText, timeoutMs, intervalMs },
          instanceId,
          timeoutMs: (timeoutMs ?? 30000) + 1000,
        }),
      ),
  );

  server.registerTool(
    'kangentic_devtools_script',
    {
      description:
        'Execute an array of UI steps in order against the inspected preview. Each step: { type: "click" | "type" | "keypress" | "drag" | "wait" | "screenshot" | "eval", ...stepArgs }. Returns a step-by-step trace with ok/durationMs/error. Cuts MCP latency dramatically vs. one tool call per step. Dev-only.',
      inputSchema: z.object({
        steps: z
          .array(
            z.object({
              type: z.enum(['click', 'type', 'keypress', 'drag', 'wait', 'screenshot', 'eval']),
              selector: z.string().optional(),
              text: z.string().optional(),
              keys: z.string().optional(),
              fromSelector: z.string().optional(),
              toSelector: z.string().optional(),
              ms: z.number().int().positive().optional(),
              expression: z.string().optional(),
            }),
          )
          .describe('Ordered step list.'),
        abortOnError: z.boolean().optional().describe('Stop on the first failed step. Default true.'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ steps, abortOnError, instanceId }) =>
      toolResult(
        await callBridge({
          method: 'POST',
          path: '/script',
          body: { steps, abortOnError },
          instanceId,
          timeoutMs: 60000,
        }),
      ),
  );

  // ── Sessions ─────────────────────────────────────────────────────────
  server.registerTool(
    'kangentic_devtools_pty_input',
    {
      description:
        'Send input to a session\'s PTY. `keys` accepts named-key vocabulary (Enter, Escape, Tab, Backspace, Ctrl+C, Ctrl+D, Up, Down, Left, Right) plus literal text. `bytes` (base64) requires `developer.previewEvalEnabled` and writes raw bytes verbatim. Use for typing into the Claude TUI inside a session. Dev-only.',
      inputSchema: z.object({
        sessionId: z.string().describe('Kangentic session id (UUID).'),
        keys: z.string().optional().describe('Named key or literal text (XOR with bytes).'),
        bytes: z.string().optional().describe('Base64-encoded raw bytes. Requires Allow Eval setting.'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ sessionId, keys, bytes, instanceId }) =>
      toolResult(
        await callBridge({
          method: 'POST',
          path: '/pty-input',
          body: { sessionId, keys, bytes },
          instanceId,
        }),
      ),
  );

  server.registerTool(
    'kangentic_devtools_inject_session_event',
    {
      description:
        'Synthesize a SessionEvent and feed it into the activity engine without spawning a real CLI. Use for stress-testing engine state machines (Idle / Interrupted / TurnEnd) without orchestrating a full session. Requires `developer.previewEvalEnabled`. Dev-only.',
      inputSchema: z.object({
        sessionId: z.string().describe('Kangentic session id to target.'),
        event: z.unknown().describe('SessionEvent shape (see src/shared/types.ts).'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ sessionId, event, instanceId }) =>
      toolResult(
        await callBridge({
          method: 'POST',
          path: '/inject-session-event',
          body: { sessionId, event },
          instanceId,
        }),
      ),
  );
}
