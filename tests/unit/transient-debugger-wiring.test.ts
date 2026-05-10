/**
 * Unit tests for the Activity Engine Debugger wiring of transient sessions.
 *
 * The debugger overlay (src/renderer/components/debug/ActivityDebugOverlay.tsx)
 * filters `state.sessions` for `projectId === currentProjectId && status === 'running'`.
 * For a Command Terminal session to appear in the overlay, the spawn flow must
 * place the Session row into `state.sessions` synchronously - waiting on the
 * push-based `session-changed` event from main introduces a race where the
 * user can open Ctrl+Shift+D before the row arrives and see an empty overlay.
 *
 * These tests lock in the contract that `spawnTransientSession` upserts the
 * session into `state.sessions` before resolving.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Session } from '../../src/shared/types';

const FAKE_PROJECT_ID = 'proj-debugger-test';
const FAKE_SESSION_ID = 'sess-debugger-test';

vi.mock('../../src/renderer/stores/project-store', () => ({
  useProjectStore: {
    getState: vi.fn(() => ({
      currentProject: { id: FAKE_PROJECT_ID, name: 'Test', path: '/tmp/test' },
    })),
  },
}));

const spawnTransientMock = vi.fn();
// Stub the window.electronAPI surface the slice calls into.
(globalThis as unknown as { window: unknown }).window = {
  electronAPI: {
    sessions: {
      spawnTransient: spawnTransientMock,
      killTransient: vi.fn(),
    },
  },
};

import { createTransientSessionSlice } from '../../src/renderer/stores/session-store/transient-session-slice';
import type { SessionStore } from '../../src/renderer/stores/session-store/types';
import { buildSessionByTaskId } from '../../src/renderer/stores/session-store/session-index';

/**
 * Minimal store harness that exercises the transient slice plus a real-ish
 * `upsertSession` (copied from session-store.ts:426-442). The real Zustand
 * store can't run here because session-store.ts itself imports renderer-only
 * modules.
 */
function makeSliceStore(initialSessions: Session[] = []) {
  let state: Partial<SessionStore> & Record<string, unknown> = {
    sessions: initialSessions,
    _sessionByTaskId: buildSessionByTaskId(initialSessions),
    sessionUsage: {},
    sessionFirstOutput: {},
    sessionActivity: {},
    sessionActivityReason: {},
    sessionEvents: {},
    seenIdleSessions: {},
    spawnProgress: {},
    commandBarVisible: false,
    transientSessions: {},
    transientSessionId: null,
    transientBranch: null,
  };

  const upsertSession = (session: Session) => {
    const sessions = state.sessions as Session[];
    const existingIndex = sessions.findIndex((s) => s.id === session.id);
    let nextSessions: Session[];
    if (existingIndex >= 0) {
      nextSessions = [...sessions];
      nextSessions[existingIndex] = session;
    } else {
      nextSessions = [...sessions.filter((s) => s.taskId !== session.taskId), session];
    }
    state = {
      ...state,
      sessions: nextSessions,
      _sessionByTaskId: buildSessionByTaskId(nextSessions),
    };
  };

  state = { ...state, upsertSession };

  const get = () => state as unknown as SessionStore;
  const set = (updater: Partial<SessionStore> | ((prev: SessionStore) => Partial<SessionStore>)) => {
    if (typeof updater === 'function') {
      const partial = updater(state as unknown as SessionStore);
      if (partial !== (state as unknown)) {
        state = { ...state, ...partial };
      }
    } else {
      state = { ...state, ...updater };
    }
  };

  const sliceCreator = createTransientSessionSlice(undefined);
  const slice = sliceCreator(
    set as unknown as Parameters<typeof sliceCreator>[0],
    get,
    {} as unknown as Parameters<typeof sliceCreator>[2],
  );

  return {
    slice,
    getState: () => state as unknown as SessionStore,
  };
}

function buildFakeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: FAKE_SESSION_ID,
    taskId: 'task-transient-uuid',
    projectId: FAKE_PROJECT_ID,
    pid: 1234,
    status: 'running',
    shell: 'bash',
    cwd: '/tmp/test',
    startedAt: new Date().toISOString(),
    exitCode: null,
    resuming: false,
    transient: true,
    ...overrides,
  };
}

describe('spawnTransientSession — debugger overlay wiring', () => {
  beforeEach(() => {
    spawnTransientMock.mockReset();
  });

  it('inserts the new session into state.sessions synchronously so the debugger filter sees it', async () => {
    const session = buildFakeSession();
    spawnTransientMock.mockResolvedValueOnce({ session, branch: 'main' });

    const { slice, getState } = makeSliceStore([]);

    expect(getState().sessions).toEqual([]);

    await slice.spawnTransientSession();

    const sessions = getState().sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toEqual(session);
    // Debugger filter: projectId === currentProjectId && status === 'running'
    expect(sessions[0].projectId).toBe(FAKE_PROJECT_ID);
    expect(sessions[0].status).toBe('running');
    expect(sessions[0].transient).toBe(true);
  });

  it('sets the transient pointers alongside the session row', async () => {
    const session = buildFakeSession();
    spawnTransientMock.mockResolvedValueOnce({ session, branch: 'main' });

    const { slice, getState } = makeSliceStore([]);

    await slice.spawnTransientSession();

    const post = getState();
    expect(post.transientSessionId).toBe(session.id);
    expect(post.transientBranch).toBe('main');
    expect(post.transientSessions[FAKE_PROJECT_ID]).toEqual({
      sessionId: session.id,
      branch: 'main',
    });
  });

  it('clearTransientSession removes the session row from state.sessions', async () => {
    const session = buildFakeSession();
    spawnTransientMock.mockResolvedValueOnce({ session, branch: 'main' });

    const { slice, getState } = makeSliceStore([]);
    await slice.spawnTransientSession();
    expect(getState().sessions).toHaveLength(1);

    slice.clearTransientSession();

    expect(getState().sessions).toHaveLength(0);
    expect(getState().transientSessionId).toBeNull();
    expect(getState().transientSessions[FAKE_PROJECT_ID]).toBeUndefined();
  });

  it('a duplicate upsertSession (from the later session-changed push) is idempotent', async () => {
    const session = buildFakeSession();
    spawnTransientMock.mockResolvedValueOnce({ session, branch: 'main' });

    const { slice, getState } = makeSliceStore([]);
    await slice.spawnTransientSession();
    expect(getState().sessions).toHaveLength(1);

    // Simulate the push event that arrives shortly after spawn resolves.
    getState().upsertSession(session);

    expect(getState().sessions).toHaveLength(1);
    expect(getState().sessions[0]).toEqual(session);
  });
});
