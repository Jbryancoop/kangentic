/**
 * Unit tests for the zombie reaper (dev-only boot sweep + production
 * per-worktree reap).
 *
 * Covers:
 *   - Self-skip: own PID never killed
 *   - Parent-skip: walked parent chain never killed
 *   - Path matching: worktree path + main checkout path patterns
 *   - Per-worktree scoped match: specific worktree path, trailing-separator
 *     boundary, orphan gate, node-and-electron processes
 *   - Negative match: unrelated electron processes left alone
 *   - Defensive aborts: scan failure / self-walk failure return [] cleanly
 *   - Scan cache: a burst of reaps shares one OS enumeration
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildSelfSkipSet,
  findZombies,
  findWorktreePathProcesses,
  reapWorktreeElectronZombies,
  reapProcessesForWorktree,
  scanProcessesCached,
  __resetScanCacheForTest,
  _internals,
  type ProcessRow,
} from '../../src/main/git/zombie-reaper';

const PROJECT_PATH = process.platform === 'win32'
  ? 'C:\\Users\\dev\\kangentic'
  : '/Users/dev/kangentic';

function asWorktreeCmd(slug: string, extra = ''): string {
  const sep = process.platform === 'win32' ? '\\' : '/';
  return `${PROJECT_PATH}${sep}.kangentic${sep}worktrees${sep}${slug}${sep}node_modules${sep}electron${sep}dist${sep}electron.exe ${extra}`.trim();
}

function worktreePathFor(slug: string): string {
  const sep = process.platform === 'win32' ? '\\' : '/';
  return `${PROJECT_PATH}${sep}.kangentic${sep}worktrees${sep}${slug}`;
}

function asWorktreeNodeCmd(slug: string): string {
  const sep = process.platform === 'win32' ? '\\' : '/';
  return `node ${PROJECT_PATH}${sep}.kangentic${sep}worktrees${sep}${slug}${sep}scripts${sep}run-tests.js`;
}

function asMainCheckoutCmd(extra = ''): string {
  const sep = process.platform === 'win32' ? '\\' : '/';
  return `${PROJECT_PATH}${sep}node_modules${sep}electron${sep}dist${sep}electron.exe ${extra}`.trim();
}

describe('buildSelfSkipSet', () => {
  it('includes the current PID', () => {
    const rows: ProcessRow[] = [{ pid: 100, ppid: 50, commandLine: 'node main.js' }];
    const skip = buildSelfSkipSet(rows, 100);
    expect(skip.has(100)).toBe(true);
  });

  it('walks the parent chain', () => {
    const rows: ProcessRow[] = [
      { pid: 100, ppid: 50, commandLine: 'electron' },
      { pid: 50, ppid: 10, commandLine: 'npm' },
      { pid: 10, ppid: 1, commandLine: 'shell' },
    ];
    const skip = buildSelfSkipSet(rows, 100);
    expect(skip.has(100)).toBe(true);
    expect(skip.has(50)).toBe(true);
    expect(skip.has(10)).toBe(true);
    expect(skip.has(1)).toBe(false); // ppid <= 1 stops walk
  });

  it('does not loop on cycles', () => {
    const rows: ProcessRow[] = [
      { pid: 100, ppid: 50, commandLine: 'a' },
      { pid: 50, ppid: 100, commandLine: 'b' }, // cycle!
    ];
    const skip = buildSelfSkipSet(rows, 100);
    expect(skip.has(100)).toBe(true);
    expect(skip.has(50)).toBe(true);
    // No infinite loop, returns
  });
});

describe('findZombies', () => {
  it('matches a worktree-path electron process when parent is dead', () => {
    // ppid=1 (init/system) means parent died; this is a true orphan
    const rows: ProcessRow[] = [
      { pid: 200, ppid: 1, commandLine: asWorktreeCmd('feature-abc-1234') },
    ];
    const result = findZombies(rows, PROJECT_PATH, new Set());
    expect(result).toHaveLength(1);
    expect(result[0].pid).toBe(200);
    expect(result[0].reason).toBe('worktree-orphan');
  });

  it('matches a main-checkout electron process when parent is dead', () => {
    const rows: ProcessRow[] = [
      { pid: 300, ppid: 1, commandLine: asMainCheckoutCmd('--type=gpu-process') },
    ];
    const result = findZombies(rows, PROJECT_PATH, new Set());
    expect(result).toHaveLength(1);
    expect(result[0].pid).toBe(300);
    expect(result[0].reason).toBe('main-checkout-orphan');
  });

  it('skips electron process when parent is still alive (sibling-process safety)', () => {
    // ppid=999 IS in the row list = parent alive = NOT a zombie. This
    // protects the dogfooding npm start window, concurrent Playwright
    // workers, and /preview instances from being killed.
    const rows: ProcessRow[] = [
      { pid: 999, ppid: 1, commandLine: 'npm start (live parent)' },
      { pid: 300, ppid: 999, commandLine: asMainCheckoutCmd('--type=gpu-process') },
    ];
    const result = findZombies(rows, PROJECT_PATH, new Set());
    expect(result).toHaveLength(0);
  });

  it('skips PIDs in the self-skip set', () => {
    const rows: ProcessRow[] = [
      { pid: 200, ppid: 1, commandLine: asWorktreeCmd('feature-abc-1234') },
      { pid: 300, ppid: 1, commandLine: asMainCheckoutCmd() },
    ];
    const result = findZombies(rows, PROJECT_PATH, new Set([200, 300]));
    expect(result).toHaveLength(0);
  });

  it('does not match an unrelated electron process from a different checkout', () => {
    const otherProject = process.platform === 'win32'
      ? 'C:\\Users\\dev\\some-other-app\\node_modules\\electron\\dist\\electron.exe'
      : '/Users/dev/some-other-app/node_modules/electron/dist/electron.exe';
    const rows: ProcessRow[] = [{ pid: 400, ppid: 1, commandLine: otherProject }];
    const result = findZombies(rows, PROJECT_PATH, new Set());
    expect(result).toHaveLength(0);
  });

  it('does not match an empty CommandLine', () => {
    const rows: ProcessRow[] = [{ pid: 500, ppid: 1, commandLine: '' }];
    const result = findZombies(rows, PROJECT_PATH, new Set());
    expect(result).toHaveLength(0);
  });

  it('case-insensitive match on Windows', () => {
    if (process.platform !== 'win32') return;
    const lowercased = asWorktreeCmd('feature-abc-1234').toLowerCase();
    const uppercased = lowercased.replace('c:\\users\\dev', 'C:\\Users\\Dev');
    const rows: ProcessRow[] = [{ pid: 600, ppid: 1, commandLine: uppercased }];
    const result = findZombies(rows, PROJECT_PATH, new Set());
    expect(result).toHaveLength(1);
  });
});

describe('reapWorktreeElectronZombies', () => {
  let scanSpy: ReturnType<typeof vi.spyOn>;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // vi.spyOn reuses an existing spy on the same property -- restore
    // first so each test gets a clean spy with no carried call history.
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    scanSpy = vi.spyOn(_internals, 'scanProcesses');
    killSpy = vi.spyOn(_internals, 'killProcess').mockResolvedValue(undefined);
  });

  it('returns empty array when scan throws', async () => {
    scanSpy.mockRejectedValue(new Error('powershell not found'));

    const result = await reapWorktreeElectronZombies({ projectPath: PROJECT_PATH });

    expect(result).toEqual([]);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('returns empty array when scan returns no rows', async () => {
    scanSpy.mockResolvedValue([]);

    const result = await reapWorktreeElectronZombies({ projectPath: PROJECT_PATH });

    expect(result).toEqual([]);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('kills a worktree-orphan electron process', async () => {
    scanSpy.mockResolvedValue([
      { pid: 200, ppid: 1, commandLine: asWorktreeCmd('feature-abc-1234') },
    ]);

    const result = await reapWorktreeElectronZombies({ projectPath: PROJECT_PATH });

    expect(result).toHaveLength(1);
    expect(result[0].pid).toBe(200);
    expect(killSpy).toHaveBeenCalledWith(200);
  });

  it('kills a main-checkout-orphan electron process', async () => {
    scanSpy.mockResolvedValue([
      { pid: 300, ppid: 1, commandLine: asMainCheckoutCmd('--type=gpu-process') },
    ]);

    const result = await reapWorktreeElectronZombies({ projectPath: PROJECT_PATH });

    expect(result).toHaveLength(1);
    expect(result[0].pid).toBe(300);
    expect(killSpy).toHaveBeenCalledWith(300);
  });

  it('skips own PID even if it matches the path pattern', async () => {
    scanSpy.mockResolvedValue([
      { pid: process.pid, ppid: 1, commandLine: asMainCheckoutCmd() },
    ]);

    const result = await reapWorktreeElectronZombies({ projectPath: PROJECT_PATH });

    expect(result).toEqual([]);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('skips parent PID even if it matches the path pattern', async () => {
    scanSpy.mockResolvedValue([
      { pid: process.pid, ppid: 9999, commandLine: 'node child' },
      { pid: 9999, ppid: 1, commandLine: asMainCheckoutCmd() },
    ]);

    const result = await reapWorktreeElectronZombies({ projectPath: PROJECT_PATH });

    expect(result).toEqual([]);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('continues sweeping when one kill fails', async () => {
    scanSpy.mockResolvedValue([
      { pid: 200, ppid: 1, commandLine: asWorktreeCmd('feature-1') },
      { pid: 201, ppid: 1, commandLine: asWorktreeCmd('feature-2') },
    ]);
    killSpy
      .mockRejectedValueOnce(new Error('access denied'))
      .mockResolvedValueOnce(undefined);

    const result = await reapWorktreeElectronZombies({ projectPath: PROJECT_PATH });

    expect(killSpy).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(1); // only the successful kill
    expect(result[0].pid).toBe(201);
  });
});

describe('findWorktreePathProcesses', () => {
  const worktreePath = worktreePathFor('feature-abc-1234');

  it('matches an orphaned electron process under the specific worktree path', () => {
    const rows: ProcessRow[] = [
      { pid: 200, ppid: 1, commandLine: asWorktreeCmd('feature-abc-1234') },
    ];
    const result = findWorktreePathProcesses(rows, worktreePath, new Set());
    expect(result).toHaveLength(1);
    expect(result[0].pid).toBe(200);
    expect(result[0].reason).toBe('worktree-path-orphan');
  });

  it('matches an orphaned node process under the worktree (not only electron)', () => {
    const rows: ProcessRow[] = [
      { pid: 210, ppid: 1, commandLine: asWorktreeNodeCmd('feature-abc-1234') },
    ];
    const result = findWorktreePathProcesses(rows, worktreePath, new Set());
    expect(result).toHaveLength(1);
    expect(result[0].pid).toBe(210);
  });

  it('does NOT match a prefix-sibling worktree (trailing-separator boundary)', () => {
    // worktrees/feature-abc-1234 must never match worktrees/feature-abc-1234-x.
    const rows: ProcessRow[] = [
      { pid: 220, ppid: 1, commandLine: asWorktreeCmd('feature-abc-1234-extra') },
    ];
    const result = findWorktreePathProcesses(rows, worktreePath, new Set());
    expect(result).toHaveLength(0);
  });

  it('skips a process whose parent is still alive (orphan gate)', () => {
    const rows: ProcessRow[] = [
      { pid: 999, ppid: 1, commandLine: 'playwright worker (live parent)' },
      { pid: 200, ppid: 999, commandLine: asWorktreeCmd('feature-abc-1234') },
    ];
    const result = findWorktreePathProcesses(rows, worktreePath, new Set());
    expect(result).toHaveLength(0);
  });

  it('skips PIDs in the self-skip set', () => {
    const rows: ProcessRow[] = [
      { pid: 200, ppid: 1, commandLine: asWorktreeCmd('feature-abc-1234') },
    ];
    const result = findWorktreePathProcesses(rows, worktreePath, new Set([200]));
    expect(result).toHaveLength(0);
  });

  it('does not match an empty CommandLine', () => {
    const rows: ProcessRow[] = [{ pid: 200, ppid: 1, commandLine: '' }];
    const result = findWorktreePathProcesses(rows, worktreePath, new Set());
    expect(result).toHaveLength(0);
  });

  it('case-insensitive match on Windows', () => {
    if (process.platform !== 'win32') return;
    const uppercased = asWorktreeCmd('feature-abc-1234').replace('c:\\users\\dev', 'C:\\Users\\Dev');
    const rows: ProcessRow[] = [{ pid: 200, ppid: 1, commandLine: uppercased }];
    const result = findWorktreePathProcesses(rows, worktreePath, new Set());
    expect(result).toHaveLength(1);
  });
});

describe('reapProcessesForWorktree', () => {
  const worktreePath = worktreePathFor('feature-abc-1234');
  let scanCachedSpy: ReturnType<typeof vi.spyOn>;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    __resetScanCacheForTest();
    scanCachedSpy = vi.spyOn(_internals, 'scanProcessesCached');
    killSpy = vi.spyOn(_internals, 'killProcess').mockResolvedValue(undefined);
  });

  it('kills an orphaned process pinning the worktree', async () => {
    scanCachedSpy.mockResolvedValue([
      { pid: 200, ppid: 1, commandLine: asWorktreeCmd('feature-abc-1234') },
    ]);

    const result = await reapProcessesForWorktree({ worktreePath });

    expect(result).toHaveLength(1);
    expect(result[0].pid).toBe(200);
    expect(killSpy).toHaveBeenCalledWith(200);
  });

  it('returns [] without killing when the scan throws', async () => {
    scanCachedSpy.mockRejectedValue(new Error('powershell not found'));

    const result = await reapProcessesForWorktree({ worktreePath });

    expect(result).toEqual([]);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('never kills own PID or the parent chain', async () => {
    scanCachedSpy.mockResolvedValue([
      { pid: process.pid, ppid: 9999, commandLine: asWorktreeCmd('feature-abc-1234') },
      { pid: 9999, ppid: 1, commandLine: asWorktreeCmd('feature-abc-1234') },
    ]);

    const result = await reapProcessesForWorktree({ worktreePath });

    expect(result).toEqual([]);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('continues sweeping when one kill fails', async () => {
    scanCachedSpy.mockResolvedValue([
      { pid: 200, ppid: 1, commandLine: asWorktreeCmd('feature-abc-1234') },
      { pid: 201, ppid: 1, commandLine: asWorktreeNodeCmd('feature-abc-1234') },
    ]);
    killSpy
      .mockRejectedValueOnce(new Error('access denied'))
      .mockResolvedValueOnce(undefined);

    const result = await reapProcessesForWorktree({ worktreePath });

    expect(killSpy).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(1);
    expect(result[0].pid).toBe(201);
  });
});

describe('scanProcessesCached', () => {
  let scanSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    __resetScanCacheForTest();
    scanSpy = vi.spyOn(_internals, 'scanProcesses');
  });

  it('scans once for two calls within the TTL', async () => {
    scanSpy.mockResolvedValue([{ pid: 1, ppid: 0, commandLine: 'init' }]);

    const first = await scanProcessesCached(1500);
    const second = await scanProcessesCached(1500);

    expect(scanSpy).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('does not cache an empty (failed) scan', async () => {
    scanSpy.mockResolvedValueOnce([]);
    scanSpy.mockResolvedValueOnce([{ pid: 1, ppid: 0, commandLine: 'init' }]);

    const first = await scanProcessesCached(1500);
    const second = await scanProcessesCached(1500);

    expect(first).toEqual([]);
    expect(second).toHaveLength(1);
    expect(scanSpy).toHaveBeenCalledTimes(2);
  });
});
