/**
 * Capability discovery for Qwen Code: parses `qwen --help` for static
 * support and walks `~/.qwen/projects/<project>/chats/<sessionId>.jsonl`
 * for model identifiers.
 *
 * Qwen ships two model-bearing event shapes:
 *   - assistant messages: top-level `obj.model`
 *   - `systemPayload.uiEvent.model` on `ui_telemetry` events
 * The parser probes both, so a real-shape fixture for each protects
 * against future schema drift.
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
import { discoverQwenCapabilities } from '../../src/main/agent/adapters/qwen-code/capability-discovery';

const execMock = exec as unknown as ReturnType<typeof vi.fn>;
const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;
const existsMock = fs.existsSync as unknown as ReturnType<typeof vi.fn>;
const readdirMock = fs.readdirSync as unknown as ReturnType<typeof vi.fn>;
const statMock = fs.statSync as unknown as ReturnType<typeof vi.fn>;
const openMock = fs.openSync as unknown as ReturnType<typeof vi.fn>;
const readMock = fs.readSync as unknown as ReturnType<typeof vi.fn>;
const closeMock = fs.closeSync as unknown as ReturnType<typeof vi.fn>;

const PROJECTS_ROOT = path.join(os.homedir(), '.qwen', 'projects');

function setHelpOutput(stdout: string): void {
  const result = Promise.resolve({ stdout });
  execMock.mockReturnValue(result);
  execFileMock.mockReturnValue(result);
}

/** Layout: `<root>/<project-hash>/chats/<sessionId>.jsonl` */
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

    if (dirPath === PROJECTS_ROOT) {
      const projects = Object.keys(store);
      return options?.withFileTypes ? asDirents(projects) : projects;
    }
    for (const project of Object.keys(store)) {
      const chatsPath = path.join(PROJECTS_ROOT, project, 'chats');
      if (dirPath === chatsPath) {
        return Object.keys(store[project]);
      }
    }
    throw new Error(`Unexpected readdir: ${dirPath}`);
  });

  statMock.mockImplementation((targetPath: string) => {
    for (const project of Object.keys(store)) {
      const chatsPath = path.join(PROJECTS_ROOT, project, 'chats');
      if (targetPath === chatsPath) {
        return { mtimeMs: Date.now(), size: 0 } as fs.Stats;
      }
    }
    return { mtimeMs: Date.now(), size: 4096 } as fs.Stats;
  });

  openMock.mockImplementation((filePath: string) => {
    for (const [project, files] of Object.entries(store)) {
      for (const [file, contents] of Object.entries(files)) {
        const full = path.join(PROJECTS_ROOT, project, 'chats', file);
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

describe('discoverQwenCapabilities', () => {
  it('detects --model flag from --help output', async () => {
    setHelpOutput(`
  -m, --model              Model  [string]
  -p, --prompt             Prompt
`);
    const capabilities = await discoverQwenCapabilities('/usr/bin/qwen');
    expect(capabilities.supportsModelOverride).toBe(true);
  });

  it('returns empty effortLevels (Qwen has no effort)', async () => {
    setHelpOutput('  -m, --model Model\n');
    const capabilities = await discoverQwenCapabilities('/usr/bin/qwen');
    expect(capabilities.effortLevels).toEqual([]);
  });

  describe('historical model discovery', () => {
    /** Real Qwen JSONL: assistant messages carry top-level `model` */
    function assistantLine(model: string): string {
      return JSON.stringify({
        uuid: 'msg-1',
        sessionId: 'sess-1',
        timestamp: '2026-04-26T20:18:36.836Z',
        type: 'assistant',
        version: '0.15.3',
        model,
        message: { role: 'model', parts: [{ text: 'hi' }] },
      });
    }

    /** ui_telemetry event: model lives at systemPayload.uiEvent.model */
    function uiTelemetryLine(model: string): string {
      return JSON.stringify({
        uuid: 'tel-1',
        sessionId: 'sess-1',
        timestamp: '2026-04-26T20:18:36.721Z',
        type: 'system',
        version: '0.15.3',
        subtype: 'ui_telemetry',
        systemPayload: {
          uiEvent: {
            'event.name': 'qwen-code.api_response',
            response_id: 'msg_01',
            model,
            status_code: 200,
          },
        },
      });
    }

    function userLine(): string {
      return JSON.stringify({
        uuid: 'u-1',
        sessionId: 'sess-1',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'test' }] },
      });
    }

    it('extracts models from top-level `model` on assistant messages', async () => {
      setHelpOutput('  -m, --model Model\n');
      setSessionStore({
        'c--users-tyler-documents-github-kangentic': {
          'sess-1.jsonl': `${userLine()}\n${assistantLine('claude-sonnet-4-6')}\n`,
        },
      });

      const capabilities = await discoverQwenCapabilities('/usr/bin/qwen');
      expect(capabilities.models).toEqual(['claude-sonnet-4-6']);
    });

    it('extracts models from systemPayload.uiEvent.model on ui_telemetry events', async () => {
      setHelpOutput('  -m, --model Model\n');
      setSessionStore({
        'c--users-tyler-documents-github-kangentic': {
          'sess-1.jsonl': uiTelemetryLine('qwen3-coder-plus') + '\n',
        },
      });

      const capabilities = await discoverQwenCapabilities('/usr/bin/qwen');
      expect(capabilities.models).toEqual(['qwen3-coder-plus']);
    });

    it('dedupes models that appear in both shapes', async () => {
      setHelpOutput('  -m, --model Model\n');
      setSessionStore({
        'c--users-tyler-documents-github-kangentic': {
          'sess-1.jsonl': [
            uiTelemetryLine('claude-sonnet-4-6'),
            assistantLine('claude-sonnet-4-6'),
          ].join('\n') + '\n',
        },
      });

      const capabilities = await discoverQwenCapabilities('/usr/bin/qwen');
      expect(capabilities.models).toEqual(['claude-sonnet-4-6']);
    });

    it('returns models=undefined when sessions exist but lack model fields', async () => {
      setHelpOutput('  -m, --model Model\n');
      setSessionStore({
        'c--users-tyler-documents-github-kangentic': {
          'sess-1.jsonl': userLine() + '\n',
        },
      });

      const capabilities = await discoverQwenCapabilities('/usr/bin/qwen');
      expect(capabilities.models).toBeUndefined();
    });
  });
});
