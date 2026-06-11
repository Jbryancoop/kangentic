import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock WorktreeManager: the helper constructs `new WorktreeManager(projectPath)`
// and calls `withLock(fn)` + `removeWorktree(path)`. We capture the last-created
// instance so each test can configure its behavior and assert against it.
const { worktreeManagerInstances, mockRemoveWorktree } = vi.hoisted(() => ({
  worktreeManagerInstances: [] as Array<{ removeWorktree: ReturnType<typeof vi.fn>; withLock: ReturnType<typeof vi.fn> }>,
  mockRemoveWorktree: vi.fn<(path: string) => Promise<boolean>>(),
}));

vi.mock('../../src/main/git/worktree-manager', () => ({
  WorktreeManager: class {
    removeWorktree = mockRemoveWorktree;
    withLock = vi.fn(async (operation: () => Promise<unknown>) => operation());
    constructor() {
      worktreeManagerInstances.push({ removeWorktree: this.removeWorktree, withLock: this.withLock });
    }
  },
}));

// Mock the live-HEAD reader so each test controls the branch/sha the helper
// captures before removal, without a real git repo.
const { mockReadWorktreeHead } = vi.hoisted(() => ({
  mockReadWorktreeHead: vi.fn<(path: string) => Promise<{ branch: string | null; sha: string | null }>>(),
}));

vi.mock('../../src/main/git/worktree-head', () => ({
  readWorktreeHead: mockReadWorktreeHead,
}));

// DB-layer mocks aren't exercised by deleteTaskWorktree (it doesn't touch the
// session repo or DB), but the module imports them at the top level.
vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(),
}));
vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {},
}));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {},
}));

import { deleteTaskWorktree } from '../../src/main/ipc/helpers/task-cleanup';

type MockTaskRepo = { update: ReturnType<typeof vi.fn>; getById: ReturnType<typeof vi.fn> };
type MockContext = {
  currentProjectPath: string | null;
  sessionManager: Record<string, unknown>;
  configManager: Record<string, unknown>;
};

function createMockTaskRepo(): MockTaskRepo {
  // getById defaults to truthy so the branch write-back's concurrent-delete
  // guard passes; tests that exercise the guard override it.
  return { update: vi.fn(), getById: vi.fn(() => ({ id: 'task' })) };
}

function createMockContext(overrides: Partial<MockContext> = {}): MockContext {
  return {
    currentProjectPath: '/mock/project',
    sessionManager: {},
    configManager: {},
    ...overrides,
  };
}

describe('deleteTaskWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    worktreeManagerInstances.length = 0;
    mockRemoveWorktree.mockReset();
    // Default: detached / unreadable HEAD (matches a worktree git can't probe).
    mockReadWorktreeHead.mockReset();
    mockReadWorktreeHead.mockResolvedValue({ branch: null, sha: null });
  });

  it('removes the worktree dir and nulls worktree_path, preserving branch_name', async () => {
    const tasks = createMockTaskRepo();
    const context = createMockContext();
    const task = {
      id: 'task-1',
      worktree_path: '/mock/project/.kangentic/worktrees/task-1-abcd',
      branch_name: 'feature-x-abcd',
    };

    mockRemoveWorktree.mockResolvedValue(true);

    const result = await deleteTaskWorktree(context as never, task, tasks as never, context.currentProjectPath);

    expect(result).toBe(true);
    expect(mockRemoveWorktree).toHaveBeenCalledWith(task.worktree_path);
    expect(tasks.update).toHaveBeenCalledTimes(1);
    expect(tasks.update).toHaveBeenCalledWith({ id: 'task-1', worktree_path: null });
    // Critical: branch_name is NOT cleared. Moving out of Done re-creates the
    // worktree from the preserved branch.
    const updateArgs = tasks.update.mock.calls[0][0] as Record<string, unknown>;
    expect(updateArgs).not.toHaveProperty('branch_name');
    expect(updateArgs).not.toHaveProperty('session_id');
  });

  it('returns false and is a no-op when task has no worktree_path', async () => {
    const tasks = createMockTaskRepo();
    const context = createMockContext();
    const task = { id: 'task-2', worktree_path: null, branch_name: 'something-else' };

    const result = await deleteTaskWorktree(context as never, task, tasks as never, context.currentProjectPath);

    expect(result).toBe(false);
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
    expect(tasks.update).not.toHaveBeenCalled();
  });

  it('returns false and is a no-op when no project path is available', async () => {
    const tasks = createMockTaskRepo();
    const context = createMockContext({ currentProjectPath: null });
    const task = {
      id: 'task-3',
      worktree_path: '/some/path',
      branch_name: 'branch-3',
    };

    const result = await deleteTaskWorktree(context as never, task, tasks as never, null);

    expect(result).toBe(false);
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
    expect(tasks.update).not.toHaveBeenCalled();
  });

  it('returns false and does not null worktree_path when the directory could not be removed', async () => {
    const tasks = createMockTaskRepo();
    const context = createMockContext();
    const task = {
      id: 'task-4',
      worktree_path: '/mock/project/.kangentic/worktrees/task-4-abcd',
      branch_name: 'branch-4',
    };

    mockRemoveWorktree.mockResolvedValue(false);

    const result = await deleteTaskWorktree(context as never, task, tasks as never, context.currentProjectPath);

    expect(result).toBe(false);
    expect(mockRemoveWorktree).toHaveBeenCalled();
    // worktree_path preserved so the next attempt retries the removal
    expect(tasks.update).not.toHaveBeenCalled();
  });

  it('swallows worktree manager errors, returns false, and leaves DB unchanged', async () => {
    const tasks = createMockTaskRepo();
    const context = createMockContext();
    const task = {
      id: 'task-5',
      worktree_path: '/mock/project/.kangentic/worktrees/task-5-abcd',
      branch_name: 'branch-5',
    };

    mockRemoveWorktree.mockRejectedValue(new Error('locked file'));

    const result = await deleteTaskWorktree(context as never, task, tasks as never, context.currentProjectPath);

    expect(result).toBe(false);
    expect(tasks.update).not.toHaveBeenCalled();
  });

  it('writes the renamed live branch back to branch_name before removal', async () => {
    const tasks = createMockTaskRepo();
    const context = createMockContext();
    const task = {
      id: 'task-6',
      worktree_path: '/mock/project/.kangentic/worktrees/task-6-abcd',
      branch_name: 'kangentic/task-6-abcd',
    };

    // Agent renamed the branch inside the worktree to a team convention.
    mockReadWorktreeHead.mockResolvedValue({ branch: 'feat/real-work', sha: 'deadbeef' });
    mockRemoveWorktree.mockResolvedValue(true);

    const result = await deleteTaskWorktree(context as never, task, tasks as never, context.currentProjectPath);

    expect(result).toBe(true);
    // First update is the branch write-back, ahead of removal.
    expect(tasks.update).toHaveBeenNthCalledWith(1, { id: 'task-6', branch_name: 'feat/real-work' });
    // Second update nulls worktree_path and persists the captured SHA.
    expect(tasks.update).toHaveBeenNthCalledWith(2, { id: 'task-6', worktree_path: null, head_sha: 'deadbeef' });
  });

  it('persists the branch write-back even when the removal fails', async () => {
    const tasks = createMockTaskRepo();
    const context = createMockContext();
    const task = {
      id: 'task-7',
      worktree_path: '/mock/project/.kangentic/worktrees/task-7-abcd',
      branch_name: 'kangentic/task-7-abcd',
    };

    mockReadWorktreeHead.mockResolvedValue({ branch: 'feat/kept', sha: 'cafe1234' });
    mockRemoveWorktree.mockResolvedValue(false);

    const result = await deleteTaskWorktree(context as never, task, tasks as never, context.currentProjectPath);

    expect(result).toBe(false);
    // The corrected name is persisted so the startup retry pass deletes the dir
    // with accurate DB state; worktree_path stays set for that retry.
    expect(tasks.update).toHaveBeenCalledTimes(1);
    expect(tasks.update).toHaveBeenCalledWith({ id: 'task-7', branch_name: 'feat/kept' });
  });

  it('does not write branch_name back when the live branch matches the stored slug', async () => {
    const tasks = createMockTaskRepo();
    const context = createMockContext();
    const task = {
      id: 'task-8',
      worktree_path: '/mock/project/.kangentic/worktrees/task-8-abcd',
      branch_name: 'feat/unchanged',
    };

    mockReadWorktreeHead.mockResolvedValue({ branch: 'feat/unchanged', sha: 'beef5678' });
    mockRemoveWorktree.mockResolvedValue(true);

    await deleteTaskWorktree(context as never, task, tasks as never, context.currentProjectPath);

    // Only the removal update, no redundant branch write-back.
    expect(tasks.update).toHaveBeenCalledTimes(1);
    expect(tasks.update).toHaveBeenCalledWith({ id: 'task-8', worktree_path: null, head_sha: 'beef5678' });
  });

  it('skips the branch write-back when the task row is already gone (concurrent delete)', async () => {
    const tasks = createMockTaskRepo();
    tasks.getById.mockReturnValue(undefined);
    const context = createMockContext();
    const task = {
      id: 'task-9',
      worktree_path: '/mock/project/.kangentic/worktrees/task-9-abcd',
      branch_name: 'kangentic/task-9-abcd',
    };

    mockReadWorktreeHead.mockResolvedValue({ branch: 'feat/renamed', sha: 'face9999' });
    mockRemoveWorktree.mockResolvedValue(true);

    await deleteTaskWorktree(context as never, task, tasks as never, context.currentProjectPath);

    // No branch write-back; only the removal-path update (which getById does not gate).
    expect(tasks.update).toHaveBeenCalledTimes(1);
    expect(tasks.update).toHaveBeenCalledWith({ id: 'task-9', worktree_path: null, head_sha: 'face9999' });
  });
});
