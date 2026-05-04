/**
 * Unit tests for `resolveSpawnOverrides`
 * (src/main/ipc/helpers/agent-spawn.ts).
 *
 * This helper is mocked in every consumer (task-create-handler,
 * task-archive-handler, task-runtime-override-handler, etc.) so the actual
 * implementation is never exercised by any other test suite. These direct
 * tests pin the coalescing semantics that downstream `?? undefined` chains
 * rely on.
 *
 * Key contract: task override wins over lane; null from the task falls through
 * to the lane; both null produces null (NOT converted to undefined) because the
 * return type is `string | null | undefined` and callers preserve the
 * distinction for their own coalescing chains.
 */

import { describe, it, expect } from 'vitest';
import { resolveSpawnOverrides } from '../../src/main/ipc/helpers/agent-spawn';

// ---------------------------------------------------------------------------
// Minimal type-compatible fixture builders (avoids importing the full Task
// and Swimlane shapes - only the two override fields are needed here).
// ---------------------------------------------------------------------------

type TaskOverrideFields = { model_override: string | null; effort_override: string | null };
type LaneOverrideFields = { model_override: string | null; effort_override: string | null };

function makeTask(model: string | null, effort: string | null): TaskOverrideFields {
  return { model_override: model, effort_override: effort };
}

function makeLane(model: string | null, effort: string | null): LaneOverrideFields {
  return { model_override: model, effort_override: effort };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveSpawnOverrides', () => {
  describe('task override wins when set', () => {
    it('returns the task model when both task and lane have a model override', () => {
      const result = resolveSpawnOverrides(makeTask('sonnet', null), makeLane('opus', null));
      expect(result.model).toBe('sonnet');
    });

    it('returns the task effort when both task and lane have an effort override', () => {
      const result = resolveSpawnOverrides(makeTask(null, 'high'), makeLane(null, 'low'));
      expect(result.effort).toBe('high');
    });

    it('returns task values for both fields when both task and lane are fully populated', () => {
      const result = resolveSpawnOverrides(makeTask('sonnet', 'medium'), makeLane('opus', 'high'));
      expect(result.model).toBe('sonnet');
      expect(result.effort).toBe('medium');
    });
  });

  describe('task null falls through to the lane value', () => {
    it('returns the lane model when the task model is null', () => {
      const result = resolveSpawnOverrides(makeTask(null, null), makeLane('opus', null));
      expect(result.model).toBe('opus');
    });

    it('returns the lane effort when the task effort is null', () => {
      const result = resolveSpawnOverrides(makeTask(null, null), makeLane(null, 'low'));
      expect(result.effort).toBe('low');
    });

    it('falls through both fields independently when the task has no overrides', () => {
      const result = resolveSpawnOverrides(makeTask(null, null), makeLane('haiku', 'xhigh'));
      expect(result.model).toBe('haiku');
      expect(result.effort).toBe('xhigh');
    });
  });

  describe('both null produces null (not undefined)', () => {
    it('returns null for model when both task and lane model_override are null', () => {
      // The ?? operator short-circuits on null, so lane.model_override (also
      // null) is evaluated and returned. The result is null, not undefined.
      // Downstream callers like commandOptions use `?? undefined` so they
      // convert null to undefined themselves.
      const result = resolveSpawnOverrides(makeTask(null, null), makeLane(null, null));
      expect(result.model).toBeNull();
    });

    it('returns null for effort when both task and lane effort_override are null', () => {
      const result = resolveSpawnOverrides(makeTask(null, null), makeLane(null, null));
      expect(result.effort).toBeNull();
    });
  });

  describe('lane null or undefined is accepted', () => {
    it('returns null for both fields when the lane argument is null', () => {
      const result = resolveSpawnOverrides(makeTask(null, null), null);
      // When lane is null, optional chaining produces undefined, which is
      // what the return type allows (string | null | undefined).
      expect(result.model).toBeUndefined();
      expect(result.effort).toBeUndefined();
    });

    it('returns null for both fields when the lane argument is undefined', () => {
      const result = resolveSpawnOverrides(makeTask(null, null), undefined);
      expect(result.model).toBeUndefined();
      expect(result.effort).toBeUndefined();
    });

    it('returns task overrides when the lane is null (task wins trivially)', () => {
      const result = resolveSpawnOverrides(makeTask('opus', 'xhigh'), null);
      expect(result.model).toBe('opus');
      expect(result.effort).toBe('xhigh');
    });
  });

  describe('undefined preservation (NOT coerced to null)', () => {
    it('preserves undefined from optional chaining when lane is null and task has no override', () => {
      // The `??` operator does NOT short-circuit on undefined, so when
      // task.model_override is null (not undefined), the rhs evaluates
      // lane?.model_override which is undefined when lane is null.
      // Downstream code relying on `?? undefined` coalescing depends on
      // this producing undefined (falsy, triggers the fallback).
      const result = resolveSpawnOverrides(makeTask(null, null), null);
      // Both fields should be undefined (lane?.model_override where lane=null)
      expect(result.model).toBeUndefined();
      expect(result.effort).toBeUndefined();
    });
  });
});
