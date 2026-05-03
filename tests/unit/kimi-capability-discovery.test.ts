/**
 * Capability discovery for Kimi: parses `kimi --help` for `--model` support
 * and walks `~/.kimi/sessions/<workdir-hash>/<session-uuid>/wire.jsonl` for
 * model identifiers (verified empirically against kimi 1.37.0; the wire
 * format is two levels deep, not one).
 *
 * Kimi's wire format does not always carry a model field on every event;
 * this suite asserts the parser handles both populated and bare sessions
 * without crashing.
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
import { discoverKimiCapabilities } from '../../src/main/agent/adapters/kimi/capability-discovery';

const execMock = exec as unknown as ReturnType<typeof vi.fn>;
const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;
const existsMock = fs.existsSync as unknown as ReturnType<typeof vi.fn>;
const readdirMock = fs.readdirSync as unknown as ReturnType<typeof vi.fn>;
const statMock = fs.statSync as unknown as ReturnType<typeof vi.fn>;
const openMock = fs.openSync as unknown as ReturnType<typeof vi.fn>;
const readMock = fs.readSync as unknown as ReturnType<typeof vi.fn>;
const closeMock = fs.closeSync as unknown as ReturnType<typeof vi.fn>;

const SESSIONS_ROOT = path.join(os.homedir(), '.kimi', 'sessions');

function setHelpOutput(stdout: string): void {
  const result = Promise.resolve({ stdout });
  execMock.mockReturnValue(result);
  execFileMock.mockReturnValue(result);
}

/** Layout: `<root>/<workdir-hash>/<session-uuid>/wire.jsonl` */
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
    const asDirents = (names: string[]): fs.Dirent[] =>
      names.map((name) => ({ name, isDirectory: () => true })) as unknown as fs.Dirent[];

    if (dirPath === SESSIONS_ROOT) {
      const workdirs = Object.keys(store);
      return options?.withFileTypes ? asDirents(workdirs) : workdirs;
    }
    for (const workdir of Object.keys(store)) {
      const workdirPath = path.join(SESSIONS_ROOT, workdir);
      if (dirPath === workdirPath) {
        const sessions = Object.keys(store[workdir]);
        return options?.withFileTypes ? asDirents(sessions) : sessions;
      }
    }
    throw new Error(`Unexpected readdir: ${dirPath}`);
  });

  statMock.mockImplementation((targetPath: string) => {
    const size = (() => {
      for (const [workdir, sessions] of Object.entries(store)) {
        for (const [sessionId, contents] of Object.entries(sessions)) {
          if (targetPath === path.join(SESSIONS_ROOT, workdir, sessionId, 'wire.jsonl')) {
            return Buffer.byteLength(contents, 'utf-8');
          }
        }
      }
      return 0;
    })();
    return { mtimeMs: Date.now(), size } as fs.Stats;
  });

  openMock.mockImplementation((filePath: string) => {
    for (const [workdir, sessions] of Object.entries(store)) {
      for (const [sessionId, contents] of Object.entries(sessions)) {
        const full = path.join(SESSIONS_ROOT, workdir, sessionId, 'wire.jsonl');
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

describe('discoverKimiCapabilities', () => {
  it('detects --model flag from --help output', async () => {
    setHelpOutput(`
| --model           -m                      TEXT             LLM model to use.
| --thinking               --no-thinking                     Enable thinking mode.
`);
    const capabilities = await discoverKimiCapabilities('/usr/bin/kimi');
    expect(capabilities.supportsModelOverride).toBe(true);
  });

  it('returns empty effortLevels (Kimi has no effort concept)', async () => {
    setHelpOutput('  --model TEXT LLM model to use\n');
    const capabilities = await discoverKimiCapabilities('/usr/bin/kimi');
    expect(capabilities.effortLevels).toEqual([]);
  });

  describe('historical model discovery (workdir-hash/session-uuid layout)', () => {
    /** Real Kimi wire metadata line. */
    function metadataLine(): string {
      return JSON.stringify({ type: 'metadata', protocol_version: '1.9' });
    }

    /** TurnBegin event (no model). */
    function turnBeginLine(): string {
      return JSON.stringify({
        timestamp: 1777232808.515,
        message: { type: 'TurnBegin', payload: { user_input: 'hi' } },
      });
    }

    /** TurnEnd-shaped event with a model in payload. Forward-compat test. */
    function turnEndWithModelLine(model: string): string {
      return JSON.stringify({
        timestamp: 1777232810.0,
        message: { type: 'TurnEnd', payload: { model, finish_reason: 'stop' } },
      });
    }

    /** Top-level model field (older / hypothetical schema). */
    function topLevelModelLine(model: string): string {
      return JSON.stringify({
        timestamp: 1777232815.0,
        type: 'config_update',
        model,
      });
    }

    it('walks the workdir-hash/session-uuid 2-level layout', async () => {
      setHelpOutput('  --model TEXT Model\n');
      setSessionStore({
        '0c26bcf3ad0776977669bf712ae51422': {
          '709fd2c1-8955-4090-8e90-7ba6a52ccfb6':
            `${metadataLine()}\n${turnBeginLine()}\n${turnEndWithModelLine('kimi-k2')}\n`,
        },
      });

      const capabilities = await discoverKimiCapabilities('/usr/bin/kimi');
      expect(capabilities.models).toEqual(['kimi-k2']);
    });

    it('extracts model from top-level fields (forward-compat)', async () => {
      setHelpOutput('  --model TEXT Model\n');
      setSessionStore({
        'workdir-hash': {
          'session-uuid': topLevelModelLine('kimi-k2-0905') + '\n',
        },
      });

      const capabilities = await discoverKimiCapabilities('/usr/bin/kimi');
      expect(capabilities.models).toEqual(['kimi-k2-0905']);
    });

    it('returns models=undefined for sessions whose events lack model info', async () => {
      setHelpOutput('  --model TEXT Model\n');
      // Test mocks - typical for Kimi's wire format which does not always
      // carry the model on every event type.
      setSessionStore({
        'workdir-hash': {
          'session-uuid': `${metadataLine()}\n${turnBeginLine()}\n`,
        },
      });

      const capabilities = await discoverKimiCapabilities('/usr/bin/kimi');
      expect(capabilities.models).toBeUndefined();
    });
  });
});
