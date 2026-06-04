import { describe, it, expect } from 'vitest';
import {
  resolveSessionStrategy,
  resolveIsolatedSwimlaneId,
} from '../../src/main/engine/session-isolation';
import type { Swimlane } from '../../src/shared/types';

/** Minimal swimlane stub - only the isolation-relevant fields matter here. */
function lane(overrides: Partial<Swimlane>): Pick<Swimlane, 'id' | 'session_strategy'> {
  return {
    id: 'lane-1',
    session_strategy: 'main',
    ...overrides,
  };
}

describe('resolveSessionStrategy', () => {
  it('defaults to main for null/undefined lanes (legacy columns)', () => {
    expect(resolveSessionStrategy(null)).toBe('main');
    expect(resolveSessionStrategy(undefined)).toBe('main');
  });

  it('passes through each strategy value', () => {
    expect(resolveSessionStrategy(lane({ session_strategy: 'main' }))).toBe('main');
    expect(resolveSessionStrategy(lane({ session_strategy: 'isolated' }))).toBe('isolated');
  });
});

describe('resolveIsolatedSwimlaneId', () => {
  it('returns null (main session) for normal (non-isolated) columns', () => {
    expect(resolveIsolatedSwimlaneId(lane({ session_strategy: 'main' }))).toBeNull();
    expect(resolveIsolatedSwimlaneId(null)).toBeNull();
    expect(resolveIsolatedSwimlaneId(undefined)).toBeNull();
  });

  it('returns the swimlane id for an isolated column', () => {
    expect(resolveIsolatedSwimlaneId(lane({ id: 'review-col', session_strategy: 'isolated' }))).toBe('review-col');
  });

  it('is stable across calls for the same lane (re-entry resumes the same session)', () => {
    const isolatedLane = lane({ id: 'review-col', session_strategy: 'isolated' });
    expect(resolveIsolatedSwimlaneId(isolatedLane)).toBe(resolveIsolatedSwimlaneId(isolatedLane));
  });

  it('keeps two different isolated columns separate', () => {
    const a = resolveIsolatedSwimlaneId(lane({ id: 'review-col', session_strategy: 'isolated' }));
    const b = resolveIsolatedSwimlaneId(lane({ id: 'qa-col', session_strategy: 'isolated' }));
    expect(a).not.toBe(b);
  });
});
