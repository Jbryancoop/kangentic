/**
 * Regression tests for auto_command injection through the real spawnAgent
 * fallback (src/main/ipc/helpers/agent-spawn.ts).
 *
 * The protected critical path: a column's auto_command MUST reach the agent.
 *
 * Two bugs these pin, both found live in /preview:
 *
 *  1. spawnAgent decided resume-vs-fresh with a TASK-LEVEL resume check
 *     (getLatestForTask) while executeSpawnAgent decides it ISOLATION-SCOPED.
 *     Dragging a task with a suspended MAIN session into an ISOLATED column made
 *     the task-level check see the main session as "resumable", so the spawn
 *     mis-routed the auto_command and dropped it. Fixed by scoping spawnAgent's
 *     resume check to the destination isolation.
 *
 *  2. A fresh isolated session has no task prompt (skipPromptTemplate), so it
 *     sits idle, never emits a 'thinking' event, and the keystroke scheduler
 *     waits out its full 30s fallback before the auto_command appears - reading
 *     as "the command never ran". Fixed by delivering the auto_command as the
 *     session's INITIAL PROMPT when there is no task prompt to run (resume, or
 *     fresh + skipPromptTemplate), keeping the keystroke only for a fresh spawn
 *     whose prompt slot is taken by the task description.
 *
 * resumePrompt is the 4th arg of resumeSuspendedSession; asserting it carries
 * the command (vs. a scheduleKeystrokes call) tells us which delivery path ran.
 * These cover the {main, isolated} x {fresh-promptless, fresh-with-task-prompt,
 * resume} matrix.
 *
 * The real spawnAgent is exercised end to end; only the engine, repos, and
 * context are injected mocks, plus resolveTargetAgent (force isHandoff=false to
 * reach the normal fallback) and agentRegistry (supply the destination
 * sessionType). resolveIsolatedSwimlaneId, isResumeEligible, interpolateTemplate,
 * and buildAutoCommandVars run for real - they are the logic under test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task, Swimlane, SessionRecord } from '../../src/shared/types';

vi.mock('../../src/main/engine/agent-resolver', () => ({
  resolveTargetAgent: vi.fn(() => ({ agent: 'claude', isHandoff: false })),
}));

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { get: vi.fn(() => ({ sessionType: 'claude_agent' })) },
}));

import { spawnAgent } from '../../src/main/ipc/helpers/agent-spawn';

const TASK_ID = 'task-aaa00001';
const EXEC_LANE_ID = 'lane-exec';
const ISOLATED_LANE_ID = 'lane-review-isolated';
const FRESH_PTY_SESSION_ID = 'pty-fresh-1';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    display_id: 1,
    title: 'My Task',
    description: 'Do the thing',
    swimlane_id: EXEC_LANE_ID,
    position: 0,
    agent: 'claude',
    agent_override: null,
    model_override: null,
    effort_override: null,
    session_id: null,
    worktree_path: '/mock/project/.kangentic/worktrees/my-task',
    branch_name: 'my-task',
    pr_number: null,
    pr_url: null,
    base_branch: null,
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

function makeSwimlane(id: string, overrides: Partial<Swimlane> = {}): Swimlane {
  return {
    id,
    name: `Lane ${id}`,
    role: null,
    position: 0,
    color: '#888',
    icon: null,
    is_archived: false,
    is_ghost: false,
    permission_mode: null,
    auto_spawn: true,
    auto_command: null,
    plan_exit_target_id: null,
    agent_override: null,
    model_override: null,
    effort_override: null,
    handoff_context: false,
    session_target: 'main',
    session_spawn_strategy: 'create_or_resume',
    created_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'rec-1',
    task_id: TASK_ID,
    session_type: 'claude_agent',
    isolated_swimlane_id: null,
    agent_session_id: 'agent-sid-1',
    pty_session_id: null,
    status: 'suspended',
    suspended_by: 'system',
    permission_mode: null,
    started_at: '2026-01-01T00:00:00.000Z',
    exited_at: null,
    exit_code: null,
    duration_ms: null,
    cost_usd: null,
    input_tokens: null,
    output_tokens: null,
    model: null,
    effort: null,
    ...overrides,
  } as SessionRecord;
}

/**
 * Build the injected dependencies. `manualPauseRecord` feeds getLatestForTask
 * (drives only the manual-pause guard + handoff probe). `resumeRecord` feeds the
 * isolation-scoped getLatestForTaskByTypeAndIsolation (drives the fix). getById
 * returns no-session first (so the fallback runs) then a freshly-spawned session.
 */
function makeDeps(args: {
  manualPauseRecord: SessionRecord | null;
  resumeRecord: SessionRecord | undefined;
}) {
  const getById = vi.fn();
  getById
    .mockReturnValueOnce(makeTask({ session_id: null }))
    .mockReturnValue(makeTask({ session_id: FRESH_PTY_SESSION_ID }));

  const tasks = { getById };
  const sessionRepo = {
    getLatestForTask: vi.fn(() => args.manualPauseRecord),
    getLatestForTaskByTypeAndIsolation: vi.fn(() => args.resumeRecord),
  };
  const engine = {
    executeTransition: vi.fn(async () => {}),
    resumeSuspendedSession: vi.fn(async () => {}),
  };
  const scheduleKeystrokes = vi.fn();
  const context = { terminalSubmitScheduler: { scheduleKeystrokes } };

  return { tasks, sessionRepo, engine, scheduleKeystrokes, context };
}

async function runSpawn(toLane: Swimlane, deps: ReturnType<typeof makeDeps>, skipPromptTemplate = false) {
  await spawnAgent({
    context: deps.context as never,
    engine: deps.engine as never,
    tasks: deps.tasks as never,
    sessionRepo: deps.sessionRepo as never,
    task: makeTask({ swimlane_id: toLane.id, session_id: null }),
    fromSwimlaneId: EXEC_LANE_ID,
    toLane,
    skipPromptTemplate,
  });
}

/** The resumePrompt is the 4th positional arg of resumeSuspendedSession. */
function resumePromptArg(engine: ReturnType<typeof makeDeps>['engine']): unknown {
  return engine.resumeSuspendedSession.mock.calls[0]?.[3];
}

describe('spawnAgent auto_command injection (isolation-scoped resume check)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ISOLATED + fresh, no task prompt: runs the auto_command as the INITIAL PROMPT (immediate), even with a suspended MAIN session present', async () => {
    const isolatedLane = makeSwimlane(ISOLATED_LANE_ID, {
      session_target: 'isolated',
      auto_command: '/code-review',
    });
    // A suspended MAIN session is present (just suspended by the column switch);
    // a task-level resume check would falsely treat it as resumable here.
    const deps = makeDeps({
      manualPauseRecord: makeRecord({ id: 'rec-main', isolated_swimlane_id: null, status: 'suspended', suspended_by: 'system' }),
      resumeRecord: undefined, // no prior ISOLATED session -> genuinely fresh
    });

    // skipPromptTemplate=true: entered from a non-To-Do column, so the isolated
    // session gets no task prompt - the auto_command becomes its first prompt.
    await runSpawn(isolatedLane, deps, true);

    // The isolation-scoped lookup decided this destination (NOT getLatestForTask).
    expect(deps.sessionRepo.getLatestForTaskByTypeAndIsolation)
      .toHaveBeenCalledWith(TASK_ID, 'claude_agent', ISOLATED_LANE_ID);
    // Delivered as the initial prompt - no 30s keystroke fallback.
    expect(resumePromptArg(deps.engine)).toBe('/code-review');
    expect(deps.scheduleKeystrokes).not.toHaveBeenCalled();
  });

  it('ISOLATED + fresh from To Do (task prompt present): auto_command follows the task prompt as a keystroke', async () => {
    const isolatedLane = makeSwimlane(ISOLATED_LANE_ID, {
      session_target: 'isolated',
      auto_command: '/code-review',
    });
    const deps = makeDeps({ manualPauseRecord: null, resumeRecord: undefined });

    // skipPromptTemplate=false: the task description owns the prompt slot, so the
    // auto_command must be injected afterward as a keystroke.
    await runSpawn(isolatedLane, deps, false);

    expect(resumePromptArg(deps.engine)).toBeUndefined();
    expect(deps.scheduleKeystrokes).toHaveBeenCalledTimes(1);
    expect(deps.scheduleKeystrokes).toHaveBeenCalledWith(
      TASK_ID, FRESH_PTY_SESSION_ID, ['/code-review'], { freshlySpawned: true },
    );
  });

  it('ISOLATED + resume: re-entering the isolated column resumes with the auto_command as the resume prompt, no keystroke', async () => {
    const isolatedLane = makeSwimlane(ISOLATED_LANE_ID, {
      session_target: 'isolated',
      auto_command: '/code-review',
    });
    const isolatedRecord = makeRecord({ id: 'rec-iso', isolated_swimlane_id: ISOLATED_LANE_ID, agent_session_id: 'agent-iso' });
    const deps = makeDeps({ manualPauseRecord: isolatedRecord, resumeRecord: isolatedRecord });

    await runSpawn(isolatedLane, deps, true);

    expect(resumePromptArg(deps.engine)).toBe('/code-review');
    expect(deps.scheduleKeystrokes).not.toHaveBeenCalled();
  });

  it('MAIN + resume: a resumable main session receives the auto_command as the resume prompt (unchanged)', async () => {
    const normalLane = makeSwimlane(EXEC_LANE_ID, { session_target: 'main', auto_command: '/standup' });
    const mainRecord = makeRecord({ id: 'rec-main', isolated_swimlane_id: null, agent_session_id: 'agent-main' });
    const deps = makeDeps({ manualPauseRecord: mainRecord, resumeRecord: mainRecord });

    await runSpawn(normalLane, deps, true);

    // Destination isolation is null (main) - the scoped lookup is asked for it.
    expect(deps.sessionRepo.getLatestForTaskByTypeAndIsolation)
      .toHaveBeenCalledWith(TASK_ID, 'claude_agent', null);
    expect(resumePromptArg(deps.engine)).toBe('/standup');
    expect(deps.scheduleKeystrokes).not.toHaveBeenCalled();
  });

  it('MAIN + fresh from To Do: auto_command injected as a keystroke after the task prompt (unchanged)', async () => {
    const normalLane = makeSwimlane(EXEC_LANE_ID, { session_target: 'main', auto_command: '/standup' });
    const deps = makeDeps({ manualPauseRecord: null, resumeRecord: undefined });

    await runSpawn(normalLane, deps, false);

    expect(resumePromptArg(deps.engine)).toBeUndefined();
    expect(deps.scheduleKeystrokes).toHaveBeenCalledTimes(1);
    expect(deps.scheduleKeystrokes).toHaveBeenCalledWith(
      TASK_ID, FRESH_PTY_SESSION_ID, ['/standup'], { freshlySpawned: true },
    );
  });
});
