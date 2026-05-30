import * as path from 'node:path';
import { ipcMain } from 'electron';
import type { IpcLogEntry } from '../../shared/types';
import { queueAppend } from './async-file-queue';

/**
 * Records every IPC handler invocation when `developer.recordIpcTraffic` is on.
 *
 * Implementation: monkey-patches `ipcMain.handle` once at install time, before
 * any handler registers. Each subsequent `ipcMain.handle(channel, fn)` call
 * gets the recorder injected automatically - no changes to the existing
 * handler files. Logs go to `<projectRoot>/.kangentic/logs/ipc-<date>.jsonl`.
 *
 * Privacy: this code can run with arbitrary task descriptions, prompts, and
 * settings flowing through. We default-deny: only channels in the
 * `SAFE_CHANNELS` allowlist log args + result in full. Everything else logs
 * `{ redacted: true, channel }`. Add to the allowlist as new diagnostic
 * channels arrive - never relax a redaction without auditing the payload.
 */

/**
 * Channels whose args + result are safe to log in full. These are read-only
 * surfaces that return board / session / task data already visible elsewhere
 * in the agent's context. Mutating channels (settings writes, attachment
 * uploads, MCP config writes) are deliberately omitted - their payloads can
 * carry secrets or large binary blobs.
 *
 * Synced manually with `src/shared/ipc-channels.ts`. New diagnostic /
 * read-only channels can be added; new mutating channels stay redacted.
 */
const SAFE_CHANNELS = new Set<string>([
  'project:list',
  'project:getCurrent',
  'projectGroup:list',
  'task:list',
  'task:list-archived',
  'swimlane:list',
  'session:list',
  'session:getActivity',
  'session:getActivityReason',
  'session:getActivityReasons',
  'session:getActivityStats',
  'session:getEvents',
  'session:getEventsCache',
  'session:getUsage',
  'session:getFirstOutput',
  'task:getSpawnProgress',
  'backlog:list',
  'search:everything',
  'system:getAppVersion',
  'system:detectAgent',
  'diagnostics:logAppend',
]);

const REDACTED = (channel: string) => ({ redacted: true as const, channel });

interface IpcRecorderOptions {
  getProjectRoot: () => string | null;
  enabled: () => boolean;
}

let installed = false;

export function installIpcRecorder(options: IpcRecorderOptions): void {
  if (installed) return;
  installed = true;

  // Save the original implementation so we can delegate to it. Binding is
  // important because `ipcMain.handle` uses `this` internally.
  const originalHandle = ipcMain.handle.bind(ipcMain);

  // The replacement signature matches Electron's typings. We cast through
  // unknown because `ipcMain.handle` has many overloads we don't care about
  // here.
  (ipcMain as unknown as { handle: typeof ipcMain.handle }).handle = ((
    channel: string,
    listener: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ): void => {
    originalHandle(channel, async (event, ...args) => {
      if (!options.enabled()) {
        return listener(event, ...args);
      }
      const start = performance.now();
      const ts = new Date().toISOString();
      let captured: unknown = undefined;
      let errorObj: Error | undefined;
      try {
        captured = await listener(event, ...args);
        return captured;
      } catch (error) {
        errorObj = error instanceof Error ? error : new Error(String(error));
        throw error;
      } finally {
        const durationMs = performance.now() - start;
        const safe = SAFE_CHANNELS.has(channel);
        const entry: IpcLogEntry = errorObj
          ? {
              ts,
              channel,
              args: safe ? args : REDACTED(channel),
              durationMs,
              error: { name: errorObj.name, message: errorObj.message },
            }
          : {
              ts,
              channel,
              args: safe ? args : REDACTED(channel),
              result: safe ? captured : REDACTED(channel),
              durationMs,
            };
        writeEntry(options.getProjectRoot(), entry);
      }
    });
  }) as typeof ipcMain.handle;
}

function writeEntry(projectRoot: string | null, entry: IpcLogEntry): void {
  if (!projectRoot) return;
  const date = entry.ts.slice(0, 10);
  const file = path.join(projectRoot, '.kangentic', 'logs', `ipc-${date}.jsonl`);
  // Async-buffered: queueAppend returns immediately. The previous
  // appendFileSync ran inside the IPC handler's `finally`, blocking the
  // main event loop on every IPC call (incl. IPC.SESSION_WRITE per
  // terminal keystroke). On Windows that costs 5-50 ms per call and
  // was the dominant source of typing-stutter when recordIpcTraffic
  // is on.
  queueAppend(file, JSON.stringify(entry) + '\n');
}

/** Exported for unit tests only. */
export const __INTERNAL = { SAFE_CHANNELS };
