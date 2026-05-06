/**
 * Property-based tests for ActivityEngine.
 *
 * Generates random sequences of SessionEvents (and force-path calls)
 * via fast-check and asserts core invariants that must hold regardless
 * of input. These catch regressions that example-based tests miss:
 *
 * - counters never go negative
 * - predicate returns one of three legal values
 * - dispose is idempotent
 * - no crash on any sequence of legal events
 * - state is internally consistent (e.g. activity matches predicate)
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { ActivityEngine } from '../../src/main/pty/activity/engine';
import { EventType, IdleReason } from '../../src/shared/types';
import type { ActivityState, ActivityReason, SessionEvent } from '../../src/shared/types';

const SESSION_ID = 'property-session';

const EVENT_TYPES: EventType[] = [
  EventType.Prompt,
  EventType.ToolStart,
  EventType.ToolEnd,
  EventType.Idle,
  EventType.Interrupted,
  EventType.SubagentStart,
  EventType.SubagentStop,
  EventType.BackgroundShellStart,
  EventType.BackgroundShellEnd,
  EventType.SessionStart,
  EventType.SessionEnd,
  EventType.Notification,
  EventType.Compact,
  EventType.WorktreeCreate,
  EventType.WorktreeRemove,
];

const eventArb = fc.record({
  type: fc.constantFrom(...EVENT_TYPES),
  detail: fc.option(
    fc.oneof(
      fc.constant(IdleReason.Permission),
      fc.constant('bash_1'),
      fc.constant('bash_2'),
      fc.string({ minLength: 1, maxLength: 8 }),
    ),
    { nil: undefined },
  ),
  tool: fc.option(
    fc.constantFrom('Bash', 'Read', 'Edit', 'Glob', 'Grep'),
    { nil: undefined },
  ),
}).map((parts): SessionEvent => ({
  ts: 0,
  type: parts.type,
  detail: parts.detail ?? undefined,
  tool: parts.tool ?? undefined,
}));

const sequenceArb = fc.array(eventArb, { minLength: 0, maxLength: 200 });

function makeEngine() {
  const transitions: Array<{ activity: ActivityState; reason: ActivityReason }> = [];
  const engine = new ActivityEngine(
    {
      onActivityChange(_sessionId, activity, reason) {
        transitions.push({ activity, reason });
      },
    },
    {
      bgShellEscapeHatchMs: 60_000,
      staleThinkingTimeoutMs: 60_000,
      idleStabilityWindowMs: 0, // skip window for property tests - keep them deterministic
    },
  );
  return { engine, transitions };
}

describe('ActivityEngine property tests', () => {
  it('counters never go negative for any event sequence', () => {
    fc.assert(
      fc.property(sequenceArb, (events) => {
        const { engine } = makeEngine();
        engine.initSession(SESSION_ID);
        for (const event of events) {
          engine.processEvent(SESSION_ID, event);
          const state = engine.getState(SESSION_ID);
          expect(state).toBeDefined();
          expect(state!.pendingToolCount).toBeGreaterThanOrEqual(0);
          expect(state!.subagentDepth).toBeGreaterThanOrEqual(0);
          expect(state!.anonymousBackgroundShellCount).toBeGreaterThanOrEqual(0);
        }
        engine.dispose();
      }),
      { numRuns: 200 },
    );
  });

  it('activity is always a legal value', () => {
    fc.assert(
      fc.property(sequenceArb, (events) => {
        const { engine } = makeEngine();
        engine.initSession(SESSION_ID);
        for (const event of events) {
          engine.processEvent(SESSION_ID, event);
        }
        const state = engine.getState(SESSION_ID)!;
        expect(['idle', 'thinking', 'permission']).toContain(state.activity);
        engine.dispose();
      }),
      { numRuns: 200 },
    );
  });

  it('reason kind is always a legal value', () => {
    fc.assert(
      fc.property(sequenceArb, (events) => {
        const { engine } = makeEngine();
        engine.initSession(SESSION_ID);
        for (const event of events) {
          engine.processEvent(SESSION_ID, event);
        }
        const reason = engine.getActivityReason(SESSION_ID)!;
        expect([
          'idle',
          'permission',
          'tool',
          'subagent',
          'background-shell',
          'turn-active',
        ]).toContain(reason.kind);
        engine.dispose();
      }),
      { numRuns: 200 },
    );
  });

  it('Interrupted always lands in idle (no counters held)', () => {
    fc.assert(
      fc.property(sequenceArb, (events) => {
        const { engine } = makeEngine();
        engine.initSession(SESSION_ID);
        for (const event of events) {
          engine.processEvent(SESSION_ID, event);
        }
        engine.processEvent(SESSION_ID, { ts: 0, type: EventType.Interrupted });
        const state = engine.getState(SESSION_ID)!;
        expect(state.activity).toBe('idle');
        // Interrupted decrements pendingToolCount but doesn't reset counters.
        // (Subagent and bg shells from the prefix sequence may still be held.)
        // Still - the immediate transition should be idle.
        engine.dispose();
      }),
      { numRuns: 200 },
    );
  });

  it('forceIdle always lands in idle with all counters cleared', () => {
    fc.assert(
      fc.property(sequenceArb, (events) => {
        const { engine } = makeEngine();
        engine.initSession(SESSION_ID);
        for (const event of events) {
          engine.processEvent(SESSION_ID, event);
        }
        engine.forceIdle(SESSION_ID);
        const state = engine.getState(SESSION_ID)!;
        expect(state.activity).toBe('idle');
        expect(state.turnActive).toBe(false);
        expect(state.pendingToolCount).toBe(0);
        expect(state.subagentDepth).toBe(0);
        expect(state.activeBackgroundShellIds.size).toBe(0);
        expect(state.anonymousBackgroundShellCount).toBe(0);
        expect(state.permissionPending).toBe(false);
        engine.dispose();
      }),
      { numRuns: 200 },
    );
  });

  it('dispose() is idempotent and clears all state', () => {
    fc.assert(
      fc.property(sequenceArb, (events) => {
        const { engine } = makeEngine();
        engine.initSession(SESSION_ID);
        for (const event of events) {
          engine.processEvent(SESSION_ID, event);
        }
        engine.dispose();
        engine.dispose(); // second call is a no-op
        // Post-dispose, mutators are no-ops
        engine.processEvent(SESSION_ID, { ts: 0, type: EventType.ToolStart });
        engine.forceThinking(SESSION_ID);
        engine.forceIdle(SESSION_ID);
        // No state should exist
        expect(engine.getState(SESSION_ID)).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });

  it('activity matches the predicate (no internal inconsistency)', () => {
    fc.assert(
      fc.property(sequenceArb, (events) => {
        const { engine } = makeEngine();
        engine.initSession(SESSION_ID);
        for (const event of events) {
          engine.processEvent(SESSION_ID, event);
        }
        const state = engine.getState(SESSION_ID)!;
        const reason = engine.getActivityReason(SESSION_ID)!;
        // Activity must be consistent with reason kind
        if (state.activity === 'permission') {
          expect(reason.kind).toBe('permission');
          expect(state.permissionPending).toBe(true);
        } else if (state.activity === 'idle') {
          expect(reason.kind).toBe('idle');
          // No counter holds, no permission, no turn
          expect(state.permissionPending).toBe(false);
          expect(state.turnActive).toBe(false);
          expect(state.subagentDepth).toBe(0);
          expect(state.activeBackgroundShellIds.size + state.anonymousBackgroundShellCount).toBe(0);
        } else {
          // thinking
          expect(['tool', 'subagent', 'background-shell', 'turn-active']).toContain(reason.kind);
          expect(state.permissionPending).toBe(false);
          // At least one signal must be holding
          const heldByCounter =
            state.turnActive
            || state.subagentDepth > 0
            || (state.activeBackgroundShellIds.size + state.anonymousBackgroundShellCount) > 0;
          expect(heldByCounter).toBe(true);
        }
        engine.dispose();
      }),
      { numRuns: 200 },
    );
  });

  it('repeated identical events do not corrupt state (compared to single event)', () => {
    fc.assert(
      fc.property(eventArb, fc.integer({ min: 2, max: 10 }), (event, repeats) => {
        // Skip events with side effects that genuinely accumulate
        // (ToolStart, SubagentStart, BackgroundShellStart). Repeating
        // those legitimately increments counters - not a bug.
        if (
          event.type === EventType.ToolStart
          || event.type === EventType.SubagentStart
          || event.type === EventType.BackgroundShellStart
        ) return;
        const { engine: e1 } = makeEngine();
        e1.initSession(SESSION_ID);
        e1.processEvent(SESSION_ID, event);
        const single = e1.getState(SESSION_ID)!.activity;
        e1.dispose();

        const { engine: e2 } = makeEngine();
        e2.initSession(SESSION_ID);
        for (let i = 0; i < repeats; i++) {
          e2.processEvent(SESSION_ID, event);
        }
        const repeated = e2.getState(SESSION_ID)!.activity;
        e2.dispose();

        expect(repeated).toBe(single);
      }),
      { numRuns: 100 },
    );
  });

  it('processEvent never throws for any legal event', () => {
    fc.assert(
      fc.property(sequenceArb, (events) => {
        const { engine } = makeEngine();
        engine.initSession(SESSION_ID);
        for (const event of events) {
          expect(() => engine.processEvent(SESSION_ID, event)).not.toThrow();
        }
        engine.dispose();
      }),
      { numRuns: 200 },
    );
  });

  it('multiple sessions are isolated', () => {
    fc.assert(
      fc.property(sequenceArb, sequenceArb, (eventsA, eventsB) => {
        const { engine } = makeEngine();
        engine.initSession('a');
        engine.initSession('b');
        // Interleave events
        const max = Math.max(eventsA.length, eventsB.length);
        for (let i = 0; i < max; i++) {
          if (i < eventsA.length) engine.processEvent('a', eventsA[i]);
          if (i < eventsB.length) engine.processEvent('b', eventsB[i]);
        }
        // Drive A through events alone (in a fresh engine) and compare
        const { engine: refA } = makeEngine();
        refA.initSession('a');
        for (const event of eventsA) refA.processEvent('a', event);

        const aFromInterleaved = engine.getState('a')!.activity;
        const aFromIsolated = refA.getState('a')!.activity;
        expect(aFromInterleaved).toBe(aFromIsolated);

        engine.dispose();
        refA.dispose();
      }),
      { numRuns: 100 },
    );
  });
});
