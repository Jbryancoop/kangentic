/**
 * Regression guard for the background-shell false-idle bug.
 *
 * Bug (now fixed): when a Claude Code agent launches a backgrounded
 * Bash (Bash tool with run_in_background: true), the agent receives
 * the handle back immediately and typically yields its turn shortly
 * after. Claude Code then fires:
 *
 *   PreToolUse (Bash + run_in_background) -> background_shell_start
 *   PostToolUse                            -> tool_end
 *   Stop                                   -> idle
 *
 * Before the fix, the state machine transitioned straight to 'idle'
 * because pendingToolCount returned to zero and Idle was the terminal
 * event. Confirmed in the wild on task #503 (session e426341b-...):
 * events.jsonl had idle at ts=17617675411 while `npx playwright test`
 * was still running in a backgrounded shell.
 *
 * Fix: a new `background_shell_start` event increments the session's
 * activeBackgroundShells counter, and Guard 3 defers any Stop-driven
 * idle while that counter is > 0. When the last bg shell is explicitly
 * killed via KillBash (`background_shell_end` drops the counter to
 * zero), the deferred idle emits. Natural completion of a bg shell is
 * not tracked (no hook fires for it), so the counter over-estimates,
 * which errs on the safe side: the session keeps showing as thinking
 * while work might still be happening.
 *
 * Tests in this file pin:
 *   1. The Idle event is deferred while a bg shell is active.
 *   2. A subsequent BackgroundShellEnd emits the deferred idle.
 *   3. SessionEnd resets the counter so the next session starts clean.
 *   4. Interrupts bypass the guard (user needs to see them immediately).
 *
 * Companion E2E reproduction + fix-gate lives in
 * tests/e2e/background-shell-idle.spec.ts.
 */
import { describe, it, expect } from 'vitest';
import { ActivityStateMachine } from '../../src/main/pty/activity/activity-state-machine';
import { EventType, IdleReason } from '../../src/shared/types';
import type { ActivityState, SessionEvent } from '../../src/shared/types';

type TransitionLog = Array<{
  sessionId: string;
  activity: ActivityState;
  permissionIdle: boolean;
}>;

function makeMachine(): { machine: ActivityStateMachine; transitions: TransitionLog } {
  const transitions: TransitionLog = [];
  const machine = new ActivityStateMachine({
    onActivityChange(sessionId, activity, permissionIdle) {
      transitions.push({ sessionId, activity, permissionIdle });
    },
  });
  return { machine, transitions };
}

function event(type: EventType, detail?: string): SessionEvent {
  return { ts: Date.now(), type, detail };
}

const SESSION_ID = 'bg-shell-session';

describe('Background-shell false-idle bug (Guard 3)', () => {
  it('defers the Stop-driven idle while a backgrounded Bash is active', () => {
    const { machine, transitions } = makeMachine();
    machine.initSession(SESSION_ID);
    transitions.length = 0; // drop the initial idle emission

    // Real event sequence from task #503's events.jsonl for a
    // backgrounded Bash call:
    //   prompt
    //   background_shell_start  (PreToolUse remapped by run_in_background)
    //   tool_end                (handle returned ~300ms later)
    //   idle                    (Stop hook, agent yielded)
    machine.processEvent(SESSION_ID, event(EventType.Prompt));
    machine.processEvent(SESSION_ID, {
      ts: Date.now(),
      type: EventType.BackgroundShellStart,
      tool: 'Bash',
      detail: 'npx playwright test --project=ui &',
    });
    machine.processEvent(SESSION_ID, {
      ts: Date.now(),
      type: EventType.ToolEnd,
      tool: 'Bash',
    });
    machine.processEvent(SESSION_ID, event(EventType.Idle));

    const state = machine.getState(SESSION_ID);
    // Guard 3 suppresses the Stop -> idle transition. Activity stays
    // thinking because there is still unfinished background work.
    expect(state?.activity).toBe('thinking');
    expect(state?.activeBackgroundShells).toBe(1);
    expect(state?.pendingIdleWhileBackgroundShell).toBe(true);

    // Only the initial prompt-driven thinking transition fired; idle
    // was deferred, so no second transition.
    expect(transitions).toEqual([
      { sessionId: SESSION_ID, activity: 'thinking', permissionIdle: false },
    ]);
  });

  it('emits the deferred idle when the last bg shell is killed via KillBash', () => {
    const { machine, transitions } = makeMachine();
    machine.initSession(SESSION_ID);
    transitions.length = 0;

    machine.processEvent(SESSION_ID, event(EventType.Prompt));
    machine.processEvent(SESSION_ID, {
      ts: Date.now(),
      type: EventType.BackgroundShellStart,
      tool: 'Bash',
    });
    machine.processEvent(SESSION_ID, event(EventType.Idle));
    // Guard 3 deferred idle.

    machine.processEvent(SESSION_ID, {
      ts: Date.now(),
      type: EventType.BackgroundShellEnd,
      tool: 'KillBash',
    });

    const state = machine.getState(SESSION_ID);
    expect(state?.activity).toBe('idle');
    expect(state?.activeBackgroundShells).toBe(0);
    expect(state?.pendingIdleWhileBackgroundShell).toBe(false);

    expect(transitions).toEqual([
      { sessionId: SESSION_ID, activity: 'thinking', permissionIdle: false },
      { sessionId: SESSION_ID, activity: 'idle', permissionIdle: false },
    ]);
  });

  it('interrupts bypass the guard so users see cancellation immediately', () => {
    const { machine, transitions } = makeMachine();
    machine.initSession(SESSION_ID);
    transitions.length = 0;

    machine.processEvent(SESSION_ID, event(EventType.Prompt));
    machine.processEvent(SESSION_ID, {
      ts: Date.now(),
      type: EventType.BackgroundShellStart,
      tool: 'Bash',
    });
    machine.processEvent(SESSION_ID, event(EventType.Interrupted));

    const state = machine.getState(SESSION_ID);
    // Interrupt must flip to idle regardless of bg shells.
    expect(state?.activity).toBe('idle');
    expect(transitions.at(-1)).toMatchObject({ activity: 'idle' });
  });

  it('permission idle bypasses the guard so the user can approve the prompt', () => {
    const { machine, transitions } = makeMachine();
    machine.initSession(SESSION_ID);
    transitions.length = 0;

    machine.processEvent(SESSION_ID, event(EventType.Prompt));
    machine.processEvent(SESSION_ID, {
      ts: Date.now(),
      type: EventType.BackgroundShellStart,
      tool: 'Bash',
    });
    machine.processEvent(SESSION_ID, event(EventType.Idle, IdleReason.Permission));

    const state = machine.getState(SESSION_ID);
    expect(state?.activity).toBe('idle');
    expect(state?.permissionIdle).toBe(true);
    expect(transitions.at(-1)).toMatchObject({ activity: 'idle', permissionIdle: true });
  });

  it('SessionEnd resets the counter so the next session starts clean', () => {
    const { machine } = makeMachine();
    machine.initSession(SESSION_ID);

    machine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
    machine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
    expect(machine.getState(SESSION_ID)?.activeBackgroundShells).toBe(2);

    machine.processEvent(SESSION_ID, event(EventType.SessionEnd));
    expect(machine.getState(SESSION_ID)?.activeBackgroundShells).toBe(0);
    expect(machine.getState(SESSION_ID)?.pendingIdleWhileBackgroundShell).toBe(false);
    expect(machine.getState(SESSION_ID)?.deferredIdleAt).toBe(null);
  });

  it('Guard 3 deferral stamps deferredIdleAt with the deferral timestamp', () => {
    const { machine } = makeMachine();
    machine.initSession(SESSION_ID);

    machine.processEvent(SESSION_ID, event(EventType.Prompt));
    machine.processEvent(SESSION_ID, {
      ts: Date.now(),
      type: EventType.BackgroundShellStart,
      tool: 'Bash',
    });
    expect(machine.getState(SESSION_ID)?.deferredIdleAt).toBe(null);

    // Bound assertions are intentionally inclusive (`toBeGreaterThanOrEqual`,
    // `toBeLessThanOrEqual`): on a fast machine all three Date.now() calls
    // can return the same millisecond. Do not tighten to strict inequality.
    const before = Date.now();
    machine.processEvent(SESSION_ID, event(EventType.Idle));
    const after = Date.now();

    const deferred = machine.getState(SESSION_ID)?.deferredIdleAt;
    expect(deferred).not.toBe(null);
    expect(deferred).toBeGreaterThanOrEqual(before);
    expect(deferred).toBeLessThanOrEqual(after);
  });

  it('BackgroundShellEnd clearing the counter also clears deferredIdleAt', () => {
    const { machine } = makeMachine();
    machine.initSession(SESSION_ID);

    machine.processEvent(SESSION_ID, event(EventType.Prompt));
    machine.processEvent(SESSION_ID, {
      ts: Date.now(),
      type: EventType.BackgroundShellStart,
      tool: 'Bash',
    });
    machine.processEvent(SESSION_ID, event(EventType.Idle));
    expect(machine.getState(SESSION_ID)?.deferredIdleAt).not.toBe(null);

    machine.processEvent(SESSION_ID, {
      ts: Date.now(),
      type: EventType.BackgroundShellEnd,
      tool: 'KillBash',
    });
    expect(machine.getState(SESSION_ID)?.deferredIdleAt).toBe(null);
    expect(machine.getState(SESSION_ID)?.pendingIdleWhileBackgroundShell).toBe(false);
  });

  it('releaseDeferredBackgroundIdle clears state and emits idle when no subagent is active', () => {
    const { machine, transitions } = makeMachine();
    machine.initSession(SESSION_ID);
    transitions.length = 0;

    machine.processEvent(SESSION_ID, event(EventType.Prompt));
    machine.processEvent(SESSION_ID, {
      ts: Date.now(),
      type: EventType.BackgroundShellStart,
      tool: 'Bash',
    });
    machine.processEvent(SESSION_ID, event(EventType.Idle));
    expect(machine.getState(SESSION_ID)?.activity).toBe('thinking');

    const released = machine.releaseDeferredBackgroundIdle(SESSION_ID);

    expect(released).toBe(true);
    const state = machine.getState(SESSION_ID);
    expect(state?.activity).toBe('idle');
    expect(state?.activeBackgroundShells).toBe(0);
    expect(state?.pendingIdleWhileBackgroundShell).toBe(false);
    expect(state?.deferredIdleAt).toBe(null);
    expect(transitions.at(-1)).toMatchObject({ activity: 'idle' });
  });

  it('releaseDeferredBackgroundIdle returns false and is a no-op when no Guard 3 deferral is pending', () => {
    const { machine, transitions } = makeMachine();
    machine.initSession(SESSION_ID);
    transitions.length = 0;

    // No bg shell event has fired -- nothing to release.
    const released = machine.releaseDeferredBackgroundIdle(SESSION_ID);

    expect(released).toBe(false);
    // No transition should have fired.
    expect(transitions.length).toBe(0);
  });

  it('releaseDeferredBackgroundIdle unwinds both guards when subagent is also stale (watchdog escape)', () => {
    const { machine, transitions } = makeMachine();
    machine.initSession(SESSION_ID);
    transitions.length = 0;

    // Both guards active simultaneously.
    machine.processEvent(SESSION_ID, event(EventType.Prompt));
    machine.processEvent(SESSION_ID, {
      ts: Date.now(),
      type: EventType.SubagentStart,
      detail: 'general',
    });
    machine.processEvent(SESSION_ID, {
      ts: Date.now(),
      type: EventType.BackgroundShellStart,
      tool: 'Bash',
    });
    machine.processEvent(SESSION_ID, event(EventType.Idle));

    const state = machine.getState(SESSION_ID);
    expect(state?.subagentDepth).toBe(1);
    expect(state?.pendingIdleWhileBackgroundShell).toBe(true);
    expect(state?.pendingIdleWhileSubagent).toBe(true);

    const released = machine.releaseDeferredBackgroundIdle(SESSION_ID);
    expect(released).toBe(true);

    const after = machine.getState(SESSION_ID);
    // Watchdog escape unwinds BOTH pending flags and emits idle. The
    // subagent is also stale at this point (10+ minutes deferred with no
    // SubagentStop), and the existing stale-thinking watchdog would
    // force-idle bypassing Guard 2 on the next tick anyway. Unwinding
    // here keeps the state machine consistent. subagentDepth itself is
    // not modified -- a future SubagentStop will still decrement it,
    // and any new Stop afterwards will not be deferred (counter is 0).
    expect(after?.activity).toBe('idle');
    expect(after?.activeBackgroundShells).toBe(0);
    expect(after?.pendingIdleWhileBackgroundShell).toBe(false);
    expect(after?.deferredIdleAt).toBe(null);
    expect(after?.pendingIdleWhileSubagent).toBe(false);
    expect(after?.subagentDepth).toBe(1);
    expect(transitions.at(-1)).toMatchObject({ activity: 'idle' });
  });

  it('with no bg shell, Idle transitions normally (guard does not over-fire)', () => {
    const { machine } = makeMachine();
    machine.initSession(SESSION_ID);

    machine.processEvent(SESSION_ID, event(EventType.Prompt));
    machine.processEvent(SESSION_ID, event(EventType.ToolStart));
    machine.processEvent(SESSION_ID, event(EventType.ToolEnd));
    machine.processEvent(SESSION_ID, event(EventType.Idle));

    // No bg shell was ever started -- idle should fire normally.
    expect(machine.getState(SESSION_ID)?.activity).toBe('idle');
    expect(machine.getState(SESSION_ID)?.activeBackgroundShells).toBe(0);
  });
});

describe('Guard 2 + Guard 3 composition (both guards active simultaneously)', () => {
  const COMP_SESSION = 'guard-composition-session';

  it('(a) idle deferred by BOTH guards at once: no idle emits, both pending flags set', () => {
    const { machine, transitions } = makeMachine();
    machine.initSession(COMP_SESSION);
    transitions.length = 0;

    // Start subagent and background shell at the same time.
    machine.processEvent(COMP_SESSION, event(EventType.Prompt));
    machine.processEvent(COMP_SESSION, {
      ts: Date.now(),
      type: EventType.SubagentStart,
      detail: 'general',
    });
    machine.processEvent(COMP_SESSION, {
      ts: Date.now(),
      type: EventType.BackgroundShellStart,
      tool: 'Bash',
    });
    // Stop-derived idle now arrives while both guards are active.
    machine.processEvent(COMP_SESSION, event(EventType.Idle));

    const state = machine.getState(COMP_SESSION);
    expect(state?.activity).toBe('thinking');
    expect(state?.subagentDepth).toBe(1);
    expect(state?.activeBackgroundShells).toBe(1);
    expect(state?.pendingIdleWhileSubagent).toBe(true);
    expect(state?.pendingIdleWhileBackgroundShell).toBe(true);

    // Only the initial prompt->thinking transition fired; deferred idle
    // should not have appeared.
    const idleTransitions = transitions.filter((t) => t.activity === 'idle');
    expect(idleTransitions).toHaveLength(0);
  });

  it('(b) SubagentStop fires first while bg shell still active: Guard 3 holds, no idle emitted', () => {
    const { machine, transitions } = makeMachine();
    machine.initSession(COMP_SESSION);
    transitions.length = 0;

    machine.processEvent(COMP_SESSION, event(EventType.Prompt));
    machine.processEvent(COMP_SESSION, {
      ts: Date.now(),
      type: EventType.SubagentStart,
      detail: 'general',
    });
    machine.processEvent(COMP_SESSION, {
      ts: Date.now(),
      type: EventType.BackgroundShellStart,
      tool: 'Bash',
    });
    machine.processEvent(COMP_SESSION, event(EventType.Idle));
    // Both guards have deferred the idle.

    // Subagent finishes first -- bg shell still running.
    machine.processEvent(COMP_SESSION, {
      ts: Date.now(),
      type: EventType.SubagentStop,
    });

    const state = machine.getState(COMP_SESSION);
    // Guard 3 must still hold the idle -- activity stays thinking.
    expect(state?.activity).toBe('thinking');
    expect(state?.subagentDepth).toBe(0);
    expect(state?.activeBackgroundShells).toBe(1);
    expect(state?.pendingIdleWhileSubagent).toBe(false);
    expect(state?.pendingIdleWhileBackgroundShell).toBe(true);

    const idleTransitions = transitions.filter((t) => t.activity === 'idle');
    expect(idleTransitions).toHaveLength(0);
  });

  it('(b2) SubagentStop hand-off preserves the original deferredIdleAt timestamp', async () => {
    const { machine } = makeMachine();
    machine.initSession(COMP_SESSION);

    machine.processEvent(COMP_SESSION, event(EventType.Prompt));
    machine.processEvent(COMP_SESSION, {
      ts: Date.now(),
      type: EventType.SubagentStart,
      detail: 'general',
    });
    machine.processEvent(COMP_SESSION, {
      ts: Date.now(),
      type: EventType.BackgroundShellStart,
      tool: 'Bash',
    });

    // The original Idle is deferred by BOTH guards. deferredIdleAt is set
    // to this moment. The bg-shell watchdog 10-min clock starts here.
    machine.processEvent(COMP_SESSION, event(EventType.Idle));
    const originalDeferredAt = machine.getState(COMP_SESSION)?.deferredIdleAt;
    expect(originalDeferredAt).not.toBe(null);

    // Wait at least 1ms so any subsequent Date.now() is strictly greater,
    // making the regression assertion below unambiguous on fast machines
    // where back-to-back Date.now() can return the same value.
    await new Promise((resolve) => setTimeout(resolve, 2));

    // SubagentStop fires later, while Guard 3 was already holding. The
    // hand-off MUST preserve the original deferredIdleAt -- otherwise the
    // watchdog clock resets mid-flight and recovery is delayed by however
    // long the subagent ran.
    machine.processEvent(COMP_SESSION, { ts: Date.now(), type: EventType.SubagentStop });

    const after = machine.getState(COMP_SESSION);
    expect(after?.pendingIdleWhileBackgroundShell).toBe(true);
    expect(after?.deferredIdleAt).toBe(originalDeferredAt);
  });

  it('(b3) SubagentStop hand-off DOES stamp deferredIdleAt when bg shell started during the subagent run', () => {
    // Distinguishes from (b2): here the original Idle was deferred ONLY
    // by Guard 2 (no bg shell at the time). The bg shell started later,
    // during the subagent's work, so when SubagentStop hands off, this
    // is genuinely a fresh Guard 3 deferral and the timestamp must stamp.
    const { machine } = makeMachine();
    machine.initSession(COMP_SESSION);

    machine.processEvent(COMP_SESSION, event(EventType.Prompt));
    machine.processEvent(COMP_SESSION, {
      ts: Date.now(),
      type: EventType.SubagentStart,
      detail: 'general',
    });

    // Idle deferred by Guard 2 only -- no bg shell yet.
    machine.processEvent(COMP_SESSION, event(EventType.Idle));
    expect(machine.getState(COMP_SESSION)?.pendingIdleWhileSubagent).toBe(true);
    expect(machine.getState(COMP_SESSION)?.pendingIdleWhileBackgroundShell).toBe(false);
    expect(machine.getState(COMP_SESSION)?.deferredIdleAt).toBe(null);

    // bg_shell_start fires during the subagent's run.
    machine.processEvent(COMP_SESSION, {
      ts: Date.now(),
      type: EventType.BackgroundShellStart,
      tool: 'Bash',
    });
    expect(machine.getState(COMP_SESSION)?.deferredIdleAt).toBe(null);

    // SubagentStop hands off -- Guard 3 takes over. This IS a fresh
    // Guard 3 deferral; the timestamp must stamp.
    const before = Date.now();
    machine.processEvent(COMP_SESSION, { ts: Date.now(), type: EventType.SubagentStop });
    const handed = machine.getState(COMP_SESSION);
    expect(handed?.pendingIdleWhileBackgroundShell).toBe(true);
    expect(handed?.deferredIdleAt).not.toBe(null);
    expect(handed?.deferredIdleAt).toBeGreaterThanOrEqual(before);
  });

  it('(c) BackgroundShellEnd fires first while subagent still active: Guard 2 holds, no idle emitted', () => {
    const { machine, transitions } = makeMachine();
    machine.initSession(COMP_SESSION);
    transitions.length = 0;

    machine.processEvent(COMP_SESSION, event(EventType.Prompt));
    machine.processEvent(COMP_SESSION, {
      ts: Date.now(),
      type: EventType.SubagentStart,
      detail: 'general',
    });
    machine.processEvent(COMP_SESSION, {
      ts: Date.now(),
      type: EventType.BackgroundShellStart,
      tool: 'Bash',
    });
    machine.processEvent(COMP_SESSION, event(EventType.Idle));
    // Both guards have deferred the idle.

    // Background shell finishes first -- subagent still running.
    machine.processEvent(COMP_SESSION, {
      ts: Date.now(),
      type: EventType.BackgroundShellEnd,
      tool: 'KillBash',
    });

    const state = machine.getState(COMP_SESSION);
    // Guard 2 must still hold -- activity stays thinking.
    expect(state?.activity).toBe('thinking');
    expect(state?.activeBackgroundShells).toBe(0);
    expect(state?.subagentDepth).toBe(1);
    expect(state?.pendingIdleWhileBackgroundShell).toBe(false);
    expect(state?.pendingIdleWhileSubagent).toBe(true);

    const idleTransitions = transitions.filter((t) => t.activity === 'idle');
    expect(idleTransitions).toHaveLength(0);
  });

  it('(d) order SubagentStop then BackgroundShellEnd: deferred idle emits exactly once', () => {
    const { machine, transitions } = makeMachine();
    machine.initSession(COMP_SESSION);
    transitions.length = 0;

    machine.processEvent(COMP_SESSION, event(EventType.Prompt));
    machine.processEvent(COMP_SESSION, {
      ts: Date.now(),
      type: EventType.SubagentStart,
      detail: 'general',
    });
    machine.processEvent(COMP_SESSION, {
      ts: Date.now(),
      type: EventType.BackgroundShellStart,
      tool: 'Bash',
    });
    machine.processEvent(COMP_SESSION, event(EventType.Idle));

    machine.processEvent(COMP_SESSION, { ts: Date.now(), type: EventType.SubagentStop });
    machine.processEvent(COMP_SESSION, { ts: Date.now(), type: EventType.BackgroundShellEnd, tool: 'KillBash' });

    const state = machine.getState(COMP_SESSION);
    expect(state?.activity).toBe('idle');
    expect(state?.subagentDepth).toBe(0);
    expect(state?.activeBackgroundShells).toBe(0);
    expect(state?.pendingIdleWhileSubagent).toBe(false);
    expect(state?.pendingIdleWhileBackgroundShell).toBe(false);

    const idleTransitions = transitions.filter((t) => t.activity === 'idle');
    expect(idleTransitions).toHaveLength(1);
  });

  it('(d-alt) order BackgroundShellEnd then SubagentStop: deferred idle emits exactly once', () => {
    const { machine, transitions } = makeMachine();
    machine.initSession(COMP_SESSION);
    transitions.length = 0;

    machine.processEvent(COMP_SESSION, event(EventType.Prompt));
    machine.processEvent(COMP_SESSION, {
      ts: Date.now(),
      type: EventType.SubagentStart,
      detail: 'general',
    });
    machine.processEvent(COMP_SESSION, {
      ts: Date.now(),
      type: EventType.BackgroundShellStart,
      tool: 'Bash',
    });
    machine.processEvent(COMP_SESSION, event(EventType.Idle));

    machine.processEvent(COMP_SESSION, { ts: Date.now(), type: EventType.BackgroundShellEnd, tool: 'KillBash' });
    machine.processEvent(COMP_SESSION, { ts: Date.now(), type: EventType.SubagentStop });

    const state = machine.getState(COMP_SESSION);
    expect(state?.activity).toBe('idle');
    expect(state?.subagentDepth).toBe(0);
    expect(state?.activeBackgroundShells).toBe(0);
    expect(state?.pendingIdleWhileSubagent).toBe(false);
    expect(state?.pendingIdleWhileBackgroundShell).toBe(false);

    const idleTransitions = transitions.filter((t) => t.activity === 'idle');
    expect(idleTransitions).toHaveLength(1);
  });
});
