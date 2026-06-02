import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task } from '../../src/shared/types';

/**
 * Unit tests for the confidence ladder in resolveAndLinkPRForTask: which anchor
 * wins (pr_number -> worktree branch -> commit SHA -> slug), write-only-on-change,
 * the TTL coalesce + terminal-skip throttle (force bypasses), and transient-error
 * surfacing that preserves an existing link.
 *
 * The connectors, simple-git, and project-repos are mocked so the core logic is
 * tested in isolation (no gh CLI, no native DB).
 */

const git = vi.hoisted(() => ({ branch: 'real-branch' as string | null, sha: 'sha-current' as string | null }));
const conn = vi.hoisted(() => ({
  byNumber: null as unknown,
  byBranch: null as unknown,
  byCommit: null as unknown,
  detect: null as unknown,
  calls: [] as string[],
}));

vi.mock('simple-git', () => ({
  simpleGit: () => ({
    revparse: async (args: string[]) => (args.includes('--abbrev-ref') ? (git.branch ?? 'HEAD') : git.sha),
  }),
}));

// The core never calls getProjectRepos; mock it so importing pr-linking doesn't
// pull in the DB/electron chain.
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({ getProjectRepos: () => ({}) }));

vi.mock('../../src/main/pty/pr/pr-connectors', () => {
  class PRResolverUnavailableError extends Error {
    constructor(message: string) { super(message); this.name = 'PRResolverUnavailableError'; }
  }
  class PRResolverTransientError extends Error {
    constructor(message: string) { super(message); this.name = 'PRResolverTransientError'; }
  }
  const make = (key: 'byNumber' | 'byBranch' | 'byCommit') => async () => {
    conn.calls.push(key);
    const value = conn[key];
    if (value instanceof Error) throw value;
    return value ?? null;
  };
  return {
    PRResolverUnavailableError,
    PRResolverTransientError,
    resolvePRByNumber: make('byNumber'),
    resolvePRForBranch: make('byBranch'),
    resolvePRByCommit: make('byCommit'),
    detectPR: () => conn.detect ?? null,
  };
});

import { resolveAndLinkPRForTask } from '../../src/main/ipc/helpers/pr-linking';
import { PRResolverUnavailableError, PRResolverTransientError } from '../../src/main/pty/pr/pr-connectors';

let idCounter = 0;
function makeTask(overrides: Partial<Task> = {}): Task {
  idCounter += 1;
  return {
    id: `task-${idCounter}`, display_id: idCounter, title: 'T', description: '', swimlane_id: 'lane', position: 0,
    agent: null, session_id: null, worktree_path: '/wt', branch_name: 'slug', pr_number: null,
    pr_url: null, pr_state: null, head_sha: null, external_id: null, external_source: null,
    external_url: null, base_branch: 'main', use_worktree: 1, labels: [], priority: 0,
    model_override: null, effort_override: null, agent_override: null, attachment_count: 0,
    archived_at: null, created_at: 't', updated_at: 't', ...overrides,
  };
}

function depsFor(task: Task, opts: { updateSpy?: ReturnType<typeof vi.fn>; force?: boolean } = {}) {
  const update = opts.updateSpy ?? vi.fn((patch: Partial<Task>) => { Object.assign(task, patch); return { ...task }; });
  return {
    tasks: { getById: () => task, update } as never,
    projectPath: '/repo',
    onLinked: vi.fn(),
    force: opts.force ?? true, // ladder tests bypass the throttle unless they're testing it
  };
}

const resolved = (number: number, state = 'open') => ({ url: `u${number}`, number, state });

beforeEach(() => {
  conn.byNumber = null; conn.byBranch = null; conn.byCommit = null; conn.detect = null; conn.calls = [];
  git.branch = 'real-branch'; git.sha = 'sha-current';
});

describe('resolveAndLinkPRForTask confidence ladder', () => {
  it('tier 1: prefers pr_number over branch and commit', async () => {
    conn.byNumber = resolved(10); conn.byBranch = resolved(20); conn.byCommit = resolved(30);
    const task = makeTask({ pr_number: 99, head_sha: 'sha' });
    const result = await resolveAndLinkPRForTask(task.id, depsFor(task));
    expect(result.status).toBe('linked');
    expect(result.task?.pr_number).toBe(10);
    expect(conn.calls[0]).toBe('byNumber');
    expect(conn.calls).not.toContain('byBranch');
  });

  it('tier 2: worktree present resolves by the real HEAD branch', async () => {
    conn.byBranch = resolved(20);
    const task = makeTask();
    const result = await resolveAndLinkPRForTask(task.id, depsFor(task));
    expect(result.task?.pr_number).toBe(20);
    expect(conn.calls).toEqual(['byBranch']);
  });

  it('tier 3: no worktree but head_sha set resolves by commit', async () => {
    conn.byCommit = resolved(30, 'merged');
    const task = makeTask({ worktree_path: null, head_sha: 'sha-stored' });
    const result = await resolveAndLinkPRForTask(task.id, depsFor(task));
    expect(result.task?.pr_number).toBe(30);
    expect(result.task?.pr_state).toBe('merged');
    expect(conn.calls).toContain('byCommit');
  });

  it('tier 4: no worktree and no sha falls back to the slug branch', async () => {
    conn.byBranch = resolved(40);
    const task = makeTask({ worktree_path: null, head_sha: null });
    const result = await resolveAndLinkPRForTask(task.id, depsFor(task));
    expect(result.task?.pr_number).toBe(40);
    expect(conn.calls).toContain('byBranch');
  });

  it('write-only-on-change: returns unchanged and does not write when the PR is already current', async () => {
    conn.byNumber = resolved(50, 'open');
    const updateSpy = vi.fn();
    const task = makeTask({ pr_number: 50, pr_url: 'u50', pr_state: 'open', worktree_path: null });
    const result = await resolveAndLinkPRForTask(task.id, depsFor(task, { updateSpy }));
    expect(result.status).toBe('unchanged');
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('resolver-unavailable: surfaces the reason when the resolver throws and no scrollback exists', async () => {
    conn.byNumber = new PRResolverUnavailableError('gh CLI not found');
    const task = makeTask({ pr_number: 60, worktree_path: null });
    const result = await resolveAndLinkPRForTask(task.id, depsFor(task));
    expect(result.status).toBe('resolver-unavailable');
    expect(result.message).toMatch(/gh/i);
  });

  it('transient-error: preserves the existing link and does not report not-found', async () => {
    conn.byNumber = new PRResolverTransientError('HTTP 503');
    const updateSpy = vi.fn();
    const task = makeTask({ pr_number: 61, pr_url: 'u61', pr_state: 'open', worktree_path: null });
    const result = await resolveAndLinkPRForTask(task.id, depsFor(task, { updateSpy }));
    expect(result.status).toBe('transient-error');
    expect(updateSpy).not.toHaveBeenCalled();   // existing link preserved
    expect(result.task?.pr_url).toBe('u61');
  });

  it('opportunistically persists head_sha when the worktree HEAD changes', async () => {
    git.sha = 'sha-new';
    const updateSpy = vi.fn((patch: Partial<Task>) => patch as Task);
    const task = makeTask({ head_sha: 'sha-old' });
    const result = await resolveAndLinkPRForTask(task.id, depsFor(task, { updateSpy }));
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ head_sha: 'sha-new' }));
    expect(result.status).toBe('not-found');
  });
});

describe('resolveAndLinkPRForTask throttle (auto triggers only)', () => {
  it('skips a terminal (merged/closed) PR on auto triggers without calling the resolver', async () => {
    conn.byNumber = resolved(70);
    const task = makeTask({ pr_number: 70, pr_url: 'u70', pr_state: 'merged', worktree_path: null });
    const result = await resolveAndLinkPRForTask(task.id, depsFor(task, { force: false }));
    expect(result.status).toBe('unchanged');
    expect(conn.calls).toEqual([]); // resolver never invoked
  });

  it('force bypasses the terminal-skip and re-resolves', async () => {
    conn.byNumber = resolved(71, 'merged');
    const task = makeTask({ pr_number: 71, pr_url: 'u71', pr_state: 'merged', worktree_path: null });
    const result = await resolveAndLinkPRForTask(task.id, depsFor(task, { force: true }));
    expect(conn.calls).toContain('byNumber');
    expect(result.status).toBe('unchanged'); // resolved to the same PR
  });

  it('coalesces back-to-back auto resolves within the TTL window', async () => {
    conn.byBranch = resolved(80);
    const task = makeTask(); // worktree present, no pr_number
    const first = await resolveAndLinkPRForTask(task.id, depsFor(task, { force: false }));
    expect(first.task?.pr_number).toBe(80);
    const callsAfterFirst = conn.calls.length;

    const second = await resolveAndLinkPRForTask(task.id, depsFor(task, { force: false }));
    expect(second.status).toBe('unchanged');
    expect(conn.calls.length).toBe(callsAfterFirst); // no new resolver calls
  });
});
