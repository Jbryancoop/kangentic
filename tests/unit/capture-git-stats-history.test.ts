/**
 * Tests that `captureGitStats` mirrors git diff stats to the usage_history
 * table in addition to the sessions table.
 *
 * The function is a small helper in `src/main/ipc/handlers/git-stats-capture.ts`
 * with three external dependencies: `simple-git` (mocked), `SessionRepository`
 * (interface mock), and `UsageHistoryRepository` (interface mock). No
 * `handleTaskMove` scaffolding is needed - testing through the surrounding
 * IPC handler would require mocking ~17 unrelated modules.
 *
 * Pins the regression risk identified in the audit: a developer could remove
 * the second `usageHistoryRepo.updateGitStats` call thinking it is redundant
 * with the session-repo write, silently dropping productivity stats from the
 * period selector for any deleted task.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task } from '../../src/shared/types';
import type { SessionRepository } from '../../src/main/db/repositories/session-repository';
import type { UsageHistoryRepository } from '../../src/main/db/repositories/usage-history-repository';

// ---------------------------------------------------------------------------
// Mock simple-git BEFORE importing the module under test (vi.mock is hoisted).
// ---------------------------------------------------------------------------

const mockDiffSummary = vi.fn(async () => ({
  insertions: 42,
  deletions: 7,
  changed: 3,
}));

vi.mock('simple-git', () => ({
  simpleGit: vi.fn(() => ({ diffSummary: mockDiffSummary })),
  default: vi.fn(() => ({ diffSummary: mockDiffSummary })),
}));

// ---------------------------------------------------------------------------
// Import under test (after the mock is registered)
// ---------------------------------------------------------------------------

import { captureGitStats } from '../../src/main/ipc/handlers/git-stats-capture';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-aaa00001',
    display_id: 1,
    title: 'My Git Task',
    description: '',
    swimlane_id: 'lane-doing',
    position: 0,
    agent: 'claude',
    session_id: null,
    worktree_path: '/mock/project/.kangentic/worktrees/my-git-task',
    branch_name: 'my-git-task',
    pr_number: null,
    pr_url: null,
    base_branch: 'main',
    use_worktree: null,
    labels: [],
    priority: 0,
    attachment_count: 0,
    archived_at: null,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeRepos() {
  const sessionUpdateGitStats = vi.fn();
  const historyUpdateGitStats = vi.fn();
  const sessionRepo = { updateGitStats: sessionUpdateGitStats } as unknown as SessionRepository;
  const usageHistoryRepo = { updateGitStats: historyUpdateGitStats } as unknown as UsageHistoryRepository;
  return { sessionRepo, usageHistoryRepo, sessionUpdateGitStats, historyUpdateGitStats };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('captureGitStats - history mirror', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDiffSummary.mockResolvedValue({ insertions: 42, deletions: 7, changed: 3 });
  });

  it('writes the same stats to BOTH SessionRepository and UsageHistoryRepository', async () => {
    const { sessionRepo, usageHistoryRepo, sessionUpdateGitStats, historyUpdateGitStats } = makeRepos();
    const task = makeTask();

    await captureGitStats(task, sessionRepo, usageHistoryRepo, 'record-001', '/mock/project', 'main');

    const expectedStats = { linesAdded: 42, linesRemoved: 7, filesChanged: 3 };
    expect(sessionUpdateGitStats).toHaveBeenCalledTimes(1);
    expect(historyUpdateGitStats).toHaveBeenCalledTimes(1);
    expect(sessionUpdateGitStats).toHaveBeenCalledWith('record-001', expectedStats);
    expect(historyUpdateGitStats).toHaveBeenCalledWith('record-001', expectedStats);
  });

  it('returns early without calling either repo when there is no git directory', async () => {
    const { sessionRepo, usageHistoryRepo, sessionUpdateGitStats, historyUpdateGitStats } = makeRepos();
    // No worktree_path AND no projectPath argument.
    const task = makeTask({ worktree_path: null });

    await captureGitStats(task, sessionRepo, usageHistoryRepo, 'record-001', null, 'main');

    expect(sessionUpdateGitStats).not.toHaveBeenCalled();
    expect(historyUpdateGitStats).not.toHaveBeenCalled();
  });

  it('uses the task worktree path when present, falling back to project path', async () => {
    const { sessionRepo, usageHistoryRepo } = makeRepos();
    const { simpleGit } = await import('simple-git');
    const simpleGitMock = vi.mocked(simpleGit);

    const taskWithWorktree = makeTask({ worktree_path: '/mock/worktree-A' });
    await captureGitStats(taskWithWorktree, sessionRepo, usageHistoryRepo, 'record-001', '/mock/project', 'main');
    expect(simpleGitMock).toHaveBeenLastCalledWith('/mock/worktree-A');

    simpleGitMock.mockClear();

    const taskWithoutWorktree = makeTask({ worktree_path: null });
    await captureGitStats(taskWithoutWorktree, sessionRepo, usageHistoryRepo, 'record-001', '/mock/project', 'main');
    expect(simpleGitMock).toHaveBeenLastCalledWith('/mock/project');
  });

  it('uses the task base_branch when set, falling back to defaultBaseBranch then "main"', async () => {
    const { sessionRepo, usageHistoryRepo } = makeRepos();

    // task.base_branch wins over defaultBaseBranch.
    const taskWithBase = makeTask({ base_branch: 'develop' });
    await captureGitStats(taskWithBase, sessionRepo, usageHistoryRepo, 'r1', '/mock/project', 'master');
    expect(mockDiffSummary).toHaveBeenLastCalledWith(['develop...']);

    // Falls back to defaultBaseBranch when task.base_branch is null.
    mockDiffSummary.mockClear();
    const taskNoBase = makeTask({ base_branch: null });
    await captureGitStats(taskNoBase, sessionRepo, usageHistoryRepo, 'r1', '/mock/project', 'release');
    expect(mockDiffSummary).toHaveBeenLastCalledWith(['release...']);

    // Falls back to "main" when both are null/undefined.
    mockDiffSummary.mockClear();
    await captureGitStats(taskNoBase, sessionRepo, usageHistoryRepo, 'r1', '/mock/project', undefined);
    expect(mockDiffSummary).toHaveBeenLastCalledWith(['main...']);
  });

  it('passes the diffSummary numbers through unchanged (no rounding/coercion)', async () => {
    const { sessionRepo, usageHistoryRepo, sessionUpdateGitStats, historyUpdateGitStats } = makeRepos();
    mockDiffSummary.mockResolvedValueOnce({ insertions: 0, deletions: 0, changed: 0 });

    await captureGitStats(makeTask(), sessionRepo, usageHistoryRepo, 'record-zero', '/mock/project', 'main');

    const expectedStats = { linesAdded: 0, linesRemoved: 0, filesChanged: 0 };
    expect(sessionUpdateGitStats).toHaveBeenCalledWith('record-zero', expectedStats);
    expect(historyUpdateGitStats).toHaveBeenCalledWith('record-zero', expectedStats);
  });
});
