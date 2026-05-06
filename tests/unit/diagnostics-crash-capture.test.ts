/**
 * Unit tests for `src/main/diagnostics/crash-capture.ts`.
 *
 * Covers the always-on crash persistence path:
 *   - The IPC.CRASH_REPORT handler writes a record to disk for renderer
 *     side crashes forwarded by the preload error capture.
 *   - Filenames are derived from the timestamp with `:` and `.` replaced
 *     so the path is portable across Windows.
 *   - Records survive round-tripping through JSON without data loss.
 *
 * The process-level handlers (uncaughtException, unhandledRejection) and
 * the per-webContents listeners are exercised in the e2e suite where a
 * real Electron + main process is available.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CrashRecord } from '../../src/shared/types';

const ipcHandlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
const appListeners = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '1.2.3'),
    on: vi.fn((eventName: string, handler: (...args: unknown[]) => unknown) => {
      appListeners.set(eventName, handler);
    }),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    }),
    on: vi.fn(),
  },
}));

let tempDirectory: string;

beforeEach(() => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-capture-test-'));
  ipcHandlers.clear();
  appListeners.clear();
  vi.resetModules();
});

afterEach(() => {
  try {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe('crash-capture', () => {
  it('registers an IPC.CRASH_REPORT handler that writes a record to disk', async () => {
    const { startCrashCapture } = await import('../../src/main/diagnostics/crash-capture');
    const { IPC } = await import('../../src/shared/ipc-channels');
    startCrashCapture({ getProjectRoot: () => tempDirectory });

    const handler = ipcHandlers.get(IPC.CRASH_REPORT);
    expect(handler).toBeDefined();

    const record: CrashRecord = {
      ts: '2026-05-06T12:34:56.789Z',
      kind: 'renderer-window-error',
      source: 'renderer',
      message: 'TypeError: x.y is not a function',
      stack: 'TypeError\n    at handler (file:///app.js:1:1)',
      origin: 'http://localhost:5173/',
      context: { line: 12, col: 3 },
      versions: { kangentic: 'unknown', electron: '41.0.0', node: '24.0.0', chrome: '128' },
    };
    handler!({}, record);

    const directory = path.join(tempDirectory, '.kangentic', 'logs', 'crashes');
    const files = fs.readdirSync(directory);
    expect(files).toHaveLength(1);
    // Colons in the timestamp are illegal on Windows; the writer rewrites
    // them with `-`. Check the substitution rather than the full filename
    // (millisecond precision varies across runs).
    expect(files[0]).not.toContain(':');
    expect(files[0]).toMatch(/^2026-05-06T12-34-56-789Z\.json$/);

    const persisted = JSON.parse(fs.readFileSync(path.join(directory, files[0]!), 'utf-8'));
    expect(persisted).toEqual(record);
  });

  it('drops the report silently when project root is null', async () => {
    const { startCrashCapture } = await import('../../src/main/diagnostics/crash-capture');
    const { IPC } = await import('../../src/shared/ipc-channels');
    startCrashCapture({ getProjectRoot: () => null });

    const handler = ipcHandlers.get(IPC.CRASH_REPORT);
    const record: CrashRecord = {
      ts: '2026-05-06T12:00:00.000Z',
      kind: 'renderer-unhandled-rejection',
      source: 'renderer',
      message: 'no project',
      stack: null,
      origin: null,
      context: null,
      versions: { kangentic: 'unknown', electron: '41.0.0', node: '24.0.0', chrome: '128' },
    };
    expect(() => handler!({}, record)).not.toThrow();
    expect(fs.existsSync(path.join(tempDirectory, '.kangentic'))).toBe(false);
  });

  it('subscribes to web-contents-created on the app for per-window crash capture', async () => {
    const { startCrashCapture } = await import('../../src/main/diagnostics/crash-capture');
    startCrashCapture({ getProjectRoot: () => tempDirectory });
    expect(appListeners.has('web-contents-created')).toBe(true);
  });
});
