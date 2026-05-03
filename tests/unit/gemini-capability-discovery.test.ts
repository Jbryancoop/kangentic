/**
 * Capability discovery for Gemini CLI: parses `gemini --help` for static
 * support and walks `~/.gemini/tmp/<project>/chats/session-*.json[l]` for
 * model identifiers used in past sessions.
 *
 * The session-history scan must rank project dirs by their `chats/`
 * subdirectory mtime (not the project root) so test-artifact dirs without
 * `chats/` do not crowd out real sessions. The "real-session.json with
 * messages[].model" parse path locks the schema against drift.
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
    readFileSync: vi.fn(),
    openSync: vi.fn(),
    readSync: vi.fn(),
    closeSync: vi.fn(),
  },
}));

import { execFile, exec } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverGeminiCapabilities } from '../../src/main/agent/adapters/gemini/capability-discovery';

const execMock = exec as unknown as ReturnType<typeof vi.fn>;
const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;
const existsMock = fs.existsSync as unknown as ReturnType<typeof vi.fn>;
const readdirMock = fs.readdirSync as unknown as ReturnType<typeof vi.fn>;
const statMock = fs.statSync as unknown as ReturnType<typeof vi.fn>;
const readFileMock = fs.readFileSync as unknown as ReturnType<typeof vi.fn>;

const TMP_ROOT = path.join(os.homedir(), '.gemini', 'tmp');

function setHelpOutput(stdout: string): void {
  const result = Promise.resolve({ stdout });
  execMock.mockReturnValue(result);
  execFileMock.mockReturnValue(result);
}

/**
 * Wire up the fs chain that scanGeminiSessionHistory walks.
 * Layout: `<tmpRoot>/<project-slug>/chats/<session-file>`
 * The scanner ranks project dirs by `chats/` mtime, not the project root.
 */
type SessionTree = Record<string, Record<string, string>>;

function setSessionStore(store: SessionTree | null): void {
  existsMock.mockReset();
  readdirMock.mockReset();
  statMock.mockReset();
  readFileMock.mockReset();

  if (store === null) {
    existsMock.mockReturnValue(false);
    return;
  }
  existsMock.mockReturnValue(true);

  readdirMock.mockImplementation((dirPath: string, options?: { withFileTypes?: boolean }) => {
    const asDirents = (names: string[]): fs.Dirent[] =>
      names.map((name) => ({ name, isDirectory: () => true })) as unknown as fs.Dirent[];

    if (dirPath === TMP_ROOT) {
      const projects = Object.keys(store);
      return options?.withFileTypes ? asDirents(projects) : projects;
    }
    for (const project of Object.keys(store)) {
      const chatsPath = path.join(TMP_ROOT, project, 'chats');
      if (dirPath === chatsPath) {
        return Object.keys(store[project]);
      }
    }
    throw new Error(`Unexpected readdir: ${dirPath}`);
  });

  statMock.mockImplementation((targetPath: string) => {
    // The chats/ subdir's mtime is what the scanner ranks by; existence
    // of statSync without throwing is what filters real-session dirs from
    // test-artifact dirs that have no chats/.
    for (const project of Object.keys(store)) {
      const chatsPath = path.join(TMP_ROOT, project, 'chats');
      if (targetPath === chatsPath) {
        return { mtimeMs: Date.now(), size: 0 } as fs.Stats;
      }
    }
    return { mtimeMs: Date.now(), size: 1024 } as fs.Stats;
  });

  readFileMock.mockImplementation((filePath: string) => {
    for (const project of Object.keys(store)) {
      for (const file of Object.keys(store[project])) {
        const full = path.join(TMP_ROOT, project, 'chats', file);
        if (filePath === full) {
          return store[project][file];
        }
      }
    }
    throw new Error(`Unexpected readFile: ${filePath}`);
  });
}

beforeEach(() => {
  execMock.mockReset();
  execFileMock.mockReset();
  setSessionStore(null);
});

describe('discoverGeminiCapabilities', () => {
  it('detects --model flag from --help output', async () => {
    setHelpOutput(`
  -m, --model                     Model  [string]
  -p, --prompt <text>             Run in non-interactive mode
`);
    const capabilities = await discoverGeminiCapabilities('/usr/bin/gemini');
    expect(capabilities.supportsModelOverride).toBe(true);
  });

  it('reports no --model support when help text omits the flag', async () => {
    setHelpOutput('Usage: gemini\n  -h, --help    Show help\n');
    const capabilities = await discoverGeminiCapabilities('/usr/bin/gemini');
    expect(capabilities.supportsModelOverride).toBe(false);
  });

  it('returns empty effortLevels (Gemini has no effort concept)', async () => {
    setHelpOutput('  -m, --model Model\n');
    const capabilities = await discoverGeminiCapabilities('/usr/bin/gemini');
    expect(capabilities.effortLevels).toEqual([]);
  });

  describe('historical model discovery', () => {
    /**
     * Real Gemini session.json shape (verified against gemini 0.40.1).
     * Models live on each gemini-typed assistant message under `.model`.
     */
    function realSessionJson(model: string): string {
      return JSON.stringify({
        sessionId: '08889b8d-c485-4aaa-b91d-ae966fa0ab4a',
        startTime: '2026-04-01T23:38:36.391Z',
        messages: [
          { id: 'a', type: 'user', content: [{ text: 'hello' }] },
          { id: 'b', type: 'gemini', content: 'Hello back!', model },
        ],
        kind: 'main',
      });
    }

    function realSessionJsonl(model: string): string {
      // .jsonl format: each line is its own record; gemini-typed messages
      // carry .model directly at the top level.
      return [
        JSON.stringify({ sessionId: 'abc', kind: 'main', startTime: '2026-04-28T18:52:12Z' }),
        JSON.stringify({ id: 'b', type: 'gemini', content: 'Hi', model }),
      ].join('\n');
    }

    it('extracts models from `messages[].model` in .json sessions', async () => {
      setHelpOutput('  -m, --model Model\n');
      setSessionStore({
        kangentic: {
          'session-2026-04-01T23-37.json': realSessionJson('gemini-3-flash-preview'),
        },
      });

      const capabilities = await discoverGeminiCapabilities('/usr/bin/gemini');
      expect(capabilities.models).toEqual(['gemini-3-flash-preview']);
    });

    it('extracts models from .jsonl sessions (newer format)', async () => {
      setHelpOutput('  -m, --model Model\n');
      setSessionStore({
        kangentic: {
          'session-2026-04-28T18-52.jsonl': realSessionJsonl('gemini-2.5-flash'),
        },
      });

      const capabilities = await discoverGeminiCapabilities('/usr/bin/gemini');
      expect(capabilities.models).toEqual(['gemini-2.5-flash']);
    });

    it('skips project dirs whose chats/ subdir does not exist', async () => {
      setHelpOutput('  -m, --model Model\n');
      // Two projects in store, but the test-artifact has no chats/.
      // The scanner mocks statSync to throw for missing dirs - so
      // we manually arrange that here.
      existsMock.mockReturnValue(true);
      readdirMock.mockImplementation((dirPath: string, options?: { withFileTypes?: boolean }) => {
        const asDirents = (names: string[]): fs.Dirent[] =>
          names.map((name) => ({ name, isDirectory: () => true })) as unknown as fs.Dirent[];

        if (dirPath === TMP_ROOT) {
          const projects = ['gemini-test-artifact', 'kangentic'];
          return options?.withFileTypes ? asDirents(projects) : projects;
        }
        if (dirPath === path.join(TMP_ROOT, 'kangentic', 'chats')) {
          return ['session-real.json'];
        }
        // gemini-test-artifact/chats listing should not be reached.
        throw new Error(`Unexpected readdir: ${dirPath}`);
      });
      statMock.mockImplementation((target: string) => {
        if (target === path.join(TMP_ROOT, 'kangentic', 'chats')) {
          return { mtimeMs: Date.now() } as fs.Stats;
        }
        if (target === path.join(TMP_ROOT, 'gemini-test-artifact', 'chats')) {
          throw new Error('ENOENT');
        }
        return { mtimeMs: Date.now() } as fs.Stats;
      });
      readFileMock.mockImplementation((target: string) => {
        if (target === path.join(TMP_ROOT, 'kangentic', 'chats', 'session-real.json')) {
          return realSessionJson('gemini-2.5-pro');
        }
        throw new Error(`Unexpected readFile: ${target}`);
      });

      const capabilities = await discoverGeminiCapabilities('/usr/bin/gemini');
      expect(capabilities.models).toEqual(['gemini-2.5-pro']);
    });

    it('returns models=undefined when sessions root is missing', async () => {
      setHelpOutput('  -m, --model Model\n');
      // setSessionStore(null) -> existsSync returns false
      const capabilities = await discoverGeminiCapabilities('/usr/bin/gemini');
      expect(capabilities.models).toBeUndefined();
    });
  });
});
