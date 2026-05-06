/**
 * Unit tests for `src/devtools/main/lockfile.ts`.
 *
 * Verifies the per-worktree preview lockfile lifecycle:
 *   - writeLockfile creates `<projectRoot>/.kangentic/preview.lock` with
 *     the expected shape (pid, port, worktreePath, projectRoot,
 *     projectId, startedAt, kangenticVersion).
 *   - readLockfile round-trips the JSON and returns null on missing /
 *     corrupt files.
 *   - removeLockfile is idempotent (safe to call when no file exists).
 *   - isLockfilePidAlive delegates to the process-tree probe correctly:
 *     `process.pid` is alive; an unrealistically large PID is not.
 *
 * Mocks only the `electron.app` module so `app.getVersion()` returns a
 * predictable value. Does NOT mock the process-tree probe — `isAlive`
 * uses `process.kill(pid, 0)` which works in plain Node tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '9.9.9') },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

let tempDirectory: string;
let projectRoot: string;

beforeEach(() => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'devtools-lockfile-test-'));
  projectRoot = tempDirectory;
  vi.resetModules();
});

afterEach(() => {
  try {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe('devtools/lockfile', () => {
  it('writes a lockfile with the expected shape', async () => {
    const { writeLockfile, readLockfile } = await import(
      '../../src/devtools/main/lockfile'
    );

    writeLockfile({
      projectRoot,
      port: 51234,
      worktreePath: projectRoot,
      projectId: 'proj-uuid-1',
    });

    const file = path.join(projectRoot, '.kangentic', 'preview.lock');
    expect(fs.existsSync(file)).toBe(true);

    const record = readLockfile(projectRoot);
    expect(record).not.toBeNull();
    expect(record!.pid).toBe(process.pid);
    expect(record!.port).toBe(51234);
    expect(record!.worktreePath).toBe(projectRoot);
    expect(record!.projectRoot).toBe(projectRoot);
    expect(record!.projectId).toBe('proj-uuid-1');
    expect(record!.kangenticVersion).toBe('9.9.9');
    expect(typeof record!.startedAt).toBe('string');
  });

  it('returns null when the lockfile does not exist', async () => {
    const { readLockfile } = await import('../../src/devtools/main/lockfile');
    expect(readLockfile(projectRoot)).toBeNull();
  });

  it('returns null when the lockfile is malformed JSON', async () => {
    const { readLockfile } = await import('../../src/devtools/main/lockfile');
    const directory = path.join(projectRoot, '.kangentic');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'preview.lock'), '{not json}', 'utf-8');
    expect(readLockfile(projectRoot)).toBeNull();
  });

  it('returns null when the lockfile is missing required fields', async () => {
    const { readLockfile } = await import('../../src/devtools/main/lockfile');
    const directory = path.join(projectRoot, '.kangentic');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, 'preview.lock'),
      JSON.stringify({ pid: 123 }),
      'utf-8',
    );
    expect(readLockfile(projectRoot)).toBeNull();
  });

  it('removeLockfile is idempotent', async () => {
    const { writeLockfile, removeLockfile } = await import(
      '../../src/devtools/main/lockfile'
    );

    // No-op when nothing exists.
    expect(() => removeLockfile(projectRoot)).not.toThrow();

    writeLockfile({
      projectRoot,
      port: 51234,
      worktreePath: projectRoot,
      projectId: 'proj-uuid-1',
    });
    const file = path.join(projectRoot, '.kangentic', 'preview.lock');
    expect(fs.existsSync(file)).toBe(true);

    removeLockfile(projectRoot);
    expect(fs.existsSync(file)).toBe(false);

    // Second remove is also a no-op.
    expect(() => removeLockfile(projectRoot)).not.toThrow();
  });

  it('isLockfilePidAlive returns true for our own PID and false for an obviously dead PID', async () => {
    const { isLockfilePidAlive } = await import('../../src/devtools/main/lockfile');
    const liveRecord = {
      pid: process.pid,
      port: 1,
      worktreePath: '',
      projectRoot: '',
      projectId: '',
      startedAt: '',
      kangenticVersion: '',
    };
    expect(isLockfilePidAlive(liveRecord)).toBe(true);

    // PID 0x7FFFFFFE is "very high"; an OS that hasn't reached this PID
    // counter (i.e. essentially every system) reports it as dead.
    const deadRecord = { ...liveRecord, pid: 2147483646 };
    expect(isLockfilePidAlive(deadRecord)).toBe(false);
  });
});
