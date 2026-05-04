/**
 * Unit tests for the TASK_SET_RUNTIME_OVERRIDE IPC handler.
 *
 * Pattern mirrors task-create-handler.test.ts: capture the function
 * registered with ipcMain.handle and invoke it directly with mocked
 * dependencies. The real `task-lifecycle-lock` is used so withTaskLock
 * semantics are observable.
 *
 * Covers the three apply paths plus the recovery contract:
 *   - `persisted`: task has no live session
 *   - `live`: adapter implements getInjectionSequence -> slash injection
 *   - `restart`: adapter has empty getInjectionSequence -> suspend + resume
 *   - `ok: false` (pre-persist): unknown agent on a task with a session
 *   - `ok: false` (post-persist): respawn failure leaves session in `suspended`
 *     state and the override IS persisted so the existing Resume UI affordance
 *     can re-spawn with whatever the user picks next
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
  },
}));

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {},
}));

const mockGetProjectRepos = vi.fn();
const mockCreateTransitionEngine = vi.fn();
const mockResolveSpawnOverrides = vi.fn((task: { model_override?: string | null; effort_override?: string | null } | undefined, lane: { model_override?: string | null; effort_override?: string | null } | null | undefined) => ({
  model: task?.model_override ?? lane?.model_override,
  effort: task?.effort_override ?? lane?.effort_override,
}));

vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
  createTransitionEngine: (...args: unknown[]) => mockCreateTransitionEngine(...args),
  resolveSpawnOverrides: (...args: unknown[]) => mockResolveSpawnOverrides(...(args as [never, never])),
}));

const mockApplySuspendDbWrites = vi.fn();
vi.mock('../../src/main/ipc/handlers/session-reconcile', () => ({
  applySuspendDbWrites: (...args: unknown[]) => mockApplySuspendDbWrites(...args),
}));

const mockBuildCommandInjectionVerifier = vi.fn(() => null);
vi.mock('../../src/main/engine/injection-plan', () => ({
  buildCommandInjectionVerifier: (...args: unknown[]) => mockBuildCommandInjectionVerifier(...(args as [never, never, never])),
}));

const mockAgentRegistryGet = vi.fn();
vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    get: (name: string) => mockAgentRegistryGet(name),
  },
}));

// ---------------------------------------------------------------------------
// Import under test (after all mocks are registered)
// ---------------------------------------------------------------------------

import { registerTaskRuntimeOverrideHandlers } from '../../src/main/ipc/handlers/task-runtime-override';
import { IPC } from '../../src/shared/ipc-channels';
import type { TaskSetRuntimeOverrideInput, TaskSetRuntimeOverrideResult } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockTask {
  id: string;
  agent: string | null;
  swimlane_id: string;
  session_id: string | null;
  model_override: string | null;
  effort_override: string | null;
}

interface MockContext {
  currentProjectId: string | null;
  currentProjectPath: string | null;
  sessionManager: { suspend: ReturnType<typeof vi.fn> };
  terminalSubmitScheduler: { scheduleKeystrokes: ReturnType<typeof vi.fn> };
}

function createMockTask(overrides: Partial<MockTask> = {}): MockTask {
  return {
    id: 'task-1',
    agent: 'claude',
    swimlane_id: 'lane-1',
    session_id: 'session-1',
    model_override: null,
    effort_override: null,
    ...overrides,
  };
}

function createMockContext(overrides: Partial<MockContext> = {}): MockContext {
  return {
    currentProjectId: 'proj-1',
    currentProjectPath: '/mock/project',
    sessionManager: { suspend: vi.fn(async () => {}) },
    terminalSubmitScheduler: { scheduleKeystrokes: vi.fn() },
    ...overrides,
  };
}

async function callHandler(input: TaskSetRuntimeOverrideInput): Promise<TaskSetRuntimeOverrideResult> {
  const handler = capturedHandlers.get(IPC.TASK_SET_RUNTIME_OVERRIDE);
  if (!handler) throw new Error(`Handler for ${IPC.TASK_SET_RUNTIME_OVERRIDE} was not registered`);
  return handler(null, input) as Promise<TaskSetRuntimeOverrideResult>;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('TASK_SET_RUNTIME_OVERRIDE handler', () => {
  let context: MockContext;
  let task: MockTask;
  let taskRepo: { getById: ReturnType<typeof vi.fn>; updateOverrides: ReturnType<typeof vi.fn> };
  let swimlaneRepo: { getById: ReturnType<typeof vi.fn> };
  let engine: { resumeSuspendedSession: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    capturedHandlers.clear();

    task = createMockTask();
    taskRepo = {
      getById: vi.fn((_id: string) => task),
      updateOverrides: vi.fn(),
    };
    swimlaneRepo = {
      getById: vi.fn(() => ({ id: 'lane-1', permission_mode: null, model_override: null, effort_override: null })),
    };
    engine = {
      resumeSuspendedSession: vi.fn(async () => {}),
    };

    mockGetProjectRepos.mockReturnValue({
      tasks: taskRepo,
      swimlanes: swimlaneRepo,
      actions: {},
      attachments: {},
    });
    mockCreateTransitionEngine.mockReturnValue(engine);

    context = createMockContext();
    registerTaskRuntimeOverrideHandlers(context as never);
  });

  // =========================================================================
  // Pre-persist failures: rollback is correct on the renderer side
  // =========================================================================

  it('returns ok:false when no project is open (no DB write)', async () => {
    context = createMockContext({ currentProjectId: null });
    capturedHandlers.clear();
    registerTaskRuntimeOverrideHandlers(context as never);

    const result = await callHandler({ taskId: 'task-1', model: 'sonnet' });
    expect(result).toEqual({ ok: false, reason: 'no project is currently open' });
    expect(taskRepo.updateOverrides).not.toHaveBeenCalled();
  });

  it('returns ok:false when task is not found (no DB write)', async () => {
    taskRepo.getById.mockReturnValue(null);
    const result = await callHandler({ taskId: 'task-missing', model: 'sonnet' });
    expect(result).toEqual({ ok: false, reason: 'task not found' });
    expect(taskRepo.updateOverrides).not.toHaveBeenCalled();
  });

  it('returns ok:false BEFORE persist when agent is unknown on a live session', async () => {
    task = createMockTask({ agent: 'made-up-agent', session_id: 'sess-x' });
    taskRepo.getById.mockReturnValue(task);
    mockAgentRegistryGet.mockReturnValue(undefined);

    const result = await callHandler({ taskId: 'task-1', model: 'sonnet' });
    expect(result).toEqual({ ok: false, reason: 'unknown agent "made-up-agent"' });
    expect(taskRepo.updateOverrides).not.toHaveBeenCalled(); // pre-persist failure
  });

  // =========================================================================
  // Happy paths
  // =========================================================================

  it('returns mode:"persisted" with the DB write when the task has no live session', async () => {
    task = createMockTask({ session_id: null });
    taskRepo.getById.mockReturnValue(task);

    const result = await callHandler({ taskId: 'task-1', model: 'sonnet' });
    expect(result).toEqual({ ok: true, mode: 'persisted' });
    expect(taskRepo.updateOverrides).toHaveBeenCalledWith('task-1', {
      model_override: 'sonnet',
      effort_override: null,
    });
    expect(context.sessionManager.suspend).not.toHaveBeenCalled();
    expect(engine.resumeSuspendedSession).not.toHaveBeenCalled();
  });

  it('returns mode:"persisted" without further work when the spec is a no-op delta', async () => {
    // Task already has model_override='sonnet'; user picks 'sonnet' again.
    task = createMockTask({ model_override: 'sonnet' });
    taskRepo.getById.mockReturnValue(task);
    mockAgentRegistryGet.mockReturnValue({
      getInjectionSequence: vi.fn(() => ['/model sonnet']), // would emit, but spec is no-op
    });

    const result = await callHandler({ taskId: 'task-1', model: 'sonnet' });
    expect(result).toEqual({ ok: true, mode: 'persisted' });
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
    expect(context.sessionManager.suspend).not.toHaveBeenCalled();
  });

  it('schedules slash commands and returns mode:"live" when the adapter emits a sequence', async () => {
    const getInjectionSequence = vi.fn(() => ['/model sonnet']);
    mockAgentRegistryGet.mockReturnValue({ getInjectionSequence });

    const result = await callHandler({ taskId: 'task-1', model: 'sonnet' });
    expect(result).toEqual({ ok: true, mode: 'live' });
    expect(getInjectionSequence).toHaveBeenCalledWith({
      model: 'sonnet',
      modelChanged: true,
      effort: null,
      effortChanged: false,
    });
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).toHaveBeenCalledWith(
      'task-1',
      'session-1',
      ['/model sonnet'],
      expect.objectContaining({ verifiedPrefixLength: 1 }),
    );
    expect(context.sessionManager.suspend).not.toHaveBeenCalled();
  });

  it('"Use column default" resolves through to the swimlane override and stays a live-switch', async () => {
    // Regression guard: clearing a per-task override (input.model = null)
    // must NOT short-circuit to the restart path when the swimlane has a
    // model override that can be applied via slash command. Without this,
    // selecting "Use column default" would unnecessarily kill and respawn
    // the PTY even though `/model <swimlane-default>` would have worked.
    task = createMockTask({ model_override: 'sonnet' }); // task currently pinned to sonnet
    taskRepo.getById.mockReturnValue(task);
    swimlaneRepo.getById.mockReturnValue({
      id: 'lane-1',
      permission_mode: null,
      model_override: 'opus', // swimlane default is opus
      effort_override: null,
    });
    const getInjectionSequence = vi.fn((spec) => {
      const out: string[] = [];
      if (spec.modelChanged && spec.model) out.push(`/model ${spec.model}`);
      return out;
    });
    mockAgentRegistryGet.mockReturnValue({ getInjectionSequence });

    // User clicks "Use column default" -> input.model = null
    const result = await callHandler({ taskId: 'task-1', model: null });

    expect(result).toEqual({ ok: true, mode: 'live' });
    // Spec should resolve OLD effective = 'sonnet' (task override) and
    // NEW effective = 'opus' (swimlane fallback), NOT { model: null }.
    expect(getInjectionSequence).toHaveBeenCalledWith({
      model: 'opus',
      modelChanged: true,
      effort: null,
      effortChanged: false,
    });
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).toHaveBeenCalledWith(
      'task-1',
      'session-1',
      ['/model opus'],
      expect.anything(),
    );
    expect(context.sessionManager.suspend).not.toHaveBeenCalled();
    // DB write persists the cleared override (null), not the resolved effective value.
    expect(taskRepo.updateOverrides).toHaveBeenCalledWith('task-1', {
      model_override: null,
      effort_override: null,
    });
  });

  it('"Use column default" with no swimlane override stays as a no-op live-side (just persisted)', async () => {
    // UX requirement: clearing a per-task override on a column that has no
    // override of its own must NOT restart the live session. There's no
    // concrete value to apply via either slash or respawn flag - the live
    // CLI keeps running with whatever it has, and the next manual spawn
    // (after the user moves the task or hits Resume) picks up the agent
    // default. Restarting here would feel like the app yanked the rug.
    task = createMockTask({ model_override: 'sonnet' });
    taskRepo.getById.mockReturnValue(task);
    swimlaneRepo.getById.mockReturnValue({
      id: 'lane-1',
      permission_mode: null,
      model_override: null, // no swimlane fallback
      effort_override: null,
    });
    const getInjectionSequence = vi.fn((spec) => {
      const out: string[] = [];
      if (spec.modelChanged && spec.model) out.push(`/model ${spec.model}`);
      return out;
    });
    mockAgentRegistryGet.mockReturnValue({ getInjectionSequence });

    const result = await callHandler({ taskId: 'task-1', model: null });

    expect(result).toEqual({ ok: true, mode: 'persisted' });
    // Critically, no PTY restart for an empty target.
    expect(context.sessionManager.suspend).not.toHaveBeenCalled();
    expect(engine.resumeSuspendedSession).not.toHaveBeenCalled();
    // DB write still persists the cleared override.
    expect(taskRepo.updateOverrides).toHaveBeenCalledWith('task-1', {
      model_override: null,
      effort_override: null,
    });
  });

  it('clearing one field (e.g. effort) when the other field needs a restart does restart', async () => {
    // Codex-style adapter: no slash, picking a specific model -> restart
    // is required so the new --model flag reaches the CLI on respawn.
    // The cleared effort field doesn't block this.
    task = createMockTask({ agent: 'codex', model_override: null, effort_override: 'high' });
    taskRepo.getById.mockReturnValue(task);
    swimlaneRepo.getById.mockReturnValue({
      id: 'lane-1',
      permission_mode: null,
      model_override: null,
      effort_override: null,
    });
    mockAgentRegistryGet.mockReturnValue({ getInjectionSequence: vi.fn(() => []) });

    const updatedTask = { ...task, model_override: 'gpt-5', effort_override: null, session_id: null };
    taskRepo.getById.mockReturnValueOnce(task).mockReturnValueOnce(updatedTask);

    // User picks a new model AND clears effort in one call.
    const result = await callHandler({ taskId: 'task-1', model: 'gpt-5', effort: null });

    expect(result).toEqual({ ok: true, mode: 'restart' });
    expect(context.sessionManager.suspend).toHaveBeenCalled();
  });

  it('falls back to suspend + resumeSuspendedSession when the adapter has no live-switch slash', async () => {
    // Codex-style adapter: has getInjectionSequence but returns []
    const getInjectionSequence = vi.fn(() => []);
    mockAgentRegistryGet.mockReturnValue({ getInjectionSequence });

    // After applySuspendDbWrites, session_id is cleared; mock the second
    // getById to reflect that state.
    const updatedTask = { ...task, session_id: null };
    taskRepo.getById
      .mockReturnValueOnce(task)        // first read at top of handler
      .mockReturnValueOnce(updatedTask); // re-read after suspend

    const result = await callHandler({ taskId: 'task-1', model: 'gpt-5' });
    expect(result).toEqual({ ok: true, mode: 'restart' });

    // DB persist happened
    expect(taskRepo.updateOverrides).toHaveBeenCalledWith('task-1', {
      model_override: 'gpt-5',
      effort_override: null,
    });
    // Suspend ran on the original session id
    expect(context.sessionManager.suspend).toHaveBeenCalledWith('session-1');
    expect(mockApplySuspendDbWrites).toHaveBeenCalledWith(expect.anything(), 'proj-1', 'task-1', 'system');
    // Respawn called with the cleared task and the new override
    expect(engine.resumeSuspendedSession).toHaveBeenCalled();
    // No live-switch slash should fire on the restart path
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Recovery contract: post-persist failures keep the override in DB
  // =========================================================================

  it('returns ok:false on suspend failure but leaves the override persisted (recovery contract)', async () => {
    mockAgentRegistryGet.mockReturnValue({ getInjectionSequence: vi.fn(() => []) });
    context.sessionManager.suspend.mockRejectedValue(new Error('PTY already exited'));

    const result = await callHandler({ taskId: 'task-1', model: 'gpt-5' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Renderer relies on the 'suspend failed' prefix to decide NOT to roll
      // back the optimistic UI - the DB persist is the source of truth.
      expect(result.reason).toMatch(/^suspend failed:/);
    }
    expect(taskRepo.updateOverrides).toHaveBeenCalledWith('task-1', {
      model_override: 'gpt-5',
      effort_override: null,
    });
  });

  it('returns ok:false on respawn failure but leaves the override persisted (recovery contract)', async () => {
    mockAgentRegistryGet.mockReturnValue({ getInjectionSequence: vi.fn(() => []) });
    engine.resumeSuspendedSession.mockRejectedValue(new Error('CLI exited'));

    const updatedTask = { ...task, session_id: null };
    taskRepo.getById.mockReturnValueOnce(task).mockReturnValueOnce(updatedTask);

    const result = await callHandler({ taskId: 'task-1', model: 'gpt-5' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Same prefix contract as suspend failures.
      expect(result.reason).toMatch(/^respawn failed:/);
    }
    // The override IS persisted - critical for the recovery story so the user
    // can hit "Resume" from the existing UI and the saved override applies.
    expect(taskRepo.updateOverrides).toHaveBeenCalledWith('task-1', {
      model_override: 'gpt-5',
      effort_override: null,
    });
  });
});
