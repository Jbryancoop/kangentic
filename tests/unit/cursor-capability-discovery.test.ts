/**
 * Capability discovery for Cursor (the `agent` CLI): parses `agent --help`
 * for `--model` support, and walks `~/.cursor/sessions/<dated-dir>/*.jsonl`
 * for models on `system / init` NDJSON events.
 *
 * On Windows, the CLI is a `.CMD` shim that cannot be invoked via execFile
 * (Node CVE-2024-27980 mitigation). The discovery code uses `exec` with a
 * shell on win32 and `execFile` elsewhere - tests cover both paths via the
 * promisify identity mock.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  exec: vi.fn(),
}));

vi.mock('node:util', () => ({
  promisify: (fn: unknown) => fn,
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    statSync: vi.fn(),
    openSync: vi.fn(),
    readSync: vi.fn(),
    closeSync: vi.fn(),
  },
}));

import { execFile, exec } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverCursorCapabilities } from '../../src/main/agent/adapters/cursor/capability-discovery';

const execMock = exec as unknown as ReturnType<typeof vi.fn>;
const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;
const existsMock = fs.existsSync as unknown as ReturnType<typeof vi.fn>;
const readdirMock = fs.readdirSync as unknown as ReturnType<typeof vi.fn>;
const statMock = fs.statSync as unknown as ReturnType<typeof vi.fn>;
const openMock = fs.openSync as unknown as ReturnType<typeof vi.fn>;
const readMock = fs.readSync as unknown as ReturnType<typeof vi.fn>;
const closeMock = fs.closeSync as unknown as ReturnType<typeof vi.fn>;

const SESSIONS_ROOT = path.join(os.homedir(), '.cursor', 'sessions');

function setHelpOutput(stdout: string): void {
  const result = Promise.resolve({ stdout, stderr: '' });
  execMock.mockReturnValue(result);
  execFileMock.mockReturnValue(result);
}

/** Layout: `<root>/<dated-dir>/<chatId>.jsonl` */
type SessionTree = Record<string, Record<string, string>>;

function setSessionStore(store: SessionTree | null): void {
  existsMock.mockReset();
  readdirMock.mockReset();
  statMock.mockReset();
  openMock.mockReset();
  readMock.mockReset();
  closeMock.mockReset();

  if (store === null) {
    existsMock.mockReturnValue(false);
    return;
  }
  existsMock.mockReturnValue(true);

  const fdContents = new Map<number, string>();
  let nextFd = 100;

  readdirMock.mockImplementation((dirPath: string, options?: { withFileTypes?: boolean }) => {
    if (dirPath === SESSIONS_ROOT) {
      const entries = Object.keys(store);
      if (options?.withFileTypes) {
        return entries.map((name) => ({ name, isDirectory: () => true })) as unknown as fs.Dirent[];
      }
      return entries;
    }
    for (const dir of Object.keys(store)) {
      const sessionPath = path.join(SESSIONS_ROOT, dir);
      if (dirPath === sessionPath) {
        return Object.keys(store[dir]);
      }
    }
    throw new Error(`Unexpected readdir: ${dirPath}`);
  });

  statMock.mockImplementation((targetPath: string) => {
    const size = (() => {
      for (const [dir, files] of Object.entries(store)) {
        for (const [file, contents] of Object.entries(files)) {
          if (targetPath === path.join(SESSIONS_ROOT, dir, file)) {
            return Buffer.byteLength(contents, 'utf-8');
          }
        }
      }
      return 0;
    })();
    return { mtimeMs: Date.now(), size } as fs.Stats;
  });

  openMock.mockImplementation((filePath: string) => {
    for (const [dir, files] of Object.entries(store)) {
      for (const [file, contents] of Object.entries(files)) {
        const full = path.join(SESSIONS_ROOT, dir, file);
        if (filePath === full) {
          const fd = nextFd++;
          fdContents.set(fd, contents);
          return fd;
        }
      }
    }
    throw new Error(`Unexpected open: ${filePath}`);
  });

  readMock.mockImplementation((fd: number, buffer: Buffer, _offset: number, length: number) => {
    const text = fdContents.get(fd) ?? '';
    const bytes = Buffer.from(text, 'utf-8');
    const toCopy = Math.min(length, bytes.length);
    bytes.copy(buffer, 0, 0, toCopy);
    return toCopy;
  });

  closeMock.mockImplementation((fd: number) => {
    fdContents.delete(fd);
  });
}

beforeEach(() => {
  execMock.mockReset();
  execFileMock.mockReset();
  setSessionStore(null);
});

describe('discoverCursorCapabilities', () => {
  it('detects --model flag from --help output', async () => {
    setHelpOutput(`
  --model <model>           Model to use (e.g., gpt-5, sonnet-4, sonnet-4-thinking)
  --list-models             List available models and exit
`);
    const capabilities = await discoverCursorCapabilities('/usr/bin/agent');
    expect(capabilities.supportsModelOverride).toBe(true);
  });

  it('reports no --model when help text omits the flag', async () => {
    setHelpOutput('Usage: agent\n  -h, --help    Display help\n');
    const capabilities = await discoverCursorCapabilities('/usr/bin/agent');
    expect(capabilities.supportsModelOverride).toBe(false);
  });

  it('returns empty effortLevels (Cursor encodes effort in model names)', async () => {
    setHelpOutput('  --model <model> Model to use\n');
    const capabilities = await discoverCursorCapabilities('/usr/bin/agent');
    expect(capabilities.effortLevels).toEqual([]);
  });

  it('falls back to hardcoded common models when help fails', async () => {
    const reject = (): Promise<{ stdout: string }> => {
      const promise = Promise.reject(new Error('ENOENT')) as Promise<{ stdout: string }>;
      promise.catch(() => {});
      return promise;
    };
    execMock.mockImplementation(reject);
    execFileMock.mockImplementation(reject);

    const capabilities = await discoverCursorCapabilities('/missing/agent');
    expect(capabilities.supportsModelOverride).toBe(false);
    // Cursor always returns its hardcoded fallback list regardless of detection
    expect(capabilities.models).toBeDefined();
    expect(capabilities.models?.length).toBeGreaterThan(0);
  });

  describe('historical model discovery', () => {
    /** Real Cursor NDJSON init event shape (verified empirically). */
    function initLine(model: string, sessionId = 'sess-1'): string {
      return JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: sessionId,
        model,
        permissionMode: 'default',
      });
    }

    function userLine(): string {
      return JSON.stringify({ type: 'user', content: [{ text: 'hello' }] });
    }

    it('extracts models from `system / init` events', async () => {
      setHelpOutput('  --model <model> Model to use\n');
      setSessionStore({
        '2026-04-28': {
          'chat-1.jsonl': `${initLine('Claude 4.1 Sonnet')}\n${userLine()}\n`,
        },
      });

      const capabilities = await discoverCursorCapabilities('/usr/bin/agent');
      // Discovered model + the hardcoded common list, deduped
      expect(capabilities.models).toContain('Claude 4.1 Sonnet');
    });

    it('dedupes against the hardcoded common-models fallback', async () => {
      setHelpOutput('  --model <model> Model to use\n');
      setSessionStore({
        '2026-04-28': {
          // 'Claude 4.1 Sonnet' is already in CURSOR_COMMON_MODELS
          'chat-1.jsonl': initLine('Claude 4.1 Sonnet') + '\n',
        },
      });

      const capabilities = await discoverCursorCapabilities('/usr/bin/agent');
      const occurrences = capabilities.models?.filter((m) => m === 'Claude 4.1 Sonnet').length ?? 0;
      expect(occurrences).toBe(1);
    });

    it('skips events that are not `system / init`', async () => {
      setHelpOutput('  --model <model> Model to use\n');
      setSessionStore({
        '2026-04-28': {
          'chat-1.jsonl': `${userLine()}\n${JSON.stringify({ type: 'system', subtype: 'other', model: 'should-not-appear' })}\n`,
        },
      });

      const capabilities = await discoverCursorCapabilities('/usr/bin/agent');
      expect(capabilities.models).not.toContain('should-not-appear');
    });
  });
});
