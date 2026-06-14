/**
 * Unit tests for the SWIMLANE_UPDATE IPC handler in board.ts.
 *
 * Focuses on the two branches introduced by the model-change restart feature:
 *
 *   1. MODEL change (prepareInjectionPlan returns needsRestartForModel: true)
 *      -> restartSessionForSettingsChange is called fire-and-forget inside
 *      withTaskLock; scheduleKeystrokes is NOT called.
 *
 *   2. EFFORT-only change (prepareInjectionPlan returns a plan with a non-empty
 *      sequence and needsRestartForModel: false)
 *      -> scheduleKeystrokes IS called; restartSessionForSettingsChange is NOT.
 *
 * The handler is SYNCHRONOUS (returns the swimlane update result immediately).
 * The restart is FIRE-AND-FORGET via `void withTaskLock(taskId, async () => ...)`.
 * Tests use the REAL withTaskLock (exercises the p-queue wiring) and poll for
 * the async side-effect via vi.waitFor, which is the canonical pattern for
 * assertions on fire-and-forget async callbacks.
 *
 * Pattern: capture the function registered via ipcMain.handle(IPC.SWIMLANE_UPDATE)
 * and invoke it directly - same approach as task-runtime-override-handler.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock state (must be defined before vi.mock calls)
// ---------------------------------------------------------------------------

const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();

const hoisted = vi.hoisted(() => ({
  restartSessionForSettingsChange: vi.fn(async () => ({ ok: true as const })),
  prepareInjectionPlan: vi.fn(() => null as ReturnType<typeof import('../../src/main/engine/injection-plan').prepareInjectionPlan>),
}));

// ---------------------------------------------------------------------------
// Module mocks (declared before any imports)
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
  },
  shell: { openPath: vi.fn(async () => '') },
}));

// board.ts imports `fs` for attachment open - stub it so no real FS access occurs.
vi.mock('node:fs', () => ({
  default: {
    mkdirSync: vi.fn(),
    copyFileSync: vi.fn(),
  },
}));

vi.mock('node:path', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:path')>();
  return { default: original };
});

vi.mock('node:os', () => ({
  default: { tmpdir: vi.fn(() => '/tmp') },
}));

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));

vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    updateAppliedSettings = vi.fn();
  },
}));

const mockGetProjectRepos = vi.fn();
vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
}));

vi.mock('../../src/main/ipc/handlers/session-reconcile', () => ({
  restartSessionForSettingsChange: (...args: unknown[]) =>
    hoisted.restartSessionForSettingsChange(...args),
}));

vi.mock('../../src/main/engine/injection-plan', () => ({
  prepareInjectionPlan: (...args: unknown[]) => hoisted.prepareInjectionPlan(...args as [never]),
}));

const mockAgentRegistryGet = vi.fn();
vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    get: (name: string) => mockAgentRegistryGet(name),
  },
}));

vi.mock('../../src/main/diagnostics/project-log-context', () => ({
  runWithProjectLogContext: vi.fn((_name: string, fn: () => unknown) => fn()),
}));

// ---------------------------------------------------------------------------
// Import under test (after all vi.mock declarations)
// ---------------------------------------------------------------------------

import { registerBoardHandlers } from '../../src/main/ipc/handlers/board';
import { IPC } from '../../src/shared/ipc-channels';

// ---------------------------------------------------------------------------
// Shared types and helpers
// ---------------------------------------------------------------------------

interface MockSwimlaneBefore {
  id: string;
  name: string;
  model_override: string | null;
  effort_override: string | null;
}

interface MockTask {
  id: string;
  agent: string | null;
  session_id: string | null;
  swimlane_id: string;
  model_override: string | null;
  effort_override: string | null;
}

interface MockContext {
  currentProjectId: string | null;
  currentProjectPath: string | null;
  sessionManager: {
    getSession: ReturnType<typeof vi.fn>;
  };
  terminalSubmitScheduler: { scheduleKeystrokes: ReturnType<typeof vi.fn> };
  boardConfigManager: {
    writeBack: ReturnType<typeof vi.fn>;
    exists: ReturnType<typeof vi.fn>;
    exportFromDb: ReturnType<typeof vi.fn>;
    applyFileChange: ReturnType<typeof vi.fn>;
    getShortcuts: ReturnType<typeof vi.fn>;
    setShortcuts: ReturnType<typeof vi.fn>;
    setDefaultBaseBranch: ReturnType<typeof vi.fn>;
  };
  projectRepo: {
    getById: ReturnType<typeof vi.fn>;
  };
}

function createMockContext(overrides: Partial<MockContext> = {}): MockContext {
  return {
    currentProjectId: 'proj-board-1',
    currentProjectPath: '/mock/board-project',
    sessionManager: {
      getSession: vi.fn(() => ({ status: 'running' })),
    },
    terminalSubmitScheduler: { scheduleKeystrokes: vi.fn() },
    boardConfigManager: {
      writeBack: vi.fn(),
      exists: vi.fn(() => false),
      exportFromDb: vi.fn(),
      applyFileChange: vi.fn(() => ({ warnings: [] })),
      getShortcuts: vi.fn(() => []),
      setShortcuts: vi.fn(),
      setDefaultBaseBranch: vi.fn(),
    },
    projectRepo: {
      getById: vi.fn(() => ({ id: 'proj-board-1', name: 'Test Project', path: '/mock/board-project' })),
    },
    ...overrides,
  };
}

function createSwimlaneBefore(overrides: Partial<MockSwimlaneBefore> = {}): MockSwimlaneBefore {
  return {
    id: 'lane-executing',
    name: 'Executing',
    model_override: null,
    effort_override: null,
    ...overrides,
  };
}

function createTaskInLane(overrides: Partial<MockTask> = {}): MockTask {
  return {
    id: 'task-board-1',
    agent: 'claude',
    session_id: 'session-board-1',
    swimlane_id: 'lane-executing',
    model_override: null,
    effort_override: null,
    ...overrides,
  };
}

/** Build the repos mock returned by getProjectRepos for the SWIMLANE_UPDATE call. */
function buildProjectRepos(
  swimlaneBefore: MockSwimlaneBefore | null,
  updatedSwimlane: MockSwimlaneBefore,
  tasksInLane: MockTask[],
) {
  const swimlaneRepo = {
    getById: vi.fn(() => swimlaneBefore),
    update: vi.fn(() => updatedSwimlane),
    list: vi.fn(() => [updatedSwimlane]),
    create: vi.fn(),
    delete: vi.fn(),
    reorder: vi.fn(),
  };
  const taskRepo = {
    list: vi.fn(() => tasksInLane),
    getById: vi.fn(() => tasksInLane[0] ?? null),
  };
  return {
    swimlanes: swimlaneRepo,
    tasks: taskRepo,
    actions: {
      list: vi.fn(() => []),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      listTransitions: vi.fn(() => []),
      setTransitions: vi.fn(),
      getTransitionsFor: vi.fn(() => []),
    },
    attachments: {
      list: vi.fn(() => []),
      add: vi.fn(),
      remove: vi.fn(),
      getDataUrl: vi.fn(),
      getById: vi.fn(),
      deleteByTaskId: vi.fn(),
    },
  };
}

/**
 * Invoke the captured SWIMLANE_UPDATE handler with the given input and context.
 * Returns the synchronous result (the updated swimlane row).
 */
async function callSwimlaneUpdate(
  input: { id: string; name?: string; model_override?: string | null; effort_override?: string | null },
  context: MockContext,
): Promise<unknown> {
  const handler = capturedHandlers.get(IPC.SWIMLANE_UPDATE);
  if (!handler) throw new Error(`Handler for ${IPC.SWIMLANE_UPDATE} was not registered`);
  return handler(null, input);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SWIMLANE_UPDATE handler - restart-on-model and effort live-inject branches', () => {
  let context: MockContext;

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.restartSessionForSettingsChange.mockReset();
    hoisted.restartSessionForSettingsChange.mockResolvedValue({ ok: true });
    hoisted.prepareInjectionPlan.mockReset();
    hoisted.prepareInjectionPlan.mockReturnValue(null);
    capturedHandlers.clear();

    context = createMockContext();
    registerBoardHandlers(context as never);
  });

  // =========================================================================
  // Test 1: MODEL change -> restartSessionForSettingsChange called, no scheduleKeystrokes
  // =========================================================================

  it('MODEL change: calls restartSessionForSettingsChange and does NOT call scheduleKeystrokes', async () => {
    // A running task in the swimlane. prepareInjectionPlan signals needsRestartForModel.
    const task = createTaskInLane({ id: 'task-board-1', session_id: 'session-board-1' });
    const swimlaneBefore = createSwimlaneBefore({ id: 'lane-executing' });
    const updatedSwimlane = { ...swimlaneBefore, model_override: 'opus', name: 'Executing' };

    const repos = buildProjectRepos(swimlaneBefore, updatedSwimlane, [task]);
    mockGetProjectRepos.mockReturnValue(repos);

    // sessionManager.getSession returns a running session for this task.
    context.sessionManager.getSession.mockReturnValue({ status: 'running' });

    // agentRegistry resolves the adapter for this task's agent.
    mockAgentRegistryGet.mockReturnValue({ name: 'claude' });

    // prepareInjectionPlan indicates a model change requires a restart.
    hoisted.prepareInjectionPlan.mockReturnValue({
      sequence: [],
      verifier: null,
      verifiedPrefixLength: 0,
      needsRestartForModel: true,
    });

    // Handler is synchronous. Call it and let it return.
    await callSwimlaneUpdate({ id: 'lane-executing', model_override: 'opus' }, context);

    // The restart runs fire-and-forget inside withTaskLock.
    // Poll until the async callback has had a chance to execute.
    await vi.waitFor(() => {
      expect(hoisted.restartSessionForSettingsChange).toHaveBeenCalledTimes(1);
    }, { timeout: 2000 });

    // Verify the exact arguments passed to the shared helper.
    expect(hoisted.restartSessionForSettingsChange).toHaveBeenCalledWith(
      context,
      'proj-board-1',
      '/mock/board-project',
      'task-board-1',
    );

    // Live-injection must NOT fire alongside a model-change restart.
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Test 2: EFFORT-only change -> scheduleKeystrokes called, no restart
  // =========================================================================

  it('EFFORT-only change: calls scheduleKeystrokes and does NOT call restartSessionForSettingsChange', async () => {
    const task = createTaskInLane({ id: 'task-board-2', session_id: 'session-board-2' });
    const swimlaneBefore = createSwimlaneBefore({ id: 'lane-executing' });
    const updatedSwimlane = { ...swimlaneBefore, effort_override: 'xhigh', name: 'Executing' };

    const repos = buildProjectRepos(swimlaneBefore, updatedSwimlane, [task]);
    mockGetProjectRepos.mockReturnValue(repos);

    context.sessionManager.getSession.mockReturnValue({ status: 'running' });
    mockAgentRegistryGet.mockReturnValue({ name: 'claude' });

    // prepareInjectionPlan returns a live-inject plan (no model restart needed).
    hoisted.prepareInjectionPlan.mockReturnValue({
      sequence: ['/effort xhigh'],
      verifier: null,
      verifiedPrefixLength: 1,
      needsRestartForModel: false,
      appliedSettings: { effort: 'xhigh' },
    });

    await callSwimlaneUpdate({ id: 'lane-executing', effort_override: 'xhigh' }, context);

    // scheduleKeystrokes fires synchronously in the handler body (not fire-and-forget).
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).toHaveBeenCalledTimes(1);
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).toHaveBeenCalledWith(
      'task-board-2',
      'session-board-2',
      ['/effort xhigh'],
      { verifier: null, verifiedPrefixLength: 1 },
    );

    // No restart should have been triggered for an effort-only change.
    expect(hoisted.restartSessionForSettingsChange).not.toHaveBeenCalled();
  });
});
