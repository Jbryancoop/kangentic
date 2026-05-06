/**
 * Unit tests for `src/main/diagnostics/log-mirror.ts`.
 *
 * Verifies:
 *   - error + warn are persisted to `<projectRoot>/.kangentic/logs/<date>.log`
 *     even when the verbosity toggle is off (errors are never silently lost).
 *   - info / debug / log are persisted only when the toggle is on.
 *   - Each persisted line is valid NDJSON conforming to the LogEntry shape.
 *   - When `getProjectRoot()` returns null, persistence is skipped without
 *     throwing (cold-start path before any project is open).
 *   - The IPC.LOG_APPEND handler is registered for the renderer-side relay.
 *
 * The module patches global `console.*` at install time, so the test
 * captures the original handles before importing and restores them after
 * each run to keep output predictable across other tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    }),
    on: vi.fn(),
  },
}));

let tempDirectory: string;
let originalLog: typeof console.log;
let originalWarn: typeof console.warn;
let originalError: typeof console.error;
let originalInfo: typeof console.info;
let originalDebug: typeof console.debug;

beforeEach(() => {
  ipcHandlers.clear();
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'log-mirror-test-'));
  originalLog = console.log;
  originalWarn = console.warn;
  originalError = console.error;
  originalInfo = console.info;
  originalDebug = console.debug;
  vi.resetModules();
});

afterEach(() => {
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
  console.info = originalInfo;
  console.debug = originalDebug;
  try {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

function readLogLines(date: string): Array<{ ts: string; level: string; source: string; args: string[] }> {
  const file = path.join(tempDirectory, '.kangentic', 'logs', `${date}.log`);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf-8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

describe('log-mirror', () => {
  it('persists error and warn even when persistInfoDebug is false', async () => {
    const { startLogMirror } = await import('../../src/main/diagnostics/log-mirror');
    startLogMirror({
      getProjectRoot: () => tempDirectory,
      getPersistInfoDebug: () => false,
    });

    console.error('boom', { code: 42 });
    console.warn('careful');
    console.info('chat');
    console.debug('verbose');
    console.log('plain');

    const lines = readLogLines(todayUtc());
    const levels = lines.map((entry) => entry.level).sort();
    expect(levels).toEqual(['error', 'warn']);

    const errorLine = lines.find((entry) => entry.level === 'error');
    expect(errorLine?.source).toBe('main');
    expect(errorLine?.args[0]).toBe('boom');
    expect(JSON.parse(errorLine!.args[1])).toEqual({ code: 42 });
    expect(typeof errorLine?.ts).toBe('string');
  });

  it('persists info and debug when persistInfoDebug is true', async () => {
    const { startLogMirror } = await import('../../src/main/diagnostics/log-mirror');
    startLogMirror({
      getProjectRoot: () => tempDirectory,
      getPersistInfoDebug: () => true,
    });

    console.info('chat');
    console.debug('verbose');
    console.log('plain');

    const lines = readLogLines(todayUtc());
    const levels = lines.map((entry) => entry.level).sort();
    expect(levels).toEqual(['debug', 'info', 'log']);
  });

  it('drops writes silently when project root is null (no project open)', async () => {
    const { startLogMirror } = await import('../../src/main/diagnostics/log-mirror');
    startLogMirror({
      getProjectRoot: () => null,
      getPersistInfoDebug: () => true,
    });

    expect(() => {
      console.error('no-project');
      console.info('still no-project');
    }).not.toThrow();

    expect(fs.existsSync(path.join(tempDirectory, '.kangentic', 'logs'))).toBe(false);
  });

  it('registers an IPC.LOG_APPEND handler for renderer-side relay', async () => {
    const { startLogMirror } = await import('../../src/main/diagnostics/log-mirror');
    const { IPC } = await import('../../src/shared/ipc-channels');
    startLogMirror({
      getProjectRoot: () => tempDirectory,
      getPersistInfoDebug: () => true,
    });

    const handler = ipcHandlers.get(IPC.LOG_APPEND);
    expect(handler).toBeDefined();

    const rendererEntry = {
      ts: new Date().toISOString(),
      level: 'error',
      source: 'renderer',
      args: ['from renderer'],
    };
    handler!({}, rendererEntry);

    const lines = readLogLines(todayUtc());
    expect(lines.find((entry) => entry.source === 'renderer')).toMatchObject({
      level: 'error',
      args: ['from renderer'],
    });
  });
});
