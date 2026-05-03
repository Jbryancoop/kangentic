/**
 * Capability discovery for GitHub Copilot CLI: parses `copilot --help` for
 * `--model` and `--reasoning-effort` support, plus walks
 * `~/.copilot/session-state/<sessionId>/events.jsonl` for observed models.
 *
 * The effort-level parser handles commander.js's `(choices: "low",
 * "medium", ...)` shape (not the bare `(low, medium, ...)` Claude uses);
 * the historical scan harvests model strings from `data.currentModel`,
 * `data.model`, and `data.modelMetrics` (an object keyed by model name).
 * Real-shape fixtures protect both parsers from upstream drift.
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
import { discoverCopilotCapabilities } from '../../src/main/agent/adapters/copilot/capability-discovery';

const execMock = exec as unknown as ReturnType<typeof vi.fn>;
const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;
const existsMock = fs.existsSync as unknown as ReturnType<typeof vi.fn>;
const readdirMock = fs.readdirSync as unknown as ReturnType<typeof vi.fn>;
const statMock = fs.statSync as unknown as ReturnType<typeof vi.fn>;
const openMock = fs.openSync as unknown as ReturnType<typeof vi.fn>;
const readMock = fs.readSync as unknown as ReturnType<typeof vi.fn>;
const closeMock = fs.closeSync as unknown as ReturnType<typeof vi.fn>;

const SESSIONS_ROOT = path.join(os.homedir(), '.copilot', 'session-state');

function setHelpOutput(stdout: string): void {
  const result = Promise.resolve({ stdout });
  execMock.mockReturnValue(result);
  execFileMock.mockReturnValue(result);
}

/** Layout: `<root>/<sessionId>/events.jsonl` */
type SessionTree = Record<string, string>;

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
      const sessions = Object.keys(store);
      return options?.withFileTypes ? asDirents(sessions) : sessions;
    }
    throw new Error(`Unexpected readdir: ${dirPath}`);
  });

  statMock.mockImplementation((targetPath: string) => {
    for (const sessionId of Object.keys(store)) {
      const eventsPath = path.join(SESSIONS_ROOT, sessionId, 'events.jsonl');
      if (targetPath === eventsPath) {
        const size = Buffer.byteLength(store[sessionId], 'utf-8');
        return { mtimeMs: Date.now(), size } as fs.Stats;
      }
    }
    return { mtimeMs: Date.now(), size: 0 } as fs.Stats;
  });

  openMock.mockImplementation((filePath: string) => {
    for (const [sessionId, contents] of Object.entries(store)) {
      const full = path.join(SESSIONS_ROOT, sessionId, 'events.jsonl');
      if (filePath === full) {
        const fd = nextFd++;
        fdContents.set(fd, contents);
        return fd;
      }
    }
    throw new Error(`Unexpected open: ${filePath}`);
  });

  readMock.mockImplementation((fd: number, buffer: Buffer, _offset: number, length: number, position: number | null) => {
    const text = fdContents.get(fd) ?? '';
    const bytes = Buffer.from(text, 'utf-8');
    // Copilot reads from the END of the file - support `position` correctly.
    const start = position ?? 0;
    const available = Math.max(0, bytes.length - start);
    const toCopy = Math.min(length, available);
    bytes.copy(buffer, 0, start, start + toCopy);
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

describe('discoverCopilotCapabilities', () => {
  it('detects --model flag from --help output', async () => {
    setHelpOutput(`
  --model <model>      Set the AI model to use
  -p, --prompt <text>  Execute a prompt
`);
    const capabilities = await discoverCopilotCapabilities('/usr/bin/copilot');
    expect(capabilities.supportsModelOverride).toBe(true);
  });

  it('parses commander.js-style effort choices `(choices: "low", "medium", "high", "xhigh")`', async () => {
    setHelpOutput(`
  --effort, --reasoning-effort <level>  Set the reasoning effort level (choices:
                                        "low", "medium", "high", "xhigh")
`);
    const capabilities = await discoverCopilotCapabilities('/usr/bin/copilot');
    expect(capabilities.effortLevels).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('rejects bogus tokens like `choices:` from the effort list', async () => {
    setHelpOutput(`
  --reasoning-effort <level>  Set effort (choices: "low", "high")
`);
    const capabilities = await discoverCopilotCapabilities('/usr/bin/copilot');
    // The pre-fix bug would have produced ['choices: "low"', '"high"'].
    expect(capabilities.effortLevels).toEqual(['low', 'high']);
  });

  it('returns conservative defaults when help invocation throws', async () => {
    const reject = (): Promise<{ stdout: string }> => {
      const promise = Promise.reject(new Error('ENOENT')) as Promise<{ stdout: string }>;
      promise.catch(() => {});
      return promise;
    };
    execMock.mockImplementation(reject);
    execFileMock.mockImplementation(reject);

    const capabilities = await discoverCopilotCapabilities('/missing/copilot');
    expect(capabilities.supportsModelOverride).toBe(false);
    expect(capabilities.effortLevels).toEqual([]);
  });

  describe('historical model discovery (events.jsonl tail)', () => {
    /** Real Copilot session.shutdown event shape (verified against 1.0.39) */
    function shutdownLine(currentModel: string, otherModel?: string): string {
      const modelMetrics: Record<string, unknown> = {
        [currentModel]: { requests: { count: 1 }, usage: { inputTokens: 100 } },
      };
      if (otherModel) {
        modelMetrics[otherModel] = { requests: { count: 1 } };
      }
      return JSON.stringify({
        type: 'session.shutdown',
        data: {
          shutdownType: 'routine',
          modelMetrics,
          currentModel,
          currentTokens: 25694,
        },
        id: 'evt-1',
        timestamp: '2026-04-12T19:16:07.524Z',
      });
    }

    function startLine(): string {
      return JSON.stringify({
        type: 'session.start',
        data: {
          sessionId: '685c7a29',
          version: 1,
          producer: 'copilot-agent',
          copilotVersion: '1.0.39',
        },
        id: 'evt-0',
        timestamp: '2026-04-12T19:02:18.075Z',
      });
    }

    it('extracts model from data.currentModel on session.shutdown', async () => {
      setHelpOutput('  --model <model> Set model\n');
      setSessionStore({
        'session-uuid-1': `${startLine()}\n${shutdownLine('gpt-5-mini')}\n`,
      });
      const capabilities = await discoverCopilotCapabilities('/usr/bin/copilot');
      expect(capabilities.models).toEqual(['gpt-5-mini']);
    });

    it('extracts model names from `modelMetrics` object keys', async () => {
      setHelpOutput('  --model <model> Set model\n');
      setSessionStore({
        'session-uuid-1': shutdownLine('gpt-5', 'gpt-5-mini') + '\n',
      });
      const capabilities = await discoverCopilotCapabilities('/usr/bin/copilot');
      expect(capabilities.models?.sort()).toEqual(['gpt-5', 'gpt-5-mini']);
    });

    it('returns models=undefined when no events carry model info', async () => {
      setHelpOutput('  --model <model> Set model\n');
      setSessionStore({
        'session-uuid-1': startLine() + '\n',
      });
      const capabilities = await discoverCopilotCapabilities('/usr/bin/copilot');
      expect(capabilities.models).toBeUndefined();
    });

    it('skips when sessions root is missing', async () => {
      setHelpOutput('  --model <model> Set model\n');
      // setSessionStore(null) -> existsSync=false
      const capabilities = await discoverCopilotCapabilities('/usr/bin/copilot');
      expect(capabilities.models).toBeUndefined();
    });
  });
});
