/**
 * Unit tests for the toggleBrowserOpen reducer in
 * src/renderer/stores/session-store/task-changes-panel-slice.ts.
 *
 * The slice is a Zustand StateCreator - a plain function that takes (set, get).
 * We drive it by constructing a minimal in-memory store using a closure so no
 * browser, Electron, or ipcRenderer binding is required.
 */

import { describe, it, expect } from 'vitest';
import { createTaskChangesPanelSlice } from '../../src/renderer/stores/session-store/task-changes-panel-slice';
import type { TaskChangesPanelSlice } from '../../src/renderer/stores/session-store/task-changes-panel-slice';

// ---------------------------------------------------------------------------
// Minimal store harness
// ---------------------------------------------------------------------------

/**
 * Instantiates the slice with a real set/get closure so all state mutations
 * are properly tracked. Returns the slice's initial state merged with its
 * action methods, and a `getState()` accessor for reading current values.
 */
function createTestStore(): { actions: TaskChangesPanelSlice; getState: () => TaskChangesPanelSlice } {
  let state: TaskChangesPanelSlice;

  const set = (partial: Partial<TaskChangesPanelSlice> | ((s: TaskChangesPanelSlice) => Partial<TaskChangesPanelSlice>)) => {
    const next = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...next };
  };

  const get = () => state;

  // StateCreator signature: (set, get, _api) - api not used by this slice
  state = createTaskChangesPanelSlice(set as never, get as never, {} as never);

  return {
    actions: state,
    getState: get,
  };
}

// ---------------------------------------------------------------------------
// toggleBrowserOpen
// ---------------------------------------------------------------------------

describe('toggleBrowserOpen', () => {
  it('adds taskId to browserOpenTasks when not present', () => {
    const { actions, getState } = createTestStore();
    actions.toggleBrowserOpen('task-1');
    expect(getState().browserOpenTasks.has('task-1')).toBe(true);
  });

  it('removes taskId from browserOpenTasks when already present', () => {
    const { actions, getState } = createTestStore();
    actions.toggleBrowserOpen('task-1');
    actions.toggleBrowserOpen('task-1');
    expect(getState().browserOpenTasks.has('task-1')).toBe(false);
  });

  it('toggles independently per taskId', () => {
    const { actions, getState } = createTestStore();
    actions.toggleBrowserOpen('task-1');
    actions.toggleBrowserOpen('task-2');
    expect(getState().browserOpenTasks.has('task-1')).toBe(true);
    expect(getState().browserOpenTasks.has('task-2')).toBe(true);

    actions.toggleBrowserOpen('task-1');
    expect(getState().browserOpenTasks.has('task-1')).toBe(false);
    expect(getState().browserOpenTasks.has('task-2')).toBe(true);
  });

  it('does not mutate changesOpenTasks when toggling browser', () => {
    const { actions, getState } = createTestStore();
    // Pre-populate changesOpenTasks via toggleChangesOpen
    actions.toggleChangesOpen('task-1');
    expect(getState().changesOpenTasks.has('task-1')).toBe(true);

    actions.toggleBrowserOpen('task-1');
    // changesOpenTasks must be unaffected
    expect(getState().changesOpenTasks.has('task-1')).toBe(true);
  });

  it('does not mutate browserOpenTasks when toggling changes', () => {
    const { actions, getState } = createTestStore();
    actions.toggleBrowserOpen('task-1');
    expect(getState().browserOpenTasks.has('task-1')).toBe(true);

    actions.toggleChangesOpen('task-1');
    // browserOpenTasks must be unaffected
    expect(getState().browserOpenTasks.has('task-1')).toBe(true);
  });

  it('starts with an empty browserOpenTasks set', () => {
    const { getState } = createTestStore();
    expect(getState().browserOpenTasks.size).toBe(0);
  });
});
