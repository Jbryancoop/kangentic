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
import type { ActivityState, SessionEvent, SessionUsage } from '../../src/shared/types';

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
      getUsage: async () => ({}),
      getActivity: async () => ({}),
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

type MockableMethod = 'getActivity' | 'getUsage' | 'getEventsCache';

interface MockResults {
  getActivity?: Record<string, ActivityState>;
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
    getUsage: sessions.getUsage,
    getEventsCache: sessions.getEventsCache,
  };
  if (results.getActivity !== undefined) {
    sessions.getActivity = (async () => results.getActivity) as () => unknown;
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
