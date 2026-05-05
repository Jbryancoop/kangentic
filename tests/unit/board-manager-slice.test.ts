/**
 * Unit tests for the board-manager-slice Zustand slice.
 *
 * Tests the counter invariant for `boardManagerAddDraftRequest`:
 * - Opening while closed with addNew=true must NOT increment the counter.
 * - Opening while open with addNew=true must increment by exactly 1.
 * - Multiple rapid calls each increment by 1.
 * - `closeBoardManager` resets the open/initialId/seedNew fields but leaves
 *   the counter untouched.
 */
import { describe, it, expect, vi } from 'vitest';
import { createBoardManagerSlice } from '../../src/renderer/stores/board-store/board-manager-slice';
import type { BoardManagerSlice } from '../../src/renderer/stores/board-store/board-manager-slice';

/**
 * Build a standalone slice instance by calling the StateCreator directly with a
 * simple `set` function backed by a plain object. This mirrors the Zustand
 * testing pattern for isolated slice units.
 */
function buildSlice(): { getState: () => BoardManagerSlice; setState: (partial: Partial<BoardManagerSlice>) => void } {
  let state: BoardManagerSlice = {} as BoardManagerSlice;

  const set = (updater: Partial<BoardManagerSlice> | ((previous: BoardManagerSlice) => Partial<BoardManagerSlice>)) => {
    const patch = typeof updater === 'function' ? updater(state) : updater;
    state = { ...state, ...patch };
  };

  // The slice creator receives (set, get, store). For these tests only `set`
  // is exercised, so we pass stubs for the other two positions.
  const slice = createBoardManagerSlice(set as Parameters<typeof createBoardManagerSlice>[0], () => state as never, {} as never);
  state = { ...slice };

  return {
    getState: () => state,
    setState: (partial) => { state = { ...state, ...partial }; },
  };
}

describe('board-manager-slice initial state', () => {
  it('initialises with sane defaults', () => {
    const { getState } = buildSlice();
    const state = getState();
    expect(state.boardManagerOpen).toBe(false);
    expect(state.boardManagerInitialId).toBeNull();
    expect(state.boardManagerSeedNew).toBe(false);
    expect(state.boardManagerAddDraftRequest).toBe(0);
  });
});

describe('openBoardManager', () => {
  it('sets boardManagerOpen to true', () => {
    const { getState } = buildSlice();
    getState().openBoardManager('lane-1');
    expect(getState().boardManagerOpen).toBe(true);
  });

  it('stores the supplied initialId', () => {
    const { getState } = buildSlice();
    getState().openBoardManager('lane-abc');
    expect(getState().boardManagerInitialId).toBe('lane-abc');
  });

  it('stores null initialId when called with no arguments', () => {
    const { getState } = buildSlice();
    getState().openBoardManager();
    expect(getState().boardManagerInitialId).toBeNull();
  });

  it('stores seedNew when addNew is true', () => {
    const { getState } = buildSlice();
    getState().openBoardManager(null, true);
    expect(getState().boardManagerSeedNew).toBe(true);
  });

  // ── Counter invariant: closed → open with addNew=true ────────────────────
  // The counter must NOT increment on the very first open (closed → open)
  // regardless of addNew, because there is no dialog mounted yet to receive
  // the increment. The seedNew prop handles the initial new-draft on mount.
  it('does NOT increment the counter when opening from a closed state with addNew=true', () => {
    const { getState } = buildSlice();
    expect(getState().boardManagerOpen).toBe(false);
    getState().openBoardManager(null, true);
    expect(getState().boardManagerAddDraftRequest).toBe(0);
  });

  it('does NOT increment the counter when opening from a closed state with addNew=false', () => {
    const { getState } = buildSlice();
    getState().openBoardManager('lane-1', false);
    expect(getState().boardManagerAddDraftRequest).toBe(0);
  });

  // ── Counter invariant: open → re-open with addNew=true ──────────────────
  // Once the dialog is mounted (boardManagerOpen=true), each subsequent call
  // with addNew=true increments by exactly 1 so the dialog's useEffect fires.
  it('increments the counter by exactly 1 when re-opening while already open with addNew=true', () => {
    const { getState } = buildSlice();
    // First open (closed → open) - counter stays 0
    getState().openBoardManager(null, true);
    expect(getState().boardManagerAddDraftRequest).toBe(0);

    // Second call while open (open → addNew) - counter becomes 1
    getState().openBoardManager(null, true);
    expect(getState().boardManagerAddDraftRequest).toBe(1);
  });

  it('increments cumulatively on each subsequent addNew call while open', () => {
    const { getState } = buildSlice();
    getState().openBoardManager(null, true); // closed → open, stays 0
    getState().openBoardManager(null, true); // increment → 1
    getState().openBoardManager(null, true); // increment → 2
    getState().openBoardManager(null, true); // increment → 3
    expect(getState().boardManagerAddDraftRequest).toBe(3);
  });

  it('does NOT increment when re-opening while open with addNew=false', () => {
    const { getState } = buildSlice();
    getState().openBoardManager(null, true); // closed → open
    getState().openBoardManager('lane-1', false); // navigate to a column, no addNew
    expect(getState().boardManagerAddDraftRequest).toBe(0);
  });
});

describe('closeBoardManager', () => {
  it('sets boardManagerOpen to false', () => {
    const { getState } = buildSlice();
    getState().openBoardManager('lane-1');
    getState().closeBoardManager();
    expect(getState().boardManagerOpen).toBe(false);
  });

  it('resets boardManagerInitialId to null', () => {
    const { getState } = buildSlice();
    getState().openBoardManager('lane-xyz');
    getState().closeBoardManager();
    expect(getState().boardManagerInitialId).toBeNull();
  });

  it('resets boardManagerSeedNew to false', () => {
    const { getState } = buildSlice();
    getState().openBoardManager(null, true);
    getState().closeBoardManager();
    expect(getState().boardManagerSeedNew).toBe(false);
  });

  it('leaves boardManagerAddDraftRequest UNCHANGED after close', () => {
    const { getState } = buildSlice();
    // Open, add two extra drafts while open, close
    getState().openBoardManager(null, true); // counter stays 0
    getState().openBoardManager(null, true); // counter → 1
    getState().openBoardManager(null, true); // counter → 2
    getState().closeBoardManager();
    // Counter must survive close so we can detect further increments next open
    expect(getState().boardManagerAddDraftRequest).toBe(2);
  });

  it('counter continues incrementing correctly after a close-and-reopen cycle', () => {
    const { getState } = buildSlice();
    // Cycle 1
    getState().openBoardManager(null, true); // closed → open, counter = 0
    getState().openBoardManager(null, true); // counter = 1
    getState().closeBoardManager();          // counter stays 1, open = false

    // Cycle 2: re-opening from closed does not increment
    getState().openBoardManager(null, true); // closed → open, counter stays 1
    expect(getState().boardManagerAddDraftRequest).toBe(1);

    // But a subsequent open-while-open does
    getState().openBoardManager(null, true); // counter → 2
    expect(getState().boardManagerAddDraftRequest).toBe(2);
  });
});
