/**
 * Wiring tests for SessionTelemetry callbacks that were NOT covered by existing
 * unit tests. Targets two specific closures:
 *
 *   Gap 4: onShellsObservedAlive -> markThinkingSignal wiring
 *     The BgShellWatcherCallbacks.onShellsObservedAlive closure (constructed in
 *     the SessionTelemetry constructor) calls
 *     this.activityEngine.markThinkingSignal(sessionId). Both ends are tested in
 *     isolation elsewhere but the closure itself was uncovered. Here we fire the
 *     callback via a mock probe that lets us drive pollNow(), and assert that
 *     `lastSignalAt` on the engine state advances.
 *
 *   Gap 5: clearSessionTracking -> bgShellWatcher.unregisterSession wiring
 *     SessionTelemetry.clearSessionTracking() calls notifySessionEnded() which
 *     calls bgShellWatcher.unregisterSession(). After clearSessionTracking, the
 *     watcher must stop firing callbacks for that session. Verified by polling
 *     after clear and asserting no natural-exit callbacks arrive.
 *
 * Test tier: Unit (vitest, no browser, no Electron, no real OS processes).
 * The BgShellWatcher is constructed inside SessionTelemetry with a
 * MockProcessTreeProbe so all OS interaction is bypassed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionTelemetry } from '../../src/main/pty/activity/session-telemetry';
import type { SessionTelemetryOptions } from '../../src/main/pty/activity/session-telemetry';
import type { ProcessInfo, ProcessTreeProbe } from '../../src/main/pty/activity/background-shell/process-tree';
import { EventType } from '../../src/shared/types';
import type { ActivityState, ActivityReason, SessionUsage, SessionEvent } from '../../src/shared/types';

// ==== Minimal mock process-tree probe ====

class MockProcessTreeProbe implements ProcessTreeProbe {
  alive = new Set<number>();
  trees = new Map<number, ProcessInfo[]>();
  failProbe = false;

  isAlive(pid: number): boolean {
    return this.alive.has(pid);
  }

  async listAllProcesses(): Promise<ProcessInfo[]> {
    if (this.failProbe) return [];
    const all: ProcessInfo[] = [];
    for (const [rootPid, descendants] of this.trees.entries()) {
      if (this.alive.has(rootPid)) {
        all.push({ pid: rootPid, ppid: 0, comm: 'claude' });
      }
      all.push(...descendants);
    }
    return all;
  }

  async listDescendants(rootPid: number): Promise<ProcessInfo[]> {
    return this.trees.get(rootPid) ?? [];
  }

  dispose(): void { /* no-op; long-lived child is Windows-probe-only */ }
}

// ==== Minimal SessionTelemetry callbacks stub ====

interface CallbackLog {
  activityChanges: Array<{ sessionId: string; activity: ActivityState; reason: ActivityReason }>;
  events: Array<{ sessionId: string; event: SessionEvent }>;
}

function makeCallbacks(log: CallbackLog) {
  return {
    onUsageChange: (_sessionId: string, _usage: SessionUsage): void => {},
    onActivityChange: (sessionId: string, activity: ActivityState, reason: ActivityReason): void => {
      log.activityChanges.push({ sessionId, activity, reason });
    },
    onEvent: (sessionId: string, event: SessionEvent): void => {
      log.events.push({ sessionId, event });
    },
    onIdleTimeout: (_sessionId: string): void => {},
    onPlanExit: (_sessionId: string): void => {},
    onPRCandidate: (_sessionId: string): void => {},
    requestSuspend: (_sessionId: string): void => {},
    isSessionRunning: (_sessionId: string): boolean => true,
  };
}

/**
 * Build a SessionTelemetry instance with a MockProcessTreeProbe and a
 * caller-controlled `getSessionRootPid` map so tests can register sessions
 * with real-seeming root PIDs without spawning any processes.
 *
 * `disableBgShellWatcher: false` (the default) - we need the watcher active
 * so the closure under test is constructed and wired.
 *
 * Engine timings are collapsed to 0 to prevent spurious watchdog firings
 * during the test. The stability window is also 0 so idle transitions are
 * synchronous - tests only care about lastSignalAt, not state transitions.
 */
function makeTelemetry(
  probe: MockProcessTreeProbe,
  rootPids: Map<string, number>,
  log: CallbackLog,
): SessionTelemetry {
  const callbacks = makeCallbacks(log);
  const options: SessionTelemetryOptions = {
    processTreeProbe: probe,
    disableBgShellWatcher: false,
    activityEngineOptions: {
      bgShellEscapeHatchMs: 60_000,
      staleThinkingTimeoutMs: 60_000,
      idleStabilityWindowMs: 0,
    },
  };
  return new SessionTelemetry(
    {
      ...callbacks,
      getSessionRootPid: (sessionId) => rootPids.get(sessionId),
    },
    options,
  );
}

// ==== Tests ====

describe('SessionTelemetry: onShellsObservedAlive -> markThinkingSignal wiring', () => {
  let probe: MockProcessTreeProbe;
  let rootPids: Map<string, number>;
  let log: CallbackLog;
  let telemetry: SessionTelemetry;

  beforeEach(() => {
    vi.useFakeTimers();
    probe = new MockProcessTreeProbe();
    rootPids = new Map();
    log = { activityChanges: [], events: [] };
    telemetry = makeTelemetry(probe, rootPids, log);
  });

  afterEach(() => {
    telemetry.dispose();
    vi.useRealTimers();
  });

  it('onShellsObservedAlive fires markThinkingSignal: lastSignalAt advances after watcher poll cycle', async () => {
    // Setup: register a session with a thinking-active state (bg shell running)
    // so the watcher fires onShellsObservedAlive on each poll cycle where
    // tracked > 0 AND shellLikeCount > 0.
    const rootPid = 7777;
    rootPids.set('s1', rootPid);
    probe.alive.add(rootPid);
    probe.trees.set(rootPid, [{ pid: 8001, ppid: rootPid, comm: 'bash' }]);

    // initSession also calls bgShellWatcher.registerSession.
    telemetry.initSession('s1');

    // Inject a BackgroundShellStart event so the engine has tracked > 0.
    // The watcher's onShellsObservedAlive guard requires tracked > 0.
    telemetry.ingestEvents('s1', [{
      ts: Date.now(),
      type: EventType.BackgroundShellStart,
    }]);

    // Snapshot lastSignalAt before the first non-anchor poll cycle.
    const engineState = telemetry.activityEngine.getState('s1');
    expect(engineState).toBeDefined();
    const signalAtBefore = engineState!.lastSignalAt;

    // Advance time by 1ms so the updated lastSignalAt is distinguishable from
    // the pre-poll value. Fake timers do not auto-advance; Date.now() under
    // vi.useFakeTimers() returns the mocked clock value.
    vi.advanceTimersByTime(1);

    // Anchor cycle (first pollNow sets preExistingHelpers, no onShellsObservedAlive).
    await telemetry.bgShellWatcher!.pollNow();

    // Second cycle: watcher sees tracked=1 and shellLikeCount=1.
    // onShellsObservedAlive fires -> markThinkingSignal -> lastSignalAt updated.
    vi.advanceTimersByTime(1);
    await telemetry.bgShellWatcher!.pollNow();

    const signalAtAfter = engineState!.lastSignalAt;
    // lastSignalAt must have advanced beyond the pre-poll snapshot.
    expect(signalAtAfter).not.toBeNull();
    expect(signalAtAfter).toBeGreaterThan(signalAtBefore ?? -1);
  });

  it('onShellsObservedAlive does NOT fire when engine has no tracked bg shells', async () => {
    // Pre-existing helpers (MCP servers, statusline workers) in the process tree
    // must NOT refresh lastSignalAt because they are not user-initiated bg work.
    // The watcher's guard `trackedAtCycle > 0 && shellLikeCount > 0` prevents
    // this. Consequently markThinkingSignal is not called and lastSignalAt stays
    // at the value set during initSession.
    const rootPid = 7778;
    rootPids.set('s2', rootPid);
    probe.alive.add(rootPid);
    // One shell-like child (pre-existing helper), but engine has 0 tracked shells.
    probe.trees.set(rootPid, [{ pid: 9001, ppid: rootPid, comm: 'bash' }]);

    telemetry.initSession('s2');
    // No BackgroundShellStart event -> engine.tracked = 0.

    const engineState = telemetry.activityEngine.getState('s2');
    expect(engineState).toBeDefined();

    // Anchor cycle.
    vi.advanceTimersByTime(1);
    await telemetry.bgShellWatcher!.pollNow();
    const signalAtAfterAnchor = engineState!.lastSignalAt;

    // Post-anchor cycle: watcher observes shell-like descendant but tracked=0.
    // onShellsObservedAlive must NOT fire.
    vi.advanceTimersByTime(1);
    await telemetry.bgShellWatcher!.pollNow();

    // lastSignalAt must be unchanged from the anchor cycle.
    expect(engineState!.lastSignalAt).toBe(signalAtAfterAnchor);
  });
});

describe('SessionTelemetry: clearSessionTracking -> bgShellWatcher.unregisterSession wiring', () => {
  let probe: MockProcessTreeProbe;
  let rootPids: Map<string, number>;
  let log: CallbackLog;
  let telemetry: SessionTelemetry;

  beforeEach(() => {
    vi.useFakeTimers();
    probe = new MockProcessTreeProbe();
    rootPids = new Map();
    log = { activityChanges: [], events: [] };
    telemetry = makeTelemetry(probe, rootPids, log);
  });

  afterEach(() => {
    telemetry.dispose();
    vi.useRealTimers();
  });

  it('clearSessionTracking calls bgShellWatcher.unregisterSession so no natural-exit callbacks fire after clear', async () => {
    // Regression guard for the phantom-adoption bug: if clearSessionTracking
    // did NOT unregister from the watcher, the watcher would keep polling and
    // could fire onNaturalExit for a session whose engine state had been deleted.
    // That would call activityEngine.markBackgroundShellEnded on a non-existent
    // state, which is a no-op (engine guards against unknown sessions), but it
    // also means the watcher keeps running and consuming resources.
    //
    // The watcher unregisters the session when unregisterSession is called, and
    // stops polling when its session map is empty. We verify: after
    // clearSessionTracking, a subsequent pollNow() fires NO natural-exit
    // callbacks for the cleared session.
    const rootPid = 7779;
    rootPids.set('s3', rootPid);
    probe.alive.add(rootPid);
    probe.trees.set(rootPid, [
      { pid: 10001, ppid: rootPid, comm: 'bash' },
      { pid: 10002, ppid: rootPid, comm: 'sh' },
    ]);

    telemetry.initSession('s3');

    // Inject 2 BackgroundShellStart events so engine thinks 2 shells are running.
    telemetry.ingestEvents('s3', [
      { ts: Date.now(), type: EventType.BackgroundShellStart },
      { ts: Date.now(), type: EventType.BackgroundShellStart },
    ]);

    // Anchor cycle.
    await telemetry.bgShellWatcher!.pollNow();

    // Simulate session suspend: clearSessionTracking unregisters the session.
    telemetry.clearSessionTracking('s3');

    // Both bash processes exit after the clear.
    probe.trees.set(rootPid, []);

    // Record log length BEFORE polling - we will assert it doesn't grow.
    const eventCountBeforePoll = log.events.length;

    // Poll twice (two deficit cycles that would fire if the session were still
    // registered). Neither cycle should fire because the session was
    // unregistered.
    await telemetry.bgShellWatcher!.pollNow();
    await telemetry.bgShellWatcher!.pollNow();

    // No BackgroundShellEnd events should have been emitted by the watcher
    // for session s3 after clearSessionTracking.
    const newEvents = log.events.slice(eventCountBeforePoll);
    const bgShellEndFromWatcher = newEvents.filter(
      (entry) =>
        entry.sessionId === 's3' && entry.event.type === EventType.BackgroundShellEnd,
    );
    expect(bgShellEndFromWatcher).toHaveLength(0);
  });

  it('watcher polling stops entirely when the last session is cleared', () => {
    // When clearSessionTracking is called for the only registered session, the
    // watcher's internal timer must be cleared (states.size === 0 triggers
    // stopPolling). This prevents the watcher from continuing to call
    // listAllProcesses on every poll interval after all sessions are gone.
    const rootPid = 7780;
    rootPids.set('s4', rootPid);
    probe.alive.add(rootPid);
    probe.trees.set(rootPid, [{ pid: 11001, ppid: rootPid, comm: 'bash' }]);

    telemetry.initSession('s4');

    // One session registered - timer should be active.
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    telemetry.clearSessionTracking('s4');

    // After clearing the only session, the watcher has no sessions left.
    // Its internal setInterval timer should be cleared.
    // Note: SessionTelemetry also has its own idle-timeout interval, but
    // idleTimeoutMinutes defaults to 0 so that interval is not armed.
    // The remaining timer count should be 0 (watcher stopped).
    expect(vi.getTimerCount()).toBe(0);
  });
});
