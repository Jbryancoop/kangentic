/**
 * Unit tests for the permission-mode delta respawn branch in handleTaskMove
 * (src/main/ipc/handlers/task-move.ts).
 *
 * The branch fires inside Priority 3 (task has a live session, same agent,
 * same track) when the destination column's EFFECTIVE permission mode
 * (lane.permission_mode ?? global config default) differs from the mode the
 * live session was spawned with (session record's permission_mode). No
 * adapter can switch permission mode on a live session, so the move must
 * suspend + respawn instead of live-injecting: Phase 3 resumes the same
 * agent session id and the destination's --permission-mode / --model /
 * --effort land as CLI flags.
 *
 * Also covers the continuationPrompt threading: the plan-exit listener
 * passes { continuationPrompt } as handleTaskMove's options parameter and it
 * must reach spawnAgent via the MoveSpawnPlan.
 *
 * And the suppressAutoCommand threading: a move whose source lane has
 * role='done' (the first move OUT of Done, e.g. an MCP move_task or legacy
 * row) must reach spawnAgent with suppressAutoCommand=true so the recovery
 * resume is idle; a normal move (non-Done source) must pass false so the next
 * move of a restored task injects per column config.
 *
 * Harness modeled on task-move-isolation-switch.test.ts; the config mock
 * additionally exposes agent.permissionMode because the new branch resolves
 * the effective target mode through it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task, Swimlane } from '../../src/shared/types';

const hoisted = vi.hoisted(() => ({
  activeRecord: null as Record<string, unknown> | null,
  updateAppliedSettings: vi.fn(),
}));

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

vi.mock('simple-git', () => ({
  simpleGit: vi.fn(() => ({
    diffSummary: vi.fn(async () => ({ insertions: 0, deletions: 0, changed: 0 })),
  })),
  default: vi.fn(() => ({})),
}));

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/db/repositories/task-repository', () => ({ TaskRepository: class {} }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask = vi.fn(() => hoisted.activeRecord);
    getLatestForTaskByTypeAndIsolation = vi.fn(() => hoisted.activeRecord);
    updateGitStats = vi.fn();
    updateAppliedSettings = hoisted.updateAppliedSettings;
  },
}));
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({ SwimlaneRepository: class {} }));
vi.mock('../../src/main/db/repositories/action-repository', () => ({ ActionRepository: class {} }));
vi.mock('../../src/main/db/repositories/attachment-repository', () => ({ AttachmentRepository: class {} }));

vi.mock('../../src/main/git/worktree-manager', () => ({
  WorktreeManager: class {
    static scheduleBackgroundPrune = vi.fn();
  },
}));

vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent: vi.fn() }));

vi.mock('../../src/main/engine/session-lifecycle', () => ({
  markRecordExited: vi.fn(),
  markRecordSuspended: vi.fn(),
}));

vi.mock('../../src/main/engine/spawn-progress', () => ({
  emitSpawnProgress: vi.fn(),
  emitSpawnWaiting: vi.fn(),
  clearSpawnProgress: vi.fn(),
  createProgressCallback: vi.fn(() => vi.fn()),
  getInFlightSpawnProgress: vi.fn(() => ({})),
}));

vi.mock('../../src/main/engine/agent-resolver', () => ({
  resolveTargetAgent: vi.fn(() => ({ agent: 'claude', isHandoff: false })),
}));

vi.mock('../../src/main/engine/injection-plan', () => ({
  prepareInjectionPlan: vi.fn(() => null),
}));

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { get: vi.fn(() => undefined) },
}));

vi.mock('../../src/main/ipc/handlers/backlog', () => ({ abortBacklogPromotion: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({ captureSessionMetrics: vi.fn() }));

vi.mock('../../src/main/agent/shared', () => ({
  interpolateTemplate: vi.fn((template: string) => template),
  resolveBridgeScript: vi.fn(() => '/mock/bridge.js'),
  execVersion: vi.fn(async () => '1.0.0'),
}));

const mockGetProjectRepos = vi.fn();
const mockEnsureTaskWorktree = vi.fn(async () => null);
const mockEnsureTaskBranchCheckout = vi.fn(async () => {});
const mockSpawnAgent = vi.fn(async () => {});
const mockCreateTransitionEngine = vi.fn(() => ({}));
const mockBuildAutoCommandVars = vi.fn(() => ({}));

vi.mock('../../src/main/ipc/helpers/index', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
  ensureTaskWorktree: (...args: unknown[]) => mockEnsureTaskWorktree(...args),
  ensureTaskBranchCheckout: (...args: unknown[]) => mockEnsureTaskBranchCheckout(...args),
  spawnAgent: (...args: unknown[]) => mockSpawnAgent(...args),
  createTransitionEngine: (...args: unknown[]) => mockCreateTransitionEngine(...args),
  buildAutoCommandVars: (...args: unknown[]) => mockBuildAutoCommandVars(...args),
  cleanupTaskResources: vi.fn(async () => {}),
  deleteTaskWorktree: vi.fn(async () => true),
  maybeResolvePRAfterMove: vi.fn(),
  autoSpawnForTask: vi.fn(async () => {}),
}));

import { handleTaskMove } from '../../src/main/ipc/handlers/task-move';
import { markRecordSuspended } from '../../src/main/engine/session-lifecycle';
import { prepareInjectionPlan } from '../../src/main/engine/injection-plan';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-aaa00001',
    display_id: 1,
    title: 'My Task',
    description: '',
    swimlane_id: 'lane-planning',
    position: 0,
    agent: 'claude',
    session_id: 'active-session-1',
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

function makeContext(taskRepo: unknown, swimlaneRepo: unknown) {
  const sessionManager = {
    removeByTaskId: vi.fn(),
    killByTaskId: vi.fn(),
    listSessions: vi.fn(() => []),
    suspend: vi.fn(async () => {}),
  };
  const context = {
    currentProjectId: 'proj-test',
    currentProjectPath: '/mock/project',
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
    sessionManager,
    configManager: {
      getEffectiveConfig: vi.fn(() => ({
        git: { defaultBaseBranch: 'main' },
        agent: { permissionMode: 'acceptEdits' },
      })),
    },
    boardConfigManager: { getDefaultBaseBranch: vi.fn(() => null) },
    terminalSubmitScheduler: { cancel: vi.fn(), scheduleKeystrokes: vi.fn() },
    projectRepo: { getById: vi.fn(() => ({ id: 'proj-test', default_agent: 'claude' })) },
  };
  mockGetProjectRepos.mockReturnValue({
    tasks: taskRepo,
    swimlanes: swimlaneRepo,
    actions: { getTransitionsFor: vi.fn(() => []) },
    attachments: { deleteByTaskId: vi.fn() },
  });
  return context;
}

const PLANNING_LANE_ID = 'lane-planning';
const EXECUTING_LANE_ID = 'lane-executing';
const DONE_LANE_ID = 'lane-done';

function makeLanes(executingOverrides: Partial<Swimlane> = {}) {
  const planningLane = makeSwimlane(PLANNING_LANE_ID, { permission_mode: 'plan' });
  const executingLane = makeSwimlane(EXECUTING_LANE_ID, { permission_mode: 'auto', ...executingOverrides });
  const swimlaneRepo = {
    getById: vi.fn((id: string) => (id === PLANNING_LANE_ID ? planningLane : id === EXECUTING_LANE_ID ? executingLane : null)),
    list: vi.fn(() => [planningLane, executingLane]),
  };
  return { planningLane, executingLane, swimlaneRepo };
}

/** Live main session record. Phase 1 reads it via getLatestForTask. */
function setActiveRecord(
  permissionMode: string | null,
  appliedModel: string | null = null,
  appliedEffort: string | null = null,
) {
  hoisted.activeRecord = {
    id: 'rec-main', task_id: 'task-aaa00001', isolated_swimlane_id: null,
    agent_session_id: 'agent-A', status: 'running',
    started_at: '2026-01-01T00:00:00Z', session_type: 'claude_agent',
    permission_mode: permissionMode,
    applied_model: appliedModel,
    applied_effort: appliedEffort,
  };
}

/** Phase 1 sees the task with a live session; Phase 3 re-reads it moved with no session. */
function makeTaskRepo() {
  return {
    getById: vi.fn()
      .mockReturnValueOnce(makeTask({ swimlane_id: PLANNING_LANE_ID, session_id: 'active-session-1' }))
      .mockReturnValue(makeTask({ swimlane_id: EXECUTING_LANE_ID, session_id: null })),
    move: vi.fn(),
    update: vi.fn(),
    list: vi.fn(() => [makeTask()]),
    archive: vi.fn(),
  };
}

/**
 * A non-archived task sitting in a Done-role lane (MCP move_task / legacy row)
 * dragged to an active lane. The Done move suspended the session, so Phase 1
 * sees session_id=null and the move reaches Priority 4 -> Phase 3 spawnAgent.
 * The target lane carries an auto_command to prove it is suppressed on the
 * recovery move (the spawnAgent unit tests assert the no-injection effect).
 */
function makeDoneOutSetup() {
  const doneLane = makeSwimlane(DONE_LANE_ID, { role: 'done' });
  const executingLane = makeSwimlane(EXECUTING_LANE_ID, { auto_command: '/merge-back' });
  const swimlaneRepo = {
    getById: vi.fn((id: string) => (id === DONE_LANE_ID ? doneLane : id === EXECUTING_LANE_ID ? executingLane : null)),
    list: vi.fn(() => [doneLane, executingLane]),
  };
  const taskRepo = {
    getById: vi.fn()
      .mockReturnValueOnce(makeTask({ swimlane_id: DONE_LANE_ID, session_id: null }))
      .mockReturnValue(makeTask({ swimlane_id: EXECUTING_LANE_ID, session_id: null })),
    move: vi.fn(),
    update: vi.fn(),
    list: vi.fn(() => [makeTask()]),
    archive: vi.fn(),
  };
  return { swimlaneRepo, taskRepo };
}

describe('handleTaskMove permission-mode delta respawn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.activeRecord = null;
    hoisted.updateAppliedSettings.mockReset();
    mockEnsureTaskWorktree.mockResolvedValue(null);
    mockEnsureTaskBranchCheckout.mockResolvedValue(undefined);
    mockSpawnAgent.mockResolvedValue(undefined);
    vi.mocked(prepareInjectionPlan).mockReturnValue(null);
  });

  it('permission delta (plan -> auto) suspends the live session and respawns via Phase 3', async () => {
    const { swimlaneRepo } = makeLanes();
    setActiveRecord('plan');
    const taskRepo = makeTaskRepo();
    const context = makeContext(taskRepo, swimlaneRepo);

    await handleTaskMove(context as never, {
      taskId: 'task-aaa00001', targetSwimlaneId: EXECUTING_LANE_ID, targetPosition: 0,
    });

    expect(markRecordSuspended).toHaveBeenCalledWith(expect.anything(), 'rec-main', 'system');
    expect(context.sessionManager.suspend).toHaveBeenCalledWith('active-session-1');
    expect(taskRepo.update).toHaveBeenCalledWith({ id: 'task-aaa00001', session_id: null });
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();

    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
    const spawnArg = mockSpawnAgent.mock.calls[0][0] as { toLane: Swimlane };
    expect(spawnArg.toLane.id).toBe(EXECUTING_LANE_ID);
  });

  it('null lane mode resolves through the global config default (plan -> acceptEdits default)', async () => {
    const { swimlaneRepo } = makeLanes({ permission_mode: null });
    setActiveRecord('plan');
    const taskRepo = makeTaskRepo();
    const context = makeContext(taskRepo, swimlaneRepo);

    await handleTaskMove(context as never, {
      taskId: 'task-aaa00001', targetSwimlaneId: EXECUTING_LANE_ID, targetPosition: 0,
    });

    expect(context.configManager.getEffectiveConfig).toHaveBeenCalled();
    expect(context.sessionManager.suspend).toHaveBeenCalledWith('active-session-1');
    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
  });

  it('same effective mode keeps the session alive (no suspend, no respawn)', async () => {
    // Record acceptEdits, lane null -> effective target acceptEdits (config default).
    const { swimlaneRepo } = makeLanes({ permission_mode: null });
    setActiveRecord('acceptEdits');
    const taskRepo = makeTaskRepo();
    const context = makeContext(taskRepo, swimlaneRepo);

    await handleTaskMove(context as never, {
      taskId: 'task-aaa00001', targetSwimlaneId: EXECUTING_LANE_ID, targetPosition: 0,
    });

    expect(markRecordSuspended).not.toHaveBeenCalled();
    expect(context.sessionManager.suspend).not.toHaveBeenCalled();
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  it('null recorded mode (legacy row) is conservative: no respawn', async () => {
    const { swimlaneRepo } = makeLanes();
    setActiveRecord(null);
    const taskRepo = makeTaskRepo();
    const context = makeContext(taskRepo, swimlaneRepo);

    await handleTaskMove(context as never, {
      taskId: 'task-aaa00001', targetSwimlaneId: EXECUTING_LANE_ID, targetPosition: 0,
    });

    expect(markRecordSuspended).not.toHaveBeenCalled();
    expect(context.sessionManager.suspend).not.toHaveBeenCalled();
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  it('permission delta + destination auto_command respawns instead of live-injecting', async () => {
    const { swimlaneRepo } = makeLanes({ auto_command: '/implement' });
    setActiveRecord('plan');
    const taskRepo = makeTaskRepo();
    const context = makeContext(taskRepo, swimlaneRepo);

    await handleTaskMove(context as never, {
      taskId: 'task-aaa00001', targetSwimlaneId: EXECUTING_LANE_ID, targetPosition: 0,
    });

    // The permission check runs BEFORE live injection is even considered.
    expect(prepareInjectionPlan).not.toHaveBeenCalled();
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
    expect(context.sessionManager.suspend).toHaveBeenCalledWith('active-session-1');
    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
  });

  it('threads options.continuationPrompt through to spawnAgent', async () => {
    const { swimlaneRepo } = makeLanes();
    setActiveRecord('plan');
    const taskRepo = makeTaskRepo();
    const context = makeContext(taskRepo, swimlaneRepo);

    const continuation = 'Proceed with implementing the approved plan.';
    await handleTaskMove(
      context as never,
      { taskId: 'task-aaa00001', targetSwimlaneId: EXECUTING_LANE_ID, targetPosition: 0 },
      undefined,
      undefined,
      { continuationPrompt: continuation },
    );

    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
    const spawnArg = mockSpawnAgent.mock.calls[0][0] as { continuationPrompt?: string };
    expect(spawnArg.continuationPrompt).toBe(continuation);
  });

  it('omits continuationPrompt when the caller passes no options (user drag)', async () => {
    const { swimlaneRepo } = makeLanes();
    setActiveRecord('plan');
    const taskRepo = makeTaskRepo();
    const context = makeContext(taskRepo, swimlaneRepo);

    await handleTaskMove(context as never, {
      taskId: 'task-aaa00001', targetSwimlaneId: EXECUTING_LANE_ID, targetPosition: 0,
    });

    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
    const spawnArg = mockSpawnAgent.mock.calls[0][0] as { continuationPrompt?: string };
    expect(spawnArg.continuationPrompt).toBeUndefined();
  });

  it('suppresses auto_command on the first move OUT of Done (recovery move)', async () => {
    const { swimlaneRepo, taskRepo } = makeDoneOutSetup();
    const context = makeContext(taskRepo, swimlaneRepo);

    await handleTaskMove(context as never, {
      taskId: 'task-aaa00001', targetSwimlaneId: EXECUTING_LANE_ID, targetPosition: 0,
    });

    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
    const spawnArg = mockSpawnAgent.mock.calls[0][0] as { suppressAutoCommand?: boolean };
    expect(spawnArg.suppressAutoCommand).toBe(true);
  });

  it('does NOT suppress auto_command on a normal move (source lane is not Done)', async () => {
    // The SECOND move of a restored task: source is a normal active lane, so
    // the destination column's auto_command injects as usual.
    const { swimlaneRepo } = makeLanes();
    setActiveRecord('plan'); // permission delta plan -> auto respawns via Phase 3
    const taskRepo = makeTaskRepo();
    const context = makeContext(taskRepo, swimlaneRepo);

    await handleTaskMove(context as never, {
      taskId: 'task-aaa00001', targetSwimlaneId: EXECUTING_LANE_ID, targetPosition: 0,
    });

    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
    const spawnArg = mockSpawnAgent.mock.calls[0][0] as { suppressAutoCommand?: boolean };
    expect(spawnArg.suppressAutoCommand).toBe(false);
  });

  it('no permission delta leaves the live-injection path intact', async () => {
    // Modes match (acceptEdits on both sides); a model delta produces an
    // injection plan, which must still be live-injected, not respawned.
    const { swimlaneRepo } = makeLanes({ permission_mode: null, model_override: 'claude-opus-4-8' });
    setActiveRecord('acceptEdits');
    const taskRepo = makeTaskRepo();
    const context = makeContext(taskRepo, swimlaneRepo);
    vi.mocked(prepareInjectionPlan).mockReturnValue({
      sequence: ['/model claude-opus-4-8'],
      verifier: null,
      verifiedPrefixLength: 1,
    });

    await handleTaskMove(context as never, {
      taskId: 'task-aaa00001', targetSwimlaneId: EXECUTING_LANE_ID, targetPosition: 0,
    });

    expect(context.terminalSubmitScheduler.scheduleKeystrokes).toHaveBeenCalledTimes(1);
    expect(markRecordSuspended).not.toHaveBeenCalled();
    expect(context.sessionManager.suspend).not.toHaveBeenCalled();
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Gap 1: Priority 3c persistence - updateAppliedSettings called after live injection
  // =========================================================================

  it('live injection (plan with appliedSettings) calls updateAppliedSettings on the session repo', async () => {
    // The plan mock returns appliedSettings so the handler must persist the new
    // running value via sessionRepo.updateAppliedSettings. Without this, the NEXT
    // move would still diff against the old applied value and inject again.
    const { swimlaneRepo } = makeLanes({ permission_mode: null, effort_override: 'xhigh' });
    setActiveRecord('acceptEdits');
    const taskRepo = makeTaskRepo();
    const context = makeContext(taskRepo, swimlaneRepo);
    vi.mocked(prepareInjectionPlan).mockReturnValue({
      sequence: ['/effort xhigh'],
      verifier: null,
      verifiedPrefixLength: 1,
      appliedSettings: { effort: 'xhigh' },
    });

    await handleTaskMove(context as never, {
      taskId: 'task-aaa00001', targetSwimlaneId: EXECUTING_LANE_ID, targetPosition: 0,
    });

    expect(context.terminalSubmitScheduler.scheduleKeystrokes).toHaveBeenCalledTimes(1);

    // The persistence call is load-bearing: the next column move diffs against
    // the RECORDED applied value. If it is not called, that move would still
    // see applied_effort=null and re-inject /effort xhigh redundantly.
    expect(hoisted.updateAppliedSettings).toHaveBeenCalledWith(
      'active-session-1',
      { effort: 'xhigh' },
    );
  });

  it('live injection with no appliedSettings (auto_command only) does NOT call updateAppliedSettings', async () => {
    // A plan that only carries an auto_command has no appliedSettings (no model/effort
    // field was emitted). The handler must NOT call updateAppliedSettings with undefined/empty.
    const { swimlaneRepo } = makeLanes({ permission_mode: null });
    setActiveRecord('acceptEdits');
    const taskRepo = makeTaskRepo();
    const context = makeContext(taskRepo, swimlaneRepo);
    vi.mocked(prepareInjectionPlan).mockReturnValue({
      sequence: ['implement the task'],
      verifier: null,
      verifiedPrefixLength: 0,
      // appliedSettings absent - auto_command only
    });

    await handleTaskMove(context as never, {
      taskId: 'task-aaa00001', targetSwimlaneId: EXECUTING_LANE_ID, targetPosition: 0,
    });

    expect(context.terminalSubmitScheduler.scheduleKeystrokes).toHaveBeenCalledTimes(1);
    expect(hoisted.updateAppliedSettings).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Gap 2: Respawn-fallback source uses activeRecord.applied_* (regression guard)
  // =========================================================================

  it('no-live-swap: does NOT respawn when the session already runs at the destination effort (regression guard)', async () => {
    // THE KEY REGRESSION: old code diffed fromLane vs toLane. When both columns
    // had effort_override='xhigh' but the leaving column was null (e.g. a To Do
    // lane with no override), the diff was null vs xhigh and a spurious respawn
    // fired. New code diffs activeRecord.applied_effort vs toLane, so a session
    // already at xhigh (recorded in applied_effort) entering another xhigh column
    // produces no delta and no respawn.
    const { swimlaneRepo } = makeLanes({ permission_mode: null, effort_override: 'xhigh' });
    // Session is already running at xhigh - the fix reads this from the record.
    setActiveRecord('acceptEdits', null, 'xhigh');
    const taskRepo = makeTaskRepo();
    const context = makeContext(taskRepo, swimlaneRepo);
    // prepareInjectionPlan returns null (adapter has no live slash - codex-style).
    vi.mocked(prepareInjectionPlan).mockReturnValue(null);

    await handleTaskMove(context as never, {
      taskId: 'task-aaa00001', targetSwimlaneId: EXECUTING_LANE_ID, targetPosition: 0,
    });

    // With the fix: applied_effort='xhigh' == destination effort_override='xhigh' -> no delta -> no respawn.
    expect(context.sessionManager.suspend).not.toHaveBeenCalled();
    expect(markRecordSuspended).not.toHaveBeenCalled();
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  it('no-live-swap: DOES respawn when the session runs at a different effort than the destination', async () => {
    // Complementary case: session applied_effort='low', destination effort='xhigh'.
    // The delta is real, so a no-live-swap respawn must fire.
    const { swimlaneRepo } = makeLanes({ permission_mode: null, effort_override: 'xhigh' });
    setActiveRecord('acceptEdits', null, 'low');
    const taskRepo = makeTaskRepo();
    const context = makeContext(taskRepo, swimlaneRepo);
    vi.mocked(prepareInjectionPlan).mockReturnValue(null);

    await handleTaskMove(context as never, {
      taskId: 'task-aaa00001', targetSwimlaneId: EXECUTING_LANE_ID, targetPosition: 0,
    });

    // Delta exists: applied='low', target='xhigh' -> respawn.
    expect(context.sessionManager.suspend).toHaveBeenCalledWith('active-session-1');
    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
  });
});
