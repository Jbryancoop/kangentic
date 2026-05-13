/**
 * Unit tests for src/renderer/utils/hmr-generation.ts.
 *
 * The module exports two public symbols:
 *   - bumpHmrGeneration() -- increments the generation counter and notifies
 *     all subscribed listeners.
 *   - useHmrGeneration()  -- React hook that calls useSyncExternalStore with
 *     the internal subscribe / getSnapshot functions.
 *
 * Testing strategy:
 *
 * `useHmrGeneration` delegates to useSyncExternalStore, which is a React
 * runtime concept that cannot be called outside a React render cycle in the
 * vitest node environment (no jsdom, no @testing-library/react in the vitest
 * config). Instead we intercept useSyncExternalStore via vi.mock('react') and
 * capture the subscribe/getSnapshot functions that the module passes to it.
 * This lets us exercise the subscribe/notify contract without a browser or DOM.
 *
 * Import.meta.hot is undefined in vitest node mode (no Vite HMR runtime).
 * The module handles this via `?? 0` fallback on the initializer and an
 * `if (import.meta.hot)` guard on the dispose block, so the module loads
 * cleanly. Each describe block uses vi.resetModules() + dynamic import to get
 * a fresh, zero-initialized module instance.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Capture the subscribe/getSnapshot functions that the module registers with
// useSyncExternalStore. We do this via a hoisted mock so the factory runs
// before the module graph is resolved.
// ---------------------------------------------------------------------------

type SubscribeFn = (listener: () => void) => () => void;
type GetSnapshotFn = () => number;

const capturedSubscribe = { current: null as SubscribeFn | null };
const capturedGetSnapshot = { current: null as GetSnapshotFn | null };

vi.mock('react', () => ({
  useSyncExternalStore: (
    subscribe: SubscribeFn,
    getSnapshot: GetSnapshotFn,
  ): number => {
    // Capture for direct invocation in tests.
    capturedSubscribe.current = subscribe;
    capturedGetSnapshot.current = getSnapshot;
    // Return the snapshot so useHmrGeneration() itself returns the right value
    // if a test calls it directly.
    return getSnapshot();
  },
}));

describe('hmr-generation module', () => {
  // Import lazily so each describe gets a fresh module after resetModules.
  let bumpHmrGeneration: () => void;
  let useHmrGeneration: () => number;

  beforeEach(async () => {
    vi.resetModules();
    capturedSubscribe.current = null;
    capturedGetSnapshot.current = null;

    const module = await import('../../src/renderer/utils/hmr-generation');
    bumpHmrGeneration = module.bumpHmrGeneration;
    useHmrGeneration = module.useHmrGeneration;

    // Calling useHmrGeneration populates capturedSubscribe/capturedGetSnapshot.
    useHmrGeneration();
  });

  // Contract 1: fresh module starts at generation 0.
  it('getSnapshot returns 0 on a fresh module load (production-equivalent: no import.meta.hot)', () => {
    expect(capturedGetSnapshot.current!()).toBe(0);
  });

  // Contract 1b: useHmrGeneration() itself returns 0 on fresh load.
  it('useHmrGeneration() returns 0 on initial call', () => {
    expect(useHmrGeneration()).toBe(0);
  });

  // Contract 2: bumpHmrGeneration increments the generation counter.
  it('bumpHmrGeneration() increments generation by 1 each call', () => {
    bumpHmrGeneration();
    expect(capturedGetSnapshot.current!()).toBe(1);
    bumpHmrGeneration();
    expect(capturedGetSnapshot.current!()).toBe(2);
  });

  // Contract 2b: useHmrGeneration() reflects the bumped value.
  it('useHmrGeneration() reflects the value after bumpHmrGeneration()', () => {
    bumpHmrGeneration();
    expect(useHmrGeneration()).toBe(1);
  });

  // Contract 3: subscribe returns an unsubscribe function; after unsubscribe
  // a subsequent bump does NOT call the removed listener.
  it('subscribe() returns an unsubscribe fn; unsubscribed listener is not called on bump', () => {
    const listener = vi.fn();
    const unsubscribe = capturedSubscribe.current!(listener);

    // Listener fires on the first bump.
    bumpHmrGeneration();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();

    // Listener must NOT fire after unsubscribe.
    bumpHmrGeneration();
    expect(listener).toHaveBeenCalledTimes(1); // still 1
  });

  // Contract 4: multiple subscribers all get notified on a single bump.
  it('all subscribed listeners are notified on a single bumpHmrGeneration() call', () => {
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    const listenerC = vi.fn();

    capturedSubscribe.current!(listenerA);
    capturedSubscribe.current!(listenerB);
    capturedSubscribe.current!(listenerC);

    bumpHmrGeneration();

    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(listenerB).toHaveBeenCalledTimes(1);
    expect(listenerC).toHaveBeenCalledTimes(1);
  });

  // Contract 5: subscribing the same listener twice only adds it once (Set semantics).
  it('subscribing the same listener reference twice does not double-notify', () => {
    const listener = vi.fn();
    capturedSubscribe.current!(listener);
    capturedSubscribe.current!(listener); // second subscription - same reference

    bumpHmrGeneration();
    expect(listener).toHaveBeenCalledTimes(1); // Set deduplication
  });

  // Regression: a mix of subscribe/unsubscribe leaves the remaining listeners intact.
  it('unsubscribing one listener does not affect other subscribed listeners', () => {
    const listenerA = vi.fn();
    const listenerB = vi.fn();

    const unsubscribeA = capturedSubscribe.current!(listenerA);
    capturedSubscribe.current!(listenerB);

    unsubscribeA();
    bumpHmrGeneration();

    expect(listenerA).not.toHaveBeenCalled();
    expect(listenerB).toHaveBeenCalledTimes(1);
  });
});
