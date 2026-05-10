import * as path from 'node:path';
import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type { LogEntry } from '../../shared/types';
import { resolveLogEntry } from './source-map-resolver';
import { queueAppend } from './async-file-queue';

/**
 * Persistent console-output mirror. Patches `console.log/warn/error/info/debug`
 * in the main process and listens on IPC.LOG_APPEND for renderer-side output
 * forwarded by the preload script. Lines are appended as NDJSON to
 * `<projectRoot>/.kangentic/logs/<YYYY-MM-DD>.log`.
 *
 * Verbosity gating:
 *   - `error` and `warn` are ALWAYS persisted.
 *   - `info`, `debug`, `log` are persisted only when `developer.persistConsoleLogs`
 *     is `true`.
 *
 * Resilience: when `getProjectRoot()` returns null (no project open yet) or
 * when the file system rejects the write, the call is silently dropped. We
 * never want a diagnostic feature to crash the app.
 */

interface LogMirrorOptions {
  /** Returns the active project root, or null when no project is open. */
  getProjectRoot: () => string | null;
  /** Returns the current value of `developer.persistConsoleLogs`. */
  getPersistInfoDebug: () => boolean;
}

let installed = false;

export function startLogMirror(options: LogMirrorOptions): void {
  if (installed) return;
  installed = true;

  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const originalInfo = console.info;
  const originalDebug = console.debug;

  const wrap =
    (level: LogEntry['level'], original: (...args: unknown[]) => void) =>
    (...args: unknown[]): void => {
      // Always call the original first so the dev console still shows output
      // and any other listeners (analytics, devtools) see the call. Even if
      // the persistence path throws below, the original was invoked first so
      // visible behavior is unchanged.
      original.apply(console, args);
      if (!shouldPersist(level, options.getPersistInfoDebug())) return;
      appendLog(options.getProjectRoot(), {
        ts: new Date().toISOString(),
        level,
        source: 'main',
        args: args.map(stringifyArg),
      });
    };

  console.log = wrap('log', originalLog);
  console.warn = wrap('warn', originalWarn);
  console.error = wrap('error', originalError);
  console.info = wrap('info', originalInfo);
  console.debug = wrap('debug', originalDebug);

  // Renderer + preload forward via IPC.LOG_APPEND. The preload patch
  // (src/preload/diagnostics/console-capture.ts) is the producer.
  ipcMain.handle(IPC.LOG_APPEND, (_event, entry: LogEntry) => {
    if (!shouldPersist(entry.level, options.getPersistInfoDebug())) return;
    appendLog(options.getProjectRoot(), entry);
  });
}

function shouldPersist(level: LogEntry['level'], persistInfoDebug: boolean): boolean {
  if (level === 'error' || level === 'warn') return true;
  return persistInfoDebug;
}

function appendLog(projectRoot: string | null, entry: LogEntry): void {
  if (!projectRoot) return;
  // Pass entries through the source-map resolver so any embedded stacks
  // in stringified Error args resolve to original source coordinates
  // (V1 is a passthrough; replacing the resolver body adds real
  // source-map lookup with no caller changes).
  const resolved = resolveLogEntry(entry);
  // YYYY-MM-DD slice of an ISO 8601 timestamp.
  const date = resolved.ts.slice(0, 10);
  const file = path.join(projectRoot, '.kangentic', 'logs', `${date}.log`);
  // Async-buffered: queueAppend returns immediately; the disk write
  // happens on the next setImmediate turn. Eliminates the per-call
  // appendFileSync + mkdirSync that blocked the main event loop on
  // every console.* and IPC.LOG_APPEND.
  queueAppend(file, JSON.stringify(resolved) + '\n');
}

function stringifyArg(argument: unknown): string {
  if (argument instanceof Error) {
    return JSON.stringify({
      name: argument.name,
      message: argument.message,
      stack: argument.stack ?? null,
    });
  }
  if (typeof argument === 'object' && argument !== null) {
    try {
      return JSON.stringify(argument, circularSafeReplacer());
    } catch {
      return String(argument);
    }
  }
  return String(argument);
}

function circularSafeReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return (_key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value as object)) return '[Circular]';
      seen.add(value as object);
    }
    return value;
  };
}
