/**
 * Unit tests for the cache reconciliation in session-store.syncSessions().
 *
 * The contract being locked in:
 *
 *  - Eviction: when an id appears in the renderer store but is absent
 *    from the main-process cache, the renderer entry is dropped. The
 *    main engine has stopped tracking the session (suspend, respawn,
 *    full removal); the cache, not the store, is the authoritative
 *    key set.
 *
 *  - IPC-during-async-gap preservation: when an id appears in BOTH
 *    the cache and the store, the store value wins. An onActivity /
 *    onUsage / onEvent push may have delivered a fresher value
 *    between fetching the cache and applying it; syncSessions must
 *    not clobber that.
 *
 * The test pre-existed bug regression (`{ ...cached, ...current }`)
 * was that store-on-top preserved entries the cache had dropped,
 * leading to stale `sessionActivity[id] = 'thinking'` icons that
 * survived suspend/respawn and accumulated across HMR cycles.
 *
 * All tests drive the Zustand store directly. window.electronAPI is
 * stubbed globally so module-level optional chaining in the store
 * does not throw in the Node test environment.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/shared/types';
import type { ActivityReason, ActivityState, Session, SessionEvent, SessionUsage } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Stub window.electronAPI before importing the store.
// ---------------------------------------------------------------------------

(globalThis as Record<string, unknown>).window = {
  electronAPI: {
    config: {
      set: vi.fn(),
      get: async () => DEFAULT_CONFIG,
      getGlobal: async () => DEFAULT_CONFIG,
      getProjectOverrides: async () => null,
    },
    projects: {
      list: async () => [],
    },
    sessions: {
      list: async () => [],
      spawn: async () => ({}),
      kill: async () => {},
      reset: async () => {},
      suspend: async () => {},
      resume: async () => ({}),
      reconcile: async () => null,
      getUsage: async () => ({}),
      getActivity: async () => ({}),
      getActivityReasons: async () => ({}),
      getEventsCache: async () => ({}),
    },
  },
};

// Import after the global stub so the store module sees the mocked window.
import { useSessionStore } from '../../src/renderer/stores/session-store';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUsage(usedPercentage: number): SessionUsage {
  return {
    model: { id: 'claude-sonnet', displayName: 'Claude Sonnet' },
    contextWindow: {
      usedPercentage,
      usedTokens: usedPercentage * 100,
      cacheTokens: 0,
      totalInputTokens: usedPercentage * 80,
      totalOutputTokens: usedPercentage * 20,
      contextWindowSize: 200000,
    },
    cost: { totalCostUsd: 0.01, totalDurationMs: 3000 },
  };
}

function makeEvent(detail: string): SessionEvent {
  return { ts: Date.now(), type: 'idle', detail };
}

type MockableMethod = 'getActivity' | 'getActivityReasons' | 'getUsage' | 'getEventsCache';

interface MockResults {
  getActivity?: Record<string, ActivityState>;
  getActivityReasons?: Record<string, ActivityReason>;
  getUsage?: Record<string, SessionUsage>;
  getEventsCache?: Record<string, SessionEvent[]>;
}

/**
 * Override the stubbed IPC fetch methods used by syncSessions for one
 * call, then restore the originals. Keeps cross-test state clean.
 */
async function syncWithMocks(results: MockResults): Promise<void> {
  const sessions = (window as Record<string, unknown> & {
    electronAPI: { sessions: Record<MockableMethod, () => unknown> };
  }).electronAPI.sessions;
  const originals: Partial<Record<MockableMethod, unknown>> = {
    getActivity: sessions.getActivity,
    getActivityReasons: sessions.getActivityReasons,
    getUsage: sessions.getUsage,
    getEventsCache: sessions.getEventsCache,
  };
  if (results.getActivity !== undefined) {
    sessions.getActivity = (async () => results.getActivity) as () => unknown;
  }
  if (results.getActivityReasons !== undefined) {
    sessions.getActivityReasons = (async () => results.getActivityReasons) as () => unknown;
  }
  if (results.getUsage !== undefined) {
    sessions.getUsage = (async () => results.getUsage) as () => unknown;
  }
  if (results.getEventsCache !== undefined) {
    sessions.getEventsCache = (async () => results.getEventsCache) as () => unknown;
  }
  try {
    await useSessionStore.getState().syncSessions();
  } finally {
    if (originals.getActivity !== undefined) {
      sessions.getActivity = originals.getActivity as () => unknown;
    }
    if (originals.getActivityReasons !== undefined) {
      sessions.getActivityReasons = originals.getActivityReasons as () => unknown;
    }
    if (originals.getUsage !== undefined) {
      sessions.getUsage = originals.getUsage as () => unknown;
    }
    if (originals.getEventsCache !== undefined) {
      sessions.getEventsCache = originals.getEventsCache as () => unknown;
    }
  }
}

/** Reset only the fields touched by these tests to avoid cross-test leakage. */
function resetStore(): void {
  useSessionStore.setState({
    sessions: [],
    _sessionByTaskId: new Map(),
    activeSessionId: null,
    detailTaskId: null,
    dialogSessionId: null,
    sessionUsage: {},
    latestRateLimits: null,
    sessionFirstOutput: {},
    sessionActivity: {},
    sessionActivityReason: {},
    sessionEvents: {},
    seenIdleSessions: {},
    pendingCommandLabel: {},
    spawnProgress: {},
    _pendingOpenTaskId: null,
    _pendingOpenCommandTerminal: false,
  });
}

// ---------------------------------------------------------------------------
// Eviction: store entries absent from the cache are dropped.
// ---------------------------------------------------------------------------

describe('syncSessions - cache reconciliation evicts stale entries', () => {
  beforeEach(resetStore);

  it('drops a sessionActivity entry that no longer exists in the cache', async () => {
    // Seed two thinking sessions in the store. Then pretend the engine
    // has dropped 'sess-b' (suspend, respawn, etc.) so the cache only
    // contains 'sess-a'. The reconcile must keep 'sess-a' and evict 'sess-b'.
    useSessionStore.setState({
      sessionActivity: { 'sess-a': 'thinking', 'sess-b': 'thinking' },
    });

    await syncWithMocks({
      getActivity: { 'sess-a': 'thinking' },
    });

    const activity = useSessionStore.getState().sessionActivity;
    expect(activity).toEqual({ 'sess-a': 'thinking' });
    expect(activity['sess-b']).toBeUndefined();
  });

  it('drops a sessionUsage entry that no longer exists in the cache', async () => {
    useSessionStore.setState({
      sessionUsage: { 'sess-a': makeUsage(20), 'sess-stale': makeUsage(80) },
    });

    await syncWithMocks({
      getUsage: { 'sess-a': makeUsage(25) },
    });

    const usage = useSessionStore.getState().sessionUsage;
    expect(Object.keys(usage)).toEqual(['sess-a']);
    expect(usage['sess-stale']).toBeUndefined();
  });

  it('drops a sessionActivityReason entry that no longer exists in the cache', async () => {
    // Regression: pre-fix, sessionActivityReason was never reconciled by
    // syncSessions, so HMR / full reload left stale idle reasons in the
    // map indefinitely. The reconcile must use the same eviction
    // semantics as sessionActivity.
    const staleReason: ActivityReason = { kind: 'idle' };
    const liveReason: ActivityReason = { kind: 'turn-active' };
    useSessionStore.setState({
      sessionActivityReason: { 'sess-a': liveReason, 'sess-stale': staleReason },
    });

    await syncWithMocks({
      getActivityReasons: { 'sess-a': liveReason },
    });

    const reasons = useSessionStore.getState().sessionActivityReason;
    expect(Object.keys(reasons)).toEqual(['sess-a']);
    expect(reasons['sess-stale']).toBeUndefined();
  });

  it('drops a sessionEvents entry that no longer exists in the cache', async () => {
    useSessionStore.setState({
      sessionEvents: {
        'sess-a': [makeEvent('keep')],
        'sess-stale': [makeEvent('drop')],
      },
    });

    await syncWithMocks({
      getEventsCache: { 'sess-a': [makeEvent('keep')] },
    });

    const events = useSessionStore.getState().sessionEvents;
    expect(Object.keys(events)).toEqual(['sess-a']);
    expect(events['sess-stale']).toBeUndefined();
  });

  it('produces an empty record when the cache is empty, regardless of what the store held', async () => {
    useSessionStore.setState({
      sessionActivity: { 'sess-a': 'thinking', 'sess-b': 'idle' },
      sessionUsage: { 'sess-a': makeUsage(50) },
      sessionEvents: { 'sess-a': [makeEvent('any')] },
    });

    await syncWithMocks({
      getActivity: {},
      getUsage: {},
      getEventsCache: {},
    });

    const state = useSessionStore.getState();
    expect(state.sessionActivity).toEqual({});
    expect(state.sessionUsage).toEqual({});
    expect(state.sessionEvents).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Preservation: store entries for ids in the cache win over cache values.
// ---------------------------------------------------------------------------

describe('syncSessions - cache reconciliation preserves IPC-during-async-gap updates', () => {
  beforeEach(resetStore);

  it('keeps the store value for sessionActivity when the id is in both maps', async () => {
    // Simulates: cache snapshot says 'idle' (taken at start of sync),
    // but an onActivity push during the async gap moved it to 'thinking'
    // in the store. The reconcile must keep the store value.
    useSessionStore.setState({
      sessionActivity: { 'sess-a': 'thinking' },
    });

    await syncWithMocks({
      getActivity: { 'sess-a': 'idle' },
    });

    expect(useSessionStore.getState().sessionActivity['sess-a']).toBe('thinking');
  });

  it('keeps the store value for sessionUsage when the id is in both maps', async () => {
    const liveUsage = makeUsage(75);
    useSessionStore.setState({
      sessionUsage: { 'sess-a': liveUsage },
    });

    await syncWithMocks({
      getUsage: { 'sess-a': makeUsage(10) },
    });

    expect(useSessionStore.getState().sessionUsage['sess-a']).toBe(liveUsage);
  });

  it('keeps the store value for sessionActivityReason when the id is in both maps', async () => {
    // onActivity push during the async gap may have delivered a fresher
    // reason than the cache snapshot; reconcile must keep the store value.
    const liveReason: ActivityReason = { kind: 'turn-active' };
    const cacheReason: ActivityReason = { kind: 'idle' };
    useSessionStore.setState({
      sessionActivityReason: { 'sess-a': liveReason },
    });

    await syncWithMocks({
      getActivityReasons: { 'sess-a': cacheReason },
    });

    expect(useSessionStore.getState().sessionActivityReason['sess-a']).toBe(liveReason);
  });

  it('keeps the store value for sessionEvents when the id is in both maps', async () => {
    const liveEvents = [makeEvent('store-side-1'), makeEvent('store-side-2')];
    useSessionStore.setState({
      sessionEvents: { 'sess-a': liveEvents },
    });

    await syncWithMocks({
      getEventsCache: { 'sess-a': [makeEvent('cache-side-only')] },
    });

    expect(useSessionStore.getState().sessionEvents['sess-a']).toBe(liveEvents);
  });

  it('adds a brand-new id from the cache when the store has nothing for it', async () => {
    // 'sess-new' is absent from the store but present in cache; reconcile
    // must surface it. This is the "first sync sees a new session" path.
    useSessionStore.setState({
      sessionActivity: { 'sess-existing': 'idle' },
    });

    await syncWithMocks({
      getActivity: { 'sess-existing': 'idle', 'sess-new': 'thinking' },
    });

    const activity = useSessionStore.getState().sessionActivity;
    expect(activity['sess-existing']).toBe('idle');
    expect(activity['sess-new']).toBe('thinking');
  });
});

// ---------------------------------------------------------------------------
// reconcileSession action
//
// Contract:
//  - null no-op: when the IPC returns null, the sessions array is unchanged,
//    spawnProgress is unchanged, and the action returns null.
//  - by-id replace: when the live session shares the id of an existing row,
//    replace it in-place and clear spawnProgress[taskId].
//  - taskId-evict + add: when the live session has a NEW id but an old row
//    with the same taskId exists, evict the old row, add the new one, and
//    clear spawnProgress[taskId].
//  - spawnProgress eviction: any 'Initializing...' label for the task is
//    cleared whenever a live session arrives (both replace and evict paths).
// ---------------------------------------------------------------------------

/** Build a minimal Session object for test seeding. */
function makeSession(overrides: Partial<Session> & Pick<Session, 'id' | 'taskId'>): Session {
  return {
    projectId: 'proj-test',
    pid: null,
    status: 'running',
    shell: 'bash',
    cwd: '/mock/project',
    startedAt: new Date().toISOString(),
    exitCode: null,
    resuming: false,
    ...overrides,
  };
}

/**
 * Temporarily replace sessions.reconcile for one call, then restore.
 * Mirrors the syncWithMocks pattern used by the cache-reconciliation tests above.
 */
async function reconcileWith(
  returnValue: Session | null,
): Promise<Session | null> {
  const sessionsApi = (window as Record<string, unknown> & {
    electronAPI: { sessions: { reconcile: (taskId: string) => Promise<Session | null> } };
  }).electronAPI.sessions;
  const original = sessionsApi.reconcile;
  sessionsApi.reconcile = async () => returnValue;
  try {
    return await useSessionStore.getState().reconcileSession('task-a');
  } finally {
    sessionsApi.reconcile = original;
  }
}

describe('reconcileSession - null no-op', () => {
  beforeEach(resetStore);

  it('leaves sessions array unchanged when reconcile() returns null', async () => {
    const existing = makeSession({ id: 'sess-1', taskId: 'task-a', status: 'suspended' });
    useSessionStore.setState({ sessions: [existing], _sessionByTaskId: new Map([['task-a', existing]]) });

    const result = await reconcileWith(null);

    expect(result).toBeNull();
    const { sessions } = useSessionStore.getState();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toBe(existing);
  });

  it('leaves spawnProgress unchanged when reconcile() returns null', async () => {
    useSessionStore.setState({ spawnProgress: { 'task-a': 'Initializing...' } });

    await reconcileWith(null);

    expect(useSessionStore.getState().spawnProgress['task-a']).toBe('Initializing...');
  });
});

describe('reconcileSession - by-id in-place replace', () => {
  beforeEach(resetStore);

  it('replaces the existing row in-place when the live session shares the same id', async () => {
    // Seed a suspended row for the same session id. The live session
    // returns with status='running' - simulates the renderer-drifted-from-main bug.
    const staleSuspended = makeSession({ id: 'sess-1', taskId: 'task-a', status: 'suspended' });
    useSessionStore.setState({
      sessions: [staleSuspended],
      _sessionByTaskId: new Map([['task-a', staleSuspended]]),
    });

    const liveSession = makeSession({ id: 'sess-1', taskId: 'task-a', status: 'running', pid: 99 });
    const result = await reconcileWith(liveSession);

    expect(result).toBe(liveSession);
    const { sessions, _sessionByTaskId } = useSessionStore.getState();
    // Exactly one row still in the array.
    expect(sessions).toHaveLength(1);
    // The row is the live session object (replaced in-place).
    expect(sessions[0]).toBe(liveSession);
    // Index reflects the replacement.
    expect(_sessionByTaskId.get('task-a')).toBe(liveSession);
  });

  it('clears spawnProgress[taskId] on by-id replace', async () => {
    const staleSuspended = makeSession({ id: 'sess-1', taskId: 'task-a', status: 'suspended' });
    useSessionStore.setState({
      sessions: [staleSuspended],
      _sessionByTaskId: new Map([['task-a', staleSuspended]]),
      spawnProgress: { 'task-a': 'Initializing...' },
    });

    const liveSession = makeSession({ id: 'sess-1', taskId: 'task-a', status: 'running' });
    await reconcileWith(liveSession);

    expect(useSessionStore.getState().spawnProgress['task-a']).toBeUndefined();
  });

  it('does not disturb sibling sessions for other tasks on by-id replace', async () => {
    const sibling = makeSession({ id: 'sess-sibling', taskId: 'task-b', status: 'running' });
    const stale = makeSession({ id: 'sess-1', taskId: 'task-a', status: 'suspended' });
    useSessionStore.setState({
      sessions: [stale, sibling],
      _sessionByTaskId: new Map([['task-a', stale], ['task-b', sibling]]),
    });

    const liveSession = makeSession({ id: 'sess-1', taskId: 'task-a', status: 'running' });
    await reconcileWith(liveSession);

    const { sessions } = useSessionStore.getState();
    expect(sessions).toHaveLength(2);
    expect(sessions.find((s) => s.id === 'sess-sibling')).toBe(sibling);
  });
});

describe('reconcileSession - taskId-evict + add (respawn path)', () => {
  beforeEach(resetStore);

  it('evicts the old row and inserts the new session when the id differs', async () => {
    // Seed an old suspended session (old id). Main has respawned the task
    // under a new session id. The store should drop the old row and add the new one.
    const oldSession = makeSession({ id: 'sess-old', taskId: 'task-a', status: 'suspended' });
    useSessionStore.setState({
      sessions: [oldSession],
      _sessionByTaskId: new Map([['task-a', oldSession]]),
    });

    const liveSession = makeSession({ id: 'sess-new', taskId: 'task-a', status: 'running', pid: 42 });
    const result = await reconcileWith(liveSession);

    expect(result).toBe(liveSession);
    const { sessions, _sessionByTaskId } = useSessionStore.getState();
    // Old row is gone; new row is present.
    expect(sessions.find((s) => s.id === 'sess-old')).toBeUndefined();
    expect(sessions.find((s) => s.id === 'sess-new')).toBe(liveSession);
    expect(sessions).toHaveLength(1);
    // Index reflects new row.
    expect(_sessionByTaskId.get('task-a')).toBe(liveSession);
  });

  it('clears spawnProgress[taskId] on taskId-evict + add', async () => {
    const oldSession = makeSession({ id: 'sess-old', taskId: 'task-a', status: 'suspended' });
    useSessionStore.setState({
      sessions: [oldSession],
      _sessionByTaskId: new Map([['task-a', oldSession]]),
      spawnProgress: { 'task-a': 'Initializing...' },
    });

    const liveSession = makeSession({ id: 'sess-new', taskId: 'task-a', status: 'running' });
    await reconcileWith(liveSession);

    expect(useSessionStore.getState().spawnProgress['task-a']).toBeUndefined();
  });

  it('does not disturb sibling sessions for other tasks on evict + add', async () => {
    const sibling = makeSession({ id: 'sess-sibling', taskId: 'task-b', status: 'running' });
    const oldSession = makeSession({ id: 'sess-old', taskId: 'task-a', status: 'suspended' });
    useSessionStore.setState({
      sessions: [oldSession, sibling],
      _sessionByTaskId: new Map([['task-a', oldSession], ['task-b', sibling]]),
    });

    const liveSession = makeSession({ id: 'sess-new', taskId: 'task-a', status: 'running' });
    await reconcileWith(liveSession);

    const { sessions } = useSessionStore.getState();
    expect(sessions).toHaveLength(2);
    expect(sessions.find((s) => s.id === 'sess-sibling')).toBe(sibling);
  });
});

describe('reconcileSession - spawnProgress eviction on heal', () => {
  beforeEach(resetStore);

  it('clears the spawnProgress label when a live session arrives, leaving other tasks untouched', async () => {
    // Two tasks both have in-flight spawn labels. Only task-a is being reconciled.
    const staleSession = makeSession({ id: 'sess-1', taskId: 'task-a', status: 'suspended' });
    useSessionStore.setState({
      sessions: [staleSession],
      _sessionByTaskId: new Map([['task-a', staleSession]]),
      spawnProgress: {
        'task-a': 'Initializing...',
        'task-b': 'Starting agent...',
      },
    });

    const liveSession = makeSession({ id: 'sess-1', taskId: 'task-a', status: 'running' });
    await reconcileWith(liveSession);

    const { spawnProgress } = useSessionStore.getState();
    // task-a's label is gone (healed).
    expect(spawnProgress['task-a']).toBeUndefined();
    // task-b's label is untouched (different task, not reconciled).
    expect(spawnProgress['task-b']).toBe('Starting agent...');
  });
});
