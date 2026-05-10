/**
 * Unit tests for `src/main/diagnostics/ipc-recorder.ts`.
 *
 * Verifies:
 *   - The exported `SAFE_CHANNELS` allowlist is a default-deny set: only
 *     read-only channels appear; nothing that writes settings, MCP config,
 *     or auth credentials.
 *   - When `enabled()` returns false, the recorder is a pass-through and
 *     does not write to disk.
 *   - When `enabled()` returns true, an entry is appended to
 *     `<projectRoot>/.kangentic/logs/ipc-<date>.jsonl` with the channel,
 *     duration, and either args+result (safe channel) or
 *     `{ redacted: true, channel }` placeholders (default-deny).
 *   - Handler errors are captured as `error: { name, message }` instead
 *     of `result`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let registeredHandler: ((event: unknown, ...args: unknown[]) => Promise<unknown>) | null = null;

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((_channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) => {
      registeredHandler = handler;
    }),
    on: vi.fn(),
  },
}));

let tempDirectory: string;

beforeEach(async () => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-recorder-test-'));
  registeredHandler = null;
  vi.resetModules();
  // The mocked `ipcMain` object survives `vi.resetModules` (the mock
  // factory only runs once per file). Each test's `installIpcRecorder`
  // call wraps `ipcMain.handle`; without resetting the property to a
  // fresh `vi.fn`, subsequent tests see the previous test's wrapper
  // still attached, causing duplicate writes per request.
  const electron = await import('electron');
  electron.ipcMain.handle = vi.fn((_channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
    registeredHandler = handler;
  }) as unknown as typeof electron.ipcMain.handle;
  // Drain any leftover queue state from the prior test.
  const { resetForTest } = await import('../../src/main/diagnostics/async-file-queue');
  resetForTest();
});

afterEach(() => {
  try {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

async function readJsonlEntries(channelOrAny?: string): Promise<unknown[]> {
  // Writes are async-buffered through the file queue; await pending
  // flushes before reading.
  const { flushAllForTest } = await import('../../src/main/diagnostics/async-file-queue');
  await flushAllForTest();
  const directory = path.join(tempDirectory, '.kangentic', 'logs');
  if (!fs.existsSync(directory)) return [];
  const today = new Date().toISOString().slice(0, 10);
  const file = path.join(directory, `ipc-${today}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf-8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
    .filter((entry) => !channelOrAny || (entry as { channel: string }).channel === channelOrAny);
}

describe('ipc-recorder', () => {
  it('SAFE_CHANNELS allowlist contains only read-only channels', async () => {
    const { __INTERNAL } = await import('../../src/main/diagnostics/ipc-recorder');
    // Spot-check a couple of representative entries: read-only project /
    // session lookups belong; mutating channels do not.
    expect(__INTERNAL.SAFE_CHANNELS.has('project:list')).toBe(true);
    expect(__INTERNAL.SAFE_CHANNELS.has('session:getActivityStats')).toBe(true);
    expect(__INTERNAL.SAFE_CHANNELS.has('search:everything')).toBe(true);

    // Mutating channels must NOT be on the allowlist.
    expect(__INTERNAL.SAFE_CHANNELS.has('task:create')).toBe(false);
    expect(__INTERNAL.SAFE_CHANNELS.has('config:set')).toBe(false);
    expect(__INTERNAL.SAFE_CHANNELS.has('attachment:add')).toBe(false);
    expect(__INTERNAL.SAFE_CHANNELS.has('boards:asana:setPat')).toBe(false);
  });

  it('does not write to disk when enabled() is false', async () => {
    const { installIpcRecorder } = await import('../../src/main/diagnostics/ipc-recorder');
    const { ipcMain } = await import('electron');
    installIpcRecorder({
      getProjectRoot: () => tempDirectory,
      enabled: () => false,
    });

    // Have a handler register through the patched `ipcMain.handle`. The
    // patch wraps the user's handler; passing a stub captures the wrap.
    ipcMain.handle('project:list', async () => ['project-a']);

    expect(registeredHandler).not.toBeNull();
    const result = await registeredHandler!({});
    expect(result).toEqual(['project-a']);

    expect(await readJsonlEntries()).toEqual([]);
  });

  it('logs args + result for safe channels when enabled', async () => {
    const { installIpcRecorder } = await import('../../src/main/diagnostics/ipc-recorder');
    const { ipcMain } = await import('electron');
    installIpcRecorder({
      getProjectRoot: () => tempDirectory,
      enabled: () => true,
    });

    ipcMain.handle('project:list', async (_event: unknown, _arg: string) => ['project-a']);
    await registeredHandler!({}, 'unused');

    const entries = await readJsonlEntries('project:list');
    expect(entries).toHaveLength(1);
    const entry = entries[0] as {
      channel: string;
      args: unknown;
      result: unknown;
      durationMs: number;
    };
    expect(entry.channel).toBe('project:list');
    expect(entry.args).toEqual(['unused']);
    expect(entry.result).toEqual(['project-a']);
    expect(typeof entry.durationMs).toBe('number');
  });

  it('redacts args + result for non-safe channels', async () => {
    const { installIpcRecorder } = await import('../../src/main/diagnostics/ipc-recorder');
    const { ipcMain } = await import('electron');
    installIpcRecorder({
      getProjectRoot: () => tempDirectory,
      enabled: () => true,
    });

    ipcMain.handle('config:set', async (_event: unknown, _settings: unknown) => 'ok');
    await registeredHandler!({}, { apiKey: 'sk-secret', other: 'data' });

    const entries = await readJsonlEntries('config:set');
    expect(entries).toHaveLength(1);
    const entry = entries[0] as {
      args: { redacted: boolean; channel: string };
      result: { redacted: boolean; channel: string };
    };
    expect(entry.args).toEqual({ redacted: true, channel: 'config:set' });
    expect(entry.result).toEqual({ redacted: true, channel: 'config:set' });
  });

  it('captures errors thrown by the handler', async () => {
    const { installIpcRecorder } = await import('../../src/main/diagnostics/ipc-recorder');
    const { ipcMain } = await import('electron');
    installIpcRecorder({
      getProjectRoot: () => tempDirectory,
      enabled: () => true,
    });

    ipcMain.handle('project:list', async () => {
      throw new Error('database locked');
    });

    await expect(registeredHandler!({})).rejects.toThrow('database locked');

    const entries = await readJsonlEntries('project:list');
    expect(entries).toHaveLength(1);
    const entry = entries[0] as {
      error: { name: string; message: string };
      result?: unknown;
    };
    expect(entry.error).toEqual({ name: 'Error', message: 'database locked' });
    expect(entry.result).toBeUndefined();
  });
});
