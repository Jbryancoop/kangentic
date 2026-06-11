/**
 * Unit tests for probePendingChanges -- the Done-move probe that reports
 * uncommitted files, unpushed commits (gated on the repo having a remote), and
 * the worktree's live HEAD branch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The probe builds a simple-git instance and calls status() / getRemotes() /
// raw(). One shared mock object so each test configures the responses.
const mockGit = {
  status: vi.fn<() => Promise<{ files: unknown[] }>>(),
  getRemotes: vi.fn<() => Promise<unknown[]>>(),
  raw: vi.fn<(args: string[]) => Promise<string>>(),
};

vi.mock('simple-git', () => ({
  default: vi.fn(() => mockGit),
}));

// currentBranch comes from readWorktreeHead; mock it directly so the probe
// tests don't need a real repo for HEAD resolution.
const mockReadWorktreeHead = vi.fn<(path: string) => Promise<{ branch: string | null; sha: string | null }>>();
vi.mock('../../src/main/git/worktree-head', () => ({
  readWorktreeHead: (path: string) => mockReadWorktreeHead(path),
}));

// git-diff.ts imports these at module scope; stub them so the import resolves
// without Electron or real git wiring (the handler registration is unused here).
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));
vi.mock('../../src/main/git/diff-service', () => ({ DiffService: class {} }));
vi.mock('../../src/main/git/diff-watcher', () => ({ DiffWatcher: class {} }));

import { probePendingChanges } from '../../src/main/ipc/handlers/git-diff';

describe('probePendingChanges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGit.status.mockResolvedValue({ files: [] });
    mockGit.getRemotes.mockResolvedValue([]);
    mockGit.raw.mockResolvedValue('0');
    mockReadWorktreeHead.mockResolvedValue({ branch: 'feat/work', sha: 'abc123' });
  });

  it('counts uncommitted files from git status', async () => {
    mockGit.status.mockResolvedValue({ files: [{}, {}, {}] });

    const result = await probePendingChanges('/mock/worktree');

    expect(result.uncommittedFileCount).toBe(3);
    expect(result.hasPendingChanges).toBe(true);
  });

  it('reports the live HEAD branch', async () => {
    mockReadWorktreeHead.mockResolvedValue({ branch: 'feat/renamed', sha: 'deadbeef' });

    const result = await probePendingChanges('/mock/worktree');

    expect(result.currentBranch).toBe('feat/renamed');
  });

  it('returns null currentBranch on a detached HEAD', async () => {
    mockReadWorktreeHead.mockResolvedValue({ branch: null, sha: 'detached00' });

    const result = await probePendingChanges('/mock/worktree');

    expect(result.currentBranch).toBeNull();
  });

  it('skips the unpushed count entirely when the repo has no remotes', async () => {
    mockGit.getRemotes.mockResolvedValue([]);

    const result = await probePendingChanges('/mock/worktree');

    // rev-list must never run with no remotes (it would count all of history).
    expect(mockGit.raw).not.toHaveBeenCalled();
    expect(result.unpushedCommitCount).toBe(0);
  });

  it('counts unpushed commits when at least one remote exists', async () => {
    mockGit.getRemotes.mockResolvedValue([{ name: 'origin' }]);
    mockGit.raw.mockResolvedValue('4\n');

    const result = await probePendingChanges('/mock/worktree');

    expect(mockGit.raw).toHaveBeenCalledWith(['rev-list', 'HEAD', '--not', '--remotes', '--count']);
    expect(result.unpushedCommitCount).toBe(4);
    expect(result.hasPendingChanges).toBe(true);
  });

  it('treats a rev-list failure (unborn / detached) as zero unpushed', async () => {
    mockGit.getRemotes.mockResolvedValue([{ name: 'origin' }]);
    mockGit.raw.mockRejectedValue(new Error('unknown revision HEAD'));

    const result = await probePendingChanges('/mock/worktree');

    expect(result.unpushedCommitCount).toBe(0);
  });

  it('reports no pending changes for a clean worktree with no remotes', async () => {
    mockGit.status.mockResolvedValue({ files: [] });
    mockGit.getRemotes.mockResolvedValue([]);

    const result = await probePendingChanges('/mock/worktree');

    expect(result.hasPendingChanges).toBe(false);
    expect(result.uncommittedFileCount).toBe(0);
    expect(result.unpushedCommitCount).toBe(0);
  });

  it('returns a safe default when git status throws', async () => {
    mockGit.status.mockRejectedValue(new Error('not a git repository'));

    const result = await probePendingChanges('/mock/worktree');

    expect(result).toEqual({
      hasPendingChanges: true,
      uncommittedFileCount: 0,
      unpushedCommitCount: 0,
      currentBranch: null,
    });
  });

  // -------------------------------------------------------------------------
  // Outer-catch branches: failures that happen AFTER status() succeeds.
  //
  // The outer try/catch in probePendingChanges is structured so that any
  // exception thrown after `git.status()` (e.g. from readWorktreeHead or
  // git.getRemotes) still lands in the same catch block and returns the safe
  // default. These tests confirm that the fallback fires for post-status
  // failures, not just for the status() call itself.
  // -------------------------------------------------------------------------

  it('returns a safe default when getRemotes() rejects after status() succeeds', async () => {
    // status() succeeds; getRemotes() throws (network / corrupted repo config).
    // The outer catch must return the all-null safe default.
    mockGit.status.mockResolvedValue({ files: [{}] });
    mockGit.getRemotes.mockRejectedValue(new Error('could not read git config'));

    const result = await probePendingChanges('/mock/worktree');

    expect(result).toEqual({
      hasPendingChanges: true,
      uncommittedFileCount: 0,
      unpushedCommitCount: 0,
      currentBranch: null,
    });
  });

  it('returns a safe default when readWorktreeHead rejects after status() succeeds', async () => {
    // status() succeeds; readWorktreeHead throws (unexpected error from the
    // helper -- normally it swallows its own errors, but if a future change
    // causes it to propagate, the outer catch must still protect the caller).
    mockGit.status.mockResolvedValue({ files: [] });
    mockReadWorktreeHead.mockRejectedValue(new Error('unexpected read failure'));

    const result = await probePendingChanges('/mock/worktree');

    expect(result).toEqual({
      hasPendingChanges: true,
      uncommittedFileCount: 0,
      unpushedCommitCount: 0,
      currentBranch: null,
    });
  });
});
