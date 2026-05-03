import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { UsageTracker } from '../../src/main/pty/activity/usage-tracker';
import { EventType } from '../../src/shared/types';
import type { ActivityState, SessionEvent } from '../../src/shared/types';

/**
 * Stale-deferral watchdog regression guard for the background-shell
 * "spinner stuck thinking" bug.
 *
 * The state machine's Guard 3 (`deferStopUntilBackgroundShellsFinish`)
 * suspends the Stop-driven idle while `activeBackgroundShells > 0`.
 * Claude Code does not fire a hook for natural completion of a
 * `run_in_background: true` Bash, so without an escape hatch the
 * counter stays positive forever once a single bg shell exits without
 * being explicitly KillBash'd.
 *
 * The watchdog in `usage-tracker.ts:checkStaleThinking` fires after
 * `BG_SHELL_DEFER_TIMEOUT_MS` (10 minutes) of pendingIdleWhileBackgroundShell
 * being set (measured from `deferredIdleAt`, NOT `lastThinkingSignal`,
 * because the latter is reset by every event arrival and would never
 * trip).
 *
 * These tests use Vitest fake timers to advance wall-clock time so the
 * 10-minute threshold can be exercised without real waiting.
 */

const SESSION_ID = 'bg-shell-watchdog-session';

function makeEvent(type: EventType, detail?: string): SessionEvent {
  return { ts: Date.now(), type, detail };
}

interface TransitionRecord {
  activity: ActivityState;
  permissionIdle: boolean;
}

function makeTracker(): {
  tracker: UsageTracker;
  transitions: TransitionRecord[];
  events: SessionEvent[];
} {
  const transitions: TransitionRecord[] = [];
  const events: SessionEvent[] = [];
  const tracker = new UsageTracker({
    onUsageChange: () => {},
    onActivityChange: (_sessionId, activity, permissionIdle) => {
      transitions.push({ activity, permissionIdle });
    },
    onEvent: (_sessionId, event) => {
      events.push(event);
    },
    onIdleTimeout: () => {},
    onPlanExit: () => {},
    onPRCandidate: () => {},
    requestSuspend: () => {},
    isSessionRunning: () => true,
  });
  tracker.initSession(SESSION_ID);
  return { tracker, transitions, events };
}

describe('Background-shell deferral watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('releases the deferred idle ~10 minutes after Guard 3 deferred it', () => {
    const { tracker, transitions, events } = makeTracker();
    transitions.length = 0;
    events.length = 0;

    // Simulate the empirical 1d40a1ef session: bg_shell_start, then Stop.
    // Guard 3 defers the idle; activity stays thinking.
    tracker.ingestEvents(SESSION_ID, [
      makeEvent(EventType.Prompt),
      { ts: Date.now(), type: EventType.BackgroundShellStart, tool: 'Bash' },
      makeEvent(EventType.Idle),
    ]);

    // Sanity: Guard 3 did its job.
    const stateAfterDefer = tracker.activityStateMachine.getState(SESSION_ID);
    expect(stateAfterDefer?.activity).toBe('thinking');
    expect(stateAfterDefer?.activeBackgroundShells).toBe(1);
    expect(stateAfterDefer?.pendingIdleWhileBackgroundShell).toBe(true);
    expect(stateAfterDefer?.deferredIdleAt).not.toBe(null);

    // Advance 9 minutes. Threshold is 10 minutes -- every watchdog tick
    // during this window finds the deferral is still within budget and
    // skips release.
    vi.advanceTimersByTime(9 * 60_000);
    const stateUnderThreshold = tracker.activityStateMachine.getState(SESSION_ID);
    expect(stateUnderThreshold?.activity).toBe('thinking');
    expect(stateUnderThreshold?.pendingIdleWhileBackgroundShell).toBe(true);
    expect(stateUnderThreshold?.activeBackgroundShells).toBe(1);

    // Advance past the threshold. Next watchdog tick fires the escape hatch.
    vi.advanceTimersByTime(2 * 60_000);
    const stateAfterRelease = tracker.activityStateMachine.getState(SESSION_ID);
    expect(stateAfterRelease?.activity).toBe('idle');
    expect(stateAfterRelease?.pendingIdleWhileBackgroundShell).toBe(false);
    expect(stateAfterRelease?.activeBackgroundShells).toBe(0);
    expect(stateAfterRelease?.deferredIdleAt).toBe(null);

    // The synthetic idle event has IdleReason.Timeout detail and was
    // pushed before the activity-change callback fired.
    const lastIdleEvent = events.filter((e) => e.type === EventType.Idle).at(-1);
    expect(lastIdleEvent?.detail).toBe('timeout');
    expect(transitions.at(-1)).toMatchObject({ activity: 'idle' });
  });

  it('does NOT fire when no Guard 3 deferral is pending (regression: existing stale-thinking path)', () => {
    const { tracker, transitions } = makeTracker();
    transitions.length = 0;

    // Standard event cycle, no bg shell. Idle fires normally.
    tracker.ingestEvents(SESSION_ID, [
      makeEvent(EventType.Prompt),
      { ts: Date.now(), type: EventType.ToolStart, tool: 'Bash' },
      { ts: Date.now(), type: EventType.ToolEnd, tool: 'Bash' },
      makeEvent(EventType.Idle),
    ]);

    expect(tracker.activityStateMachine.getState(SESSION_ID)?.activity).toBe('idle');

    // Advance well past the threshold. Nothing should happen.
    vi.advanceTimersByTime(20 * 60_000);

    expect(tracker.activityStateMachine.getState(SESSION_ID)?.activity).toBe('idle');
  });

  it('does NOT fire while activity is busy with in-flight tools (counter > 0 but pending=false)', () => {
    const { tracker, transitions } = makeTracker();
    transitions.length = 0;

    // bg_shell_start without a Stop yet. activity = thinking, counter = 1,
    // but no Guard 3 deferral has happened (pendingIdleWhileBackgroundShell
    // stays false). Watchdog must not fire on this state.
    tracker.ingestEvents(SESSION_ID, [
      makeEvent(EventType.Prompt),
      { ts: Date.now(), type: EventType.BackgroundShellStart, tool: 'Bash' },
    ]);

    const initialState = tracker.activityStateMachine.getState(SESSION_ID);
    expect(initialState?.activity).toBe('thinking');
    expect(initialState?.activeBackgroundShells).toBe(1);
    expect(initialState?.pendingIdleWhileBackgroundShell).toBe(false);
    expect(initialState?.deferredIdleAt).toBe(null);

    vi.advanceTimersByTime(20 * 60_000);

    // The session should still be thinking (the existing exemption keeps
    // resetting markThinkingSignal, the new escape hatch only triggers
    // on actual deferred idles). Counter still 1.
    const finalState = tracker.activityStateMachine.getState(SESSION_ID);
    expect(finalState?.activity).toBe('thinking');
    expect(finalState?.activeBackgroundShells).toBe(1);
    expect(finalState?.pendingIdleWhileBackgroundShell).toBe(false);
  });

  it('subsequent BackgroundShellEnd before threshold prevents the watchdog from firing', () => {
    const { tracker, transitions } = makeTracker();
    transitions.length = 0;

    tracker.ingestEvents(SESSION_ID, [
      makeEvent(EventType.Prompt),
      { ts: Date.now(), type: EventType.BackgroundShellStart, tool: 'Bash' },
      makeEvent(EventType.Idle),
    ]);
    expect(tracker.activityStateMachine.getState(SESSION_ID)?.pendingIdleWhileBackgroundShell).toBe(true);

    // Within the threshold, KillBash arrives and clears the deferral
    // through the normal release path.
    vi.advanceTimersByTime(2 * 60_000);
    tracker.ingestEvents(SESSION_ID, [
      { ts: Date.now(), type: EventType.BackgroundShellEnd, tool: 'KillBash' },
    ]);

    const stateAfterKill = tracker.activityStateMachine.getState(SESSION_ID);
    expect(stateAfterKill?.activity).toBe('idle');
    expect(stateAfterKill?.pendingIdleWhileBackgroundShell).toBe(false);
    expect(stateAfterKill?.deferredIdleAt).toBe(null);

    // Advance past the original threshold. Nothing extra should fire.
    vi.advanceTimersByTime(15 * 60_000);
    expect(tracker.activityStateMachine.getState(SESSION_ID)?.activity).toBe('idle');
  });

  it('unwinds both guards when subagent is also stale at watchdog firing time', () => {
    const { tracker, transitions } = makeTracker();
    transitions.length = 0;

    // Both guards active simultaneously. Stop fires while subagent and
    // bg shell are alive. Guard 2 sets pendingIdleWhileSubagent, Guard 3
    // sets pendingIdleWhileBackgroundShell + deferredIdleAt.
    tracker.ingestEvents(SESSION_ID, [
      makeEvent(EventType.Prompt),
      { ts: Date.now(), type: EventType.SubagentStart, detail: 'general' },
      { ts: Date.now(), type: EventType.BackgroundShellStart, tool: 'Bash' },
      makeEvent(EventType.Idle),
    ]);

    const beforeAdvance = tracker.activityStateMachine.getState(SESSION_ID);
    expect(beforeAdvance?.subagentDepth).toBe(1);
    expect(beforeAdvance?.pendingIdleWhileBackgroundShell).toBe(true);
    expect(beforeAdvance?.pendingIdleWhileSubagent).toBe(true);

    // Advance past the bg-shell threshold. Watchdog escape hatch fires:
    // 10+ minutes of stale deferral means the subagent is also stuck
    // (it would have fired SubagentStop by now). Both pending flags
    // unwind and idle emits cleanly. subagentDepth itself stays as a
    // bookkeeping value -- it just isn't blocking idle anymore.
    vi.advanceTimersByTime(11 * 60_000);

    const released = tracker.activityStateMachine.getState(SESSION_ID);
    expect(released?.activity).toBe('idle');
    expect(released?.pendingIdleWhileBackgroundShell).toBe(false);
    expect(released?.activeBackgroundShells).toBe(0);
    expect(released?.deferredIdleAt).toBe(null);
    expect(released?.pendingIdleWhileSubagent).toBe(false);
    expect(transitions.at(-1)).toMatchObject({ activity: 'idle' });
  });

  it('pushEvent fires BEFORE onActivityChange when the escape hatch releases (ordering invariant)', () => {
    // Guards the pushEvent -> onActivityChange ordering in checkStaleThinking:
    // the synthetic IdleReason.Timeout event must appear in `events` BEFORE
    // the idle transition appears in `transitions`. A future refactor that
    // swaps those two calls would silently break listener semantics (e.g.
    // the renderer reading the activity log before the event that caused the
    // transition). This test pins that order via a snapshot taken inside the
    // onActivityChange closure.
    let eventCountAtTransition = -1;
    let lastEventDetailAtTransition: string | undefined = undefined;

    const events: SessionEvent[] = [];
    const transitions: TransitionRecord[] = [];
    const tracker = new UsageTracker({
      onUsageChange: () => {},
      onActivityChange: (_sessionId, activity, permissionIdle) => {
        if (activity === 'idle') {
          // Capture the events array length at the exact moment this
          // callback fires. If pushEvent ran first, events.length will
          // already include the synthetic Idle event.
          eventCountAtTransition = events.length;
          lastEventDetailAtTransition = events.at(-1)?.detail;
        }
        transitions.push({ activity, permissionIdle });
      },
      onEvent: (_sessionId, event) => {
        events.push(event);
      },
      onIdleTimeout: () => {},
      onPlanExit: () => {},
      onPRCandidate: () => {},
      requestSuspend: () => {},
      isSessionRunning: () => true,
    });
    tracker.initSession(SESSION_ID);
    transitions.length = 0;
    events.length = 0;

    // Trigger a Guard 3 deferral.
    tracker.ingestEvents(SESSION_ID, [
      makeEvent(EventType.Prompt),
      { ts: Date.now(), type: EventType.BackgroundShellStart, tool: 'Bash' },
      makeEvent(EventType.Idle),
    ]);

    // Advance past the threshold to trigger the escape hatch.
    vi.advanceTimersByTime(11 * 60_000);

    // The idle transition must have fired.
    expect(transitions.at(-1)).toMatchObject({ activity: 'idle' });

    // At the moment onActivityChange fired for the idle transition,
    // events must already have contained the synthetic Idle event.
    expect(eventCountAtTransition).toBeGreaterThan(0);
    expect(lastEventDetailAtTransition).toBe('timeout');
  });

  it('does NOT release when isSessionRunning returns false (session already torn down)', () => {
    // The checkStaleThinking escape hatch checks isSessionRunning before
    // doing anything. When the session has already been stopped/removed,
    // the gate must prevent a spurious idle release from firing into a
    // stale session record.
    const transitions: TransitionRecord[] = [];
    const tracker = new UsageTracker({
      onUsageChange: () => {},
      onActivityChange: (_sessionId, activity, permissionIdle) => {
        transitions.push({ activity, permissionIdle });
      },
      onEvent: () => {},
      onIdleTimeout: () => {},
      onPlanExit: () => {},
      onPRCandidate: () => {},
      requestSuspend: () => {},
      // Session is not running - simulates a torn-down or removed session.
      isSessionRunning: () => false,
    });
    tracker.initSession(SESSION_ID);
    transitions.length = 0;

    // Trigger a Guard 3 deferral.
    tracker.ingestEvents(SESSION_ID, [
      makeEvent(EventType.Prompt),
      { ts: Date.now(), type: EventType.BackgroundShellStart, tool: 'Bash' },
      makeEvent(EventType.Idle),
    ]);

    // Verify Guard 3 deferred the idle (sanity check).
    const stateAfterDefer = tracker.activityStateMachine.getState(SESSION_ID);
    expect(stateAfterDefer?.pendingIdleWhileBackgroundShell).toBe(true);
    expect(stateAfterDefer?.deferredIdleAt).not.toBe(null);
    expect(stateAfterDefer?.activity).toBe('thinking');

    // Record the transition count before advancing timers.
    const transitionsBeforeAdvance = transitions.length;

    // Advance well past the 10-minute threshold. The watchdog fires but
    // isSessionRunning() returns false, so the escape hatch must skip
    // the release entirely.
    vi.advanceTimersByTime(15 * 60_000);

    // State must remain unchanged: still thinking, deferred flag still set.
    const stateAfterAdvance = tracker.activityStateMachine.getState(SESSION_ID);
    expect(stateAfterAdvance?.activity).toBe('thinking');
    expect(stateAfterAdvance?.pendingIdleWhileBackgroundShell).toBe(true);
    expect(stateAfterAdvance?.deferredIdleAt).not.toBe(null);

    // No new transition should have fired.
    expect(transitions.length).toBe(transitionsBeforeAdvance);
  });

  it('releaseDeferredBackgroundIdle is a no-op transition when activity is already idle', () => {
    // The method has a defensive `if (state.activity !== 'idle')` guard
    // inside. This test exercises the branch where pendingIdleWhileBackgroundShell
    // is true but the state machine was already forced to idle via a separate
    // path (e.g. stale-thinking forceIdle ran before the watchdog escape
    // hatch). The method should still clear the bookkeeping flags (returns
    // true) but must NOT fire a second onActivityChange transition.
    const { tracker, transitions } = makeTracker();
    transitions.length = 0;

    // Trigger Guard 3 deferral: activity = thinking, pending flag set.
    tracker.ingestEvents(SESSION_ID, [
      makeEvent(EventType.Prompt),
      { ts: Date.now(), type: EventType.BackgroundShellStart, tool: 'Bash' },
      makeEvent(EventType.Idle),
    ]);
    expect(tracker.activityStateMachine.getState(SESSION_ID)?.activity).toBe('thinking');
    expect(tracker.activityStateMachine.getState(SESSION_ID)?.pendingIdleWhileBackgroundShell).toBe(true);

    // Force the state machine to idle via a separate path (simulates the
    // stale-thinking watchdog's forceIdle running before the escape hatch).
    // forceIdle does NOT clear pendingIdleWhileBackgroundShell, leaving the
    // flags in a partially-cleared state.
    tracker.activityStateMachine.forceIdle(SESSION_ID);
    expect(tracker.activityStateMachine.getState(SESSION_ID)?.activity).toBe('idle');
    expect(tracker.activityStateMachine.getState(SESSION_ID)?.pendingIdleWhileBackgroundShell).toBe(true);

    const transitionsBeforeRelease = transitions.length;

    // Now call releaseDeferredBackgroundIdle. The method should clear the
    // bookkeeping flags (returns true) but must NOT fire a new transition
    // since the activity is already idle.
    const released = tracker.activityStateMachine.releaseDeferredBackgroundIdle(SESSION_ID);
    expect(released).toBe(true);

    // Flags must be cleared.
    const stateAfterRelease = tracker.activityStateMachine.getState(SESSION_ID);
    expect(stateAfterRelease?.pendingIdleWhileBackgroundShell).toBe(false);
    expect(stateAfterRelease?.deferredIdleAt).toBe(null);
    expect(stateAfterRelease?.activeBackgroundShells).toBe(0);

    // Activity is still idle.
    expect(stateAfterRelease?.activity).toBe('idle');

    // No NEW transition fired - the count is unchanged.
    expect(transitions.length).toBe(transitionsBeforeRelease);
  });
});
