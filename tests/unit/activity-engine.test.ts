/**
 * Direct unit tests for ActivityEngine, the predicate-based activity engine
 * that owns idle/thinking/permission transitions for each session.
 *
 * These tests pin:
 * - The single predicate (turnActive | tools | subagent | bg shells)
 * - 3-state permission as a top-level state
 * - Discriminated-union ActivityReason (kind: 'tool'|'subagent'|...)
 * - Counter mechanics for tools, subagents, bg shells (Set-based + anonymous fallback)
 * - currentTool stickiness
 * - Force paths (forceThinking, forceIdle, markThinkingSignal)
 * - Interrupted bypasses everything to immediate idle
 * - 5-min escape hatch for orphaned background shells
 * - 180s stale-thinking watchdog
 * - 400ms idle stability window
 * - markBackgroundShellEnded (Subsystem B watcher entry point)
 * - adoptAnonymousBackgroundShells (Subsystem G resume entry point)
 * - getStatsSnapshot (Subsystem E debug surface)
 * - dispose() idempotent + clears timers
 *
 * Tests construct ActivityEngine with explicit options to keep timers
 * tight (vs the production 5min/45s defaults). Production code never
 * mutates the engine timing constants.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ActivityEngine, type ActivityEngineOptions } from '../../src/main/pty/activity/engine';
import { EventType, IdleReason } from '../../src/shared/types';
import type { ActivityState, ActivityReason, SessionEvent } from '../../src/shared/types';

interface Transition {
  sessionId: string;
  activity: ActivityState;
  reason: ActivityReason;
}

interface SyntheticEvent {
  sessionId: string;
  event: SessionEvent;
}

// Test timings: short windows so tests run in single-digit ms
const TEST_BG_SHELL_HATCH_MS = 5_000;
const TEST_STALE_TIMEOUT_MS = 1_000;
const TEST_STABILITY_WINDOW_MS = 100;

function makeEngine(options: Partial<ActivityEngineOptions> = {}): {
  engine: ActivityEngine;
  transitions: Transition[];
  syntheticEvents: SyntheticEvent[];
} {
  const transitions: Transition[] = [];
  const syntheticEvents: SyntheticEvent[] = [];
  const engine = new ActivityEngine(
    {
      onActivityChange(sessionId, activity, reason) {
        transitions.push({ sessionId, activity, reason });
      },
      onSyntheticEvent(sessionId, event) {
        syntheticEvents.push({ sessionId, event });
      },
    },
    {
      bgShellEscapeHatchMs: TEST_BG_SHELL_HATCH_MS,
      staleThinkingTimeoutMs: TEST_STALE_TIMEOUT_MS,
      idleStabilityWindowMs: TEST_STABILITY_WINDOW_MS,
      ...options,
    },
  );
  return { engine, transitions, syntheticEvents };
}

function event(type: EventType, opts?: { detail?: string; tool?: string; toolId?: string }): SessionEvent {
  return { ts: Date.now(), type, detail: opts?.detail, tool: opts?.tool, toolId: opts?.toolId };
}

const SESSION_ID = 'session-1';

/** Type-narrow ActivityReason to a specific kind for assertions. */
function asTool(reason: ActivityReason) {
  if (reason.kind !== 'tool') throw new Error(`expected tool reason, got ${reason.kind}`);
  return reason;
}
function asSubagent(reason: ActivityReason) {
  if (reason.kind !== 'subagent') throw new Error(`expected subagent reason, got ${reason.kind}`);
  return reason;
}
function asBgShell(reason: ActivityReason) {
  if (reason.kind !== 'background-shell') throw new Error(`expected background-shell reason, got ${reason.kind}`);
  return reason;
}

describe('ActivityEngine', () => {
  let engine: ActivityEngine;
  let transitions: Transition[];
  let syntheticEvents: SyntheticEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    ({ engine, transitions, syntheticEvents } = makeEngine());
  });

  afterEach(() => {
    engine.dispose();
    vi.useRealTimers();
  });

  describe('lifecycle', () => {
    it('emits an initial idle transition on initSession', () => {
      engine.initSession(SESSION_ID);
      expect(transitions).toHaveLength(1);
      expect(transitions[0].sessionId).toBe(SESSION_ID);
      expect(transitions[0].activity).toBe('idle');
      expect(transitions[0].reason.kind).toBe('idle');
    });

    it('deleteSession drops all per-session state', () => {
      engine.initSession(SESSION_ID);
      engine.deleteSession(SESSION_ID);
      expect(engine.getState(SESSION_ID)).toBeUndefined();
    });

    it('getActivityCache returns a snapshot of all sessions', () => {
      engine.initSession('a');
      engine.initSession('b');
      engine.forceThinking('b');
      expect(engine.getActivityCache()).toEqual({ a: 'idle', b: 'thinking' });
    });

    it('getActivityReason returns null for unknown sessions and a snapshot otherwise', () => {
      expect(engine.getActivityReason('unknown')).toBeNull();
      engine.initSession(SESSION_ID);
      const reason = engine.getActivityReason(SESSION_ID);
      expect(reason).not.toBeNull();
      expect(reason!.kind).toBe('idle');
    });

    it('dispose() clears all timers and is idempotent', () => {
      engine.initSession(SESSION_ID);
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      // Trigger timer arming via stale-thinking watchdog window
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      const transitionCountBeforeDispose = transitions.length;
      engine.dispose();
      expect(vi.getTimerCount()).toBe(0);
      // Idempotent
      expect(() => engine.dispose()).not.toThrow();
      // Post-dispose, processEvent is a no-op
      engine.processEvent(SESSION_ID, event(EventType.ToolStart));
      expect(transitions.length).toBe(transitionCountBeforeDispose);
    });
  });

  describe('basic transitions', () => {
    beforeEach(() => {
      engine.initSession(SESSION_ID);
      transitions.length = 0;
    });

    it('tool_start transitions idle -> thinking with reason.kind=tool', () => {
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      expect(transitions).toHaveLength(1);
      expect(transitions[0].activity).toBe('thinking');
      const reason = asTool(transitions[0].reason);
      expect(reason.pendingCount).toBe(1);
      expect(reason.currentTool).toBe('Bash');
    });

    it('prompt event transitions to thinking and stays within stale-thinking window', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      expect(transitions).toHaveLength(1);
      expect(transitions[0].activity).toBe('thinking');
      expect(engine.getState(SESSION_ID)?.turnActive).toBe(true);
      // Just before the stale watchdog window expires, still thinking
      vi.advanceTimersByTime(TEST_STALE_TIMEOUT_MS - 100);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
    });

    it('Idle event transitions thinking -> idle through stability window', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      transitions.length = 0;
      engine.processEvent(SESSION_ID, event(EventType.Idle));
      // Stability window: NOT yet idle
      expect(transitions).toHaveLength(0);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      // Window expires
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(transitions).toHaveLength(1);
      expect(transitions[0].activity).toBe('idle');
      expect(transitions[0].reason.kind).toBe('idle');
    });

    it('tool_end does NOT transition (turnActive holds)', () => {
      engine.processEvent(SESSION_ID, event(EventType.ToolStart));
      transitions.length = 0;
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd));
      expect(transitions).toHaveLength(0);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
    });

    it('repeated same-state events do not re-fire onActivityChange', () => {
      engine.processEvent(SESSION_ID, event(EventType.ToolStart));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart));
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      expect(transitions).toHaveLength(1);
    });

    it('log-only events do not transition', () => {
      engine.processEvent(SESSION_ID, event(EventType.Notification));
      engine.processEvent(SESSION_ID, event(EventType.SessionStart));
      engine.processEvent(SESSION_ID, event(EventType.ModelStart));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStop));
      expect(transitions).toHaveLength(0);
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
    });

    it('permission idle transitions to permission state immediately (3rd state)', () => {
      engine.processEvent(SESSION_ID, event(EventType.ToolStart));
      transitions.length = 0;
      engine.processEvent(SESSION_ID, event(EventType.Idle, { detail: IdleReason.Permission }));
      // Permission is immediate, not gated by stability window
      expect(transitions).toHaveLength(1);
      expect(transitions[0].activity).toBe('permission');
      expect(transitions[0].reason.kind).toBe('permission');
      expect(engine.getState(SESSION_ID)?.permissionPending).toBe(true);
    });

    it('Interrupted bypasses stability window and fires immediate idle', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
      transitions.length = 0;
      engine.processEvent(SESSION_ID, event(EventType.Interrupted));
      expect(transitions).toHaveLength(1);
      expect(transitions[0].activity).toBe('idle');
    });
  });

  describe('predicate: counters keep thinking past Idle', () => {
    beforeEach(() => {
      engine.initSession(SESSION_ID);
      transitions.length = 0;
    });

    it('long-running tool: turnActive holds thinking until Idle + window', () => {
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      vi.advanceTimersByTime(500);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd));
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      engine.processEvent(SESSION_ID, event(EventType.Idle));
      // Stability window before idle
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
    });

    it('subagent keeps thinking until SubagentStop drops depth', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));
      transitions.length = 0;

      engine.processEvent(SESSION_ID, event(EventType.Idle));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      // Subagent holds thinking despite Stop + window
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      const reason = asSubagent(engine.getActivityReason(SESSION_ID)!);
      expect(reason.depth).toBe(1);

      engine.processEvent(SESSION_ID, event(EventType.SubagentStop));
      // SubagentStop is from a counter clearing, also goes through the window
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
    });

    it('background shell keeps thinking until BackgroundShellEnd', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'bash_1' }));
      transitions.length = 0;

      engine.processEvent(SESSION_ID, event(EventType.Idle));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      const reason = asBgShell(engine.getActivityReason(SESSION_ID)!);
      expect(reason.count).toBe(1);
      expect(reason.ids).toEqual(['bash_1']);

      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellEnd, { detail: 'bash_1' }));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
    });

    it('Idle event clears stale pendingToolCount (PostToolUse hook drop recovery)', () => {
      // Regression: Claude Code's PostToolUse hook can drop or be
      // killed mid-tool, leaving an unmatched ToolStart and a stuck
      // pendingToolCount > 0. The bg-shell watcher's pending-tools
      // guard then permanently suppresses natural-exit, leaving bg
      // shells stuck in the count after the agent has officially
      // stopped. Idle (Stop hook) means the agent's turn is done -
      // any in-flight tools are stale and must be cleared.
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Read' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      // Only one of them gets a ToolEnd. The other is dropped.
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'Bash' }));
      expect(engine.getState(SESSION_ID)!.pendingToolCount).toBe(1);

      engine.processEvent(SESSION_ID, event(EventType.Idle));
      expect(engine.getState(SESSION_ID)!.pendingToolCount).toBe(0);
      expect(engine.getState(SESSION_ID)!.currentTool).toBeNull();
    });

    it('Idle with permission detail does NOT clear pendingToolCount (tool may resume)', () => {
      // Permission idle is the agent pausing for approval - it may
      // resume the same tool. Don't clear counters.
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Edit' }));
      engine.processEvent(SESSION_ID, event(EventType.Idle, { detail: IdleReason.Permission }));
      expect(engine.getState(SESSION_ID)!.pendingToolCount).toBe(1);
      expect(engine.getState(SESSION_ID)!.currentTool).toBe('Edit');
    });

    it('Stop with BOTH subagent and bg shell active waits for both (composite)', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
      transitions.length = 0;

      engine.processEvent(SESSION_ID, event(EventType.Idle));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');

      engine.processEvent(SESSION_ID, event(EventType.SubagentStop));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      expect(engine.getActivityReason(SESSION_ID)!.kind).toBe('background-shell');

      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellEnd));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
      const idles = transitions.filter((t) => t.activity === 'idle');
      expect(idles).toHaveLength(1);
    });

    it('reverse composite order works (bg shell ends first, then subagent)', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
      engine.processEvent(SESSION_ID, event(EventType.Idle));
      transitions.length = 0;

      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellEnd));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');

      engine.processEvent(SESSION_ID, event(EventType.SubagentStop));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
      const idles = transitions.filter((t) => t.activity === 'idle');
      expect(idles).toHaveLength(1);
    });
  });

  describe('idle stability window', () => {
    beforeEach(() => {
      engine.initSession(SESSION_ID);
      transitions.length = 0;
    });

    it('Stop + thinking signal within window suppresses idle', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      transitions.length = 0;
      engine.processEvent(SESSION_ID, event(EventType.Idle));
      // Halfway through window, a fresh ToolStart arrives
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS / 2);
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Read' }));
      // Advance past where the window WOULD have fired
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      // No idle transition was emitted
      expect(transitions.filter((t) => t.activity === 'idle')).toHaveLength(0);
    });

    it('Stop + no signal emits idle after window', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      transitions.length = 0;
      engine.processEvent(SESSION_ID, event(EventType.Idle));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS - 10);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      vi.advanceTimersByTime(20);
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
    });

    it('Permission idle bypasses window (instant)', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      transitions.length = 0;
      engine.processEvent(SESSION_ID, event(EventType.Idle, { detail: IdleReason.Permission }));
      // No window for permission
      expect(transitions).toHaveLength(1);
      expect(transitions[0].activity).toBe('permission');
    });

    it('window is 0 when idleStabilityWindowMs option is 0', () => {
      const e = makeEngine({ idleStabilityWindowMs: 0 });
      e.engine.initSession(SESSION_ID);
      e.engine.processEvent(SESSION_ID, event(EventType.Prompt));
      e.transitions.length = 0;
      e.engine.processEvent(SESSION_ID, event(EventType.Idle));
      // Instant idle, no window
      expect(e.transitions).toHaveLength(1);
      expect(e.transitions[0].activity).toBe('idle');
      e.engine.dispose();
    });
  });

  describe('permission state', () => {
    beforeEach(() => {
      engine.initSession(SESSION_ID);
      transitions.length = 0;
    });

    it('Prompt clears permissionPending and wakes to thinking', () => {
      engine.processEvent(SESSION_ID, event(EventType.Idle, { detail: IdleReason.Permission }));
      expect(engine.getState(SESSION_ID)?.activity).toBe('permission');
      transitions.length = 0;

      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      expect(transitions).toHaveLength(1);
      expect(transitions[0].activity).toBe('thinking');
      expect(engine.getState(SESSION_ID)?.permissionPending).toBe(false);
    });

    it('subagent ToolStart at depth>0 does NOT clear permissionPending', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));
      engine.processEvent(SESSION_ID, event(EventType.Idle, { detail: IdleReason.Permission }));
      transitions.length = 0;

      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Read' }));
      expect(engine.getState(SESSION_ID)?.permissionPending).toBe(true);
      expect(engine.getState(SESSION_ID)?.activity).toBe('permission');
    });

    it('Interrupted clears permissionPending and forces idle', () => {
      engine.processEvent(SESSION_ID, event(EventType.Idle, { detail: IdleReason.Permission }));
      transitions.length = 0;

      engine.processEvent(SESSION_ID, event(EventType.Interrupted));
      expect(transitions).toHaveLength(1);
      expect(transitions[0].activity).toBe('idle');
      expect(engine.getState(SESSION_ID)?.permissionPending).toBe(false);
    });

    it('non-permission Idle clears permissionPending', () => {
      engine.processEvent(SESSION_ID, event(EventType.Idle, { detail: IdleReason.Permission }));
      transitions.length = 0;

      engine.processEvent(SESSION_ID, event(EventType.Idle));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(engine.getState(SESSION_ID)?.permissionPending).toBe(false);
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
    });
  });

  describe('force paths', () => {
    beforeEach(() => {
      engine.initSession(SESSION_ID);
      transitions.length = 0;
    });

    it('forceThinking from idle emits thinking transition with turnActive', () => {
      engine.forceThinking(SESSION_ID);
      expect(transitions).toHaveLength(1);
      expect(transitions[0].activity).toBe('thinking');
      expect(engine.getState(SESSION_ID)?.turnActive).toBe(true);
    });

    it('forceIdle from thinking emits idle and clears all counters', () => {
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart));
      transitions.length = 0;

      engine.forceIdle(SESSION_ID);
      expect(transitions).toHaveLength(1);
      expect(transitions[0].activity).toBe('idle');
      const state = engine.getState(SESSION_ID)!;
      expect(state.turnActive).toBe(false);
      expect(state.subagentDepth).toBe(0);
      expect(state.activeBackgroundShellIds.size).toBe(0);
      expect(state.anonymousBackgroundShellCount).toBe(0);
      expect(state.pendingToolCount).toBe(0);
      expect(state.currentTool).toBeNull();
    });

    it('forceIdle from permission clears permissionPending', () => {
      engine.processEvent(SESSION_ID, event(EventType.Idle, { detail: IdleReason.Permission }));
      transitions.length = 0;

      engine.forceIdle(SESSION_ID);
      expect(engine.getState(SESSION_ID)?.permissionPending).toBe(false);
      expect(transitions[0].activity).toBe('idle');
    });

    it('markThinkingSignal is no-op on unknown sessions', () => {
      expect(() => engine.markThinkingSignal('unknown')).not.toThrow();
    });

    it('markThinkingSignal updates lastSignalAt without firing a transition', () => {
      engine.processEvent(SESSION_ID, event(EventType.ToolStart));
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd));
      transitions.length = 0;
      vi.advanceTimersByTime(500);
      const before = engine.getState(SESSION_ID)!.lastSignalAt;
      engine.markThinkingSignal(SESSION_ID);
      expect(engine.getState(SESSION_ID)!.lastSignalAt).not.toBe(before);
      expect(transitions).toHaveLength(0);
    });
  });

  describe('ActivityReason discriminated union', () => {
    beforeEach(() => {
      engine.initSession(SESSION_ID);
      transitions.length = 0;
    });

    it('priority: permission > tool > subagent > background-shell > turn-active > idle', () => {
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      engine.processEvent(SESSION_ID, event(EventType.Idle, { detail: IdleReason.Permission }));
      expect(engine.getActivityReason(SESSION_ID)!.kind).toBe('permission');

      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      expect(engine.getActivityReason(SESSION_ID)!.kind).toBe('tool');

      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'Bash' }));
      expect(engine.getActivityReason(SESSION_ID)!.kind).toBe('subagent');

      engine.processEvent(SESSION_ID, event(EventType.SubagentStop));
      expect(engine.getActivityReason(SESSION_ID)!.kind).toBe('background-shell');

      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellEnd));
      expect(engine.getActivityReason(SESSION_ID)!.kind).toBe('turn-active');

      engine.processEvent(SESSION_ID, event(EventType.Idle));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(engine.getActivityReason(SESSION_ID)!.kind).toBe('idle');
    });

    it('exposes granular counts via narrowing', () => {
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      const toolReason = asTool(engine.getActivityReason(SESSION_ID)!);
      expect(toolReason.pendingCount).toBe(1);
      expect(toolReason.currentTool).toBe('Bash');

      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'Bash' }));
      const subagentReason = asSubagent(engine.getActivityReason(SESSION_ID)!);
      expect(subagentReason.depth).toBe(2);
    });

    it('background-shell reason exposes ids', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'bash_1' }));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'bash_2' }));
      engine.processEvent(SESSION_ID, event(EventType.Idle));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      const reason = asBgShell(engine.getActivityReason(SESSION_ID)!);
      expect(reason.count).toBe(2);
      expect(new Set(reason.ids)).toEqual(new Set(['bash_1', 'bash_2']));
    });
  });

  describe('currentTool stickiness', () => {
    beforeEach(() => {
      engine.initSession(SESSION_ID);
      transitions.length = 0;
    });

    it('is set on ToolStart and persists across the tool lifetime', () => {
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      expect(engine.getState(SESSION_ID)?.currentTool).toBe('Bash');
    });

    it('is replaced by the next ToolStart', () => {
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Read' }));
      expect(engine.getState(SESSION_ID)?.currentTool).toBe('Read');
    });

    it('is cleared when pendingToolCount drops to 0', () => {
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'Bash' }));
      expect(engine.getState(SESSION_ID)?.currentTool).toBeNull();
    });

    it('survives one tool ending while another is still in flight', () => {
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Read' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'Bash' }));
      expect(engine.getState(SESSION_ID)?.currentTool).toBe('Read');
    });

    it('falls back to the still-running tool when the most recent ends first', () => {
      // Concurrent tools that end out-of-order: A starts, B starts, B
      // ends. Old behavior (single field) would leave currentTool='B'
      // because pendingToolCount stays > 0. Stack-based tracking falls
      // back to A which is genuinely still in flight.
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Grep' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Read' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'Read' }));
      expect(engine.getState(SESSION_ID)?.currentTool).toBe('Grep');
    });

    it('handles three concurrent tools ending in arbitrary order', () => {
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'A' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'B' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'C' }));
      // End B (middle): A and C still in flight, currentTool=C (top of stack).
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'B' }));
      expect(engine.getState(SESSION_ID)?.currentTool).toBe('C');
      // End C (top): A still in flight.
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'C' }));
      expect(engine.getState(SESSION_ID)?.currentTool).toBe('A');
      // End A (last): all clear.
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'A' }));
      expect(engine.getState(SESSION_ID)?.currentTool).toBeNull();
    });

    it('handles duplicate tool names by removing the most recent occurrence', () => {
      // Two concurrent Bash invocations - hooks don't carry correlation
      // IDs, so LIFO-by-name is the closest correlation we can do.
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      expect(engine.getState(SESSION_ID)?.pendingToolCount).toBe(2);
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'Bash' }));
      expect(engine.getState(SESSION_ID)?.currentTool).toBe('Bash');
      expect(engine.getState(SESSION_ID)?.pendingToolCount).toBe(1);
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'Bash' }));
      expect(engine.getState(SESSION_ID)?.currentTool).toBeNull();
    });

    it('hard-resets the stack when pendingToolCount reaches zero (recovers from name desync)', () => {
      // A hook drop could leave a name in the stack with no matching count.
      // The hard-reset on pendingToolCount=0 ensures the stack does not
      // grow forever across drift.
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Stale' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Real' }));
      // Simulate ToolEnd arriving for an unknown tool name (name drift).
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'Mystery' }));
      // Stale and Real still in stack since neither matched 'Mystery'.
      // pendingToolCount decremented to 1.
      // Now ToolEnd 'Real' decrements to 0 - hard reset clears stack.
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'Real' }));
      expect(engine.getState(SESSION_ID)?.pendingToolCount).toBe(0);
      expect(engine.getState(SESSION_ID)?.pendingToolStack).toEqual([]);
      expect(engine.getState(SESSION_ID)?.currentTool).toBeNull();
    });

    it('ID-based correlation: ToolEnd matches ToolStart by toolId regardless of order', () => {
      // The killer scenario: two concurrent Bash invocations with
      // different toolIds. LIFO-by-name would always remove the most
      // recent, leaving currentTool wrong. ID-matching removes the
      // exact one that ended.
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash', toolId: 'tu_001' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash', toolId: 'tu_002' }));
      expect(engine.getState(SESSION_ID)?.pendingToolStack).toEqual([
        { id: 'tu_001', name: 'Bash' },
        { id: 'tu_002', name: 'Bash' },
      ]);
      // The FIRST Bash (tu_001) ends - even though it's not at the top.
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'Bash', toolId: 'tu_001' }));
      expect(engine.getState(SESSION_ID)?.pendingToolStack).toEqual([
        { id: 'tu_002', name: 'Bash' },
      ]);
      expect(engine.getState(SESSION_ID)?.currentTool).toBe('Bash');
      expect(engine.getState(SESSION_ID)?.pendingToolCount).toBe(1);
    });

    it('ID-based correlation: falls back to LIFO-by-name when ID does not match', () => {
      // Hook drop / version skew: ToolStart had ID, ToolEnd arrives
      // with a different ID. We still drain the stack via name to
      // avoid getting permanently stuck.
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Read', toolId: 'tu_001' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Read', toolId: 'tu_002' }));
      // ToolEnd with mismatched ID.
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'Read', toolId: 'tu_999' }));
      // Fell back to LIFO-by-name - removed the most recent Read.
      expect(engine.getState(SESSION_ID)?.pendingToolStack).toEqual([
        { id: 'tu_001', name: 'Read' },
      ]);
      expect(engine.getState(SESSION_ID)?.pendingToolCount).toBe(1);
    });

    it('mixed ID and no-ID adapters coexist on the same stack', () => {
      // Edge case: an adapter rolls out IDs incrementally. Some events
      // have toolId, others don't. Stack must handle both.
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'A', toolId: 'tu_a' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'B' }));  // no id
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'C', toolId: 'tu_c' }));
      // ToolEnd by id removes A precisely.
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'A', toolId: 'tu_a' }));
      expect(engine.getState(SESSION_ID)?.pendingToolStack).toEqual([
        { id: undefined, name: 'B' },
        { id: 'tu_c', name: 'C' },
      ]);
      // ToolEnd without id falls back to LIFO-by-name - removes C.
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'C' }));
      expect(engine.getState(SESSION_ID)?.pendingToolStack).toEqual([
        { id: undefined, name: 'B' },
      ]);
    });
  });

  describe('5-min stuck-pending-tools watchdog (Ctrl+C hook drop recovery)', () => {
    beforeEach(() => {
      engine.initSession(SESSION_ID);
      transitions.length = 0;
      syntheticEvents.length = 0;
    });

    it('fires after threshold when only pendingToolCount is holding (turnActive=true)', () => {
      // Reproduces the user-reported bug: user pressed Ctrl+C, Claude
      // killed the bash, but PostToolUseFailure didn't propagate.
      // Engine has pending=1 + turnActive=true with no other holders
      // and no events arriving. Without this watchdog the engine is
      // stuck in 'thinking' forever.
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      const state = engine.getState(SESSION_ID)!;
      expect(state.activity).toBe('thinking');
      expect(state.pendingToolCount).toBe(1);
      expect(state.turnActive).toBe(true);

      // Advance past the 5-min hatch threshold + stability window.
      vi.advanceTimersByTime(TEST_BG_SHELL_HATCH_MS + TEST_STABILITY_WINDOW_MS + 50);

      const lastTransition = transitions.at(-1);
      expect(lastTransition?.activity).toBe('idle');
      expect(state.pendingToolCount).toBe(0);
      expect(state.pendingToolStack).toEqual([]);
      expect(state.currentTool).toBeNull();
      expect(state.turnActive).toBe(false);
      // Synthetic Idle/Timeout event was emitted to the activity log.
      expect(syntheticEvents.at(-1)?.event.type).toBe(EventType.Idle);
      expect(syntheticEvents.at(-1)?.event.detail).toBe(IdleReason.Timeout);
    });

    it('does NOT fire while a subagent is also active (legitimate work)', () => {
      // Subagent depth > 0 means agent is doing nested work - sub-tools
      // emit events that refresh lastSignalAt. Not stuck.
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));
      vi.advanceTimersByTime(TEST_BG_SHELL_HATCH_MS + 50);
      // Still thinking - subagent + tool is legitimate.
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
    });

    it('does NOT fire while bg shells are also active (separate hatch handles those)', () => {
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
      vi.advanceTimersByTime(TEST_BG_SHELL_HATCH_MS + 50);
      // Still thinking - the bg-shell hatch's predicate doesn't match
      // either (pendingToolCount>0). The pending-tools hatch's
      // predicate doesn't match either (bgShells>0). Mutual exclusion
      // is intentional: when multiple holders co-exist, no hatch fires
      // because there's a chance one is genuine activity.
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
    });

    it('signal during the wait re-arms with fresh deadline', () => {
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      // Half the threshold passes...
      vi.advanceTimersByTime(TEST_BG_SHELL_HATCH_MS / 2);
      // A nested ToolStart arrives - refreshes lastSignalAt.
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Read' }));
      // Half the threshold AGAIN passes - total time is more than
      // threshold but the deadline was reset, so still thinking.
      vi.advanceTimersByTime(TEST_BG_SHELL_HATCH_MS / 2 + 50);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
    });
  });

  describe('user Ctrl+C interrupt synthesis', () => {
    // The synthesis itself is wired in SessionTelemetry, not the engine,
    // but the engine MUST handle a synthetic Interrupted event the same
    // way as a hook-driven one: clear all counters, commit idle.
    beforeEach(() => {
      engine.initSession(SESSION_ID);
      transitions.length = 0;
    });

    it('synthetic Interrupted with detail clears stuck pending tools immediately', () => {
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');

      // The synthesis SessionTelemetry would do after Ctrl+C settle window:
      engine.processEvent(SESSION_ID, event(EventType.Interrupted, { detail: 'user-ctrl-c' }));

      const state = engine.getState(SESSION_ID)!;
      expect(state.activity).toBe('idle');
      expect(state.pendingToolCount).toBe(0);
      expect(state.pendingToolStack).toEqual([]);
      expect(state.currentTool).toBeNull();
      expect(state.turnActive).toBe(false);
      // Bypasses stability window - idle commits in this same tick.
      expect(transitions.at(-1)?.activity).toBe('idle');
    });

    it('applyInterruptedBypass zeroes every individual counter field', () => {
      // Pre-load ALL counters to non-zero values, then fire Interrupted and
      // assert each field individually. This pins the full zeroing contract
      // of applyInterruptedBypass - not just that activity becomes 'idle'.
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Read' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Write' }));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'bash_a' }));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'bash_b' }));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));  // anonymous
      // Request permission so permissionPending=true; then re-prompt to
      // get back to thinking before firing Interrupted.
      engine.processEvent(SESSION_ID, event(EventType.Idle, { detail: 'permission' }));
      engine.processEvent(SESSION_ID, event(EventType.Prompt));

      // Verify we started with all counters populated.
      const priorState = engine.getState(SESSION_ID)!;
      expect(priorState.pendingToolCount).toBe(3);
      expect(priorState.subagentDepth).toBe(2);
      expect(priorState.activeBackgroundShellIds.size).toBe(2);
      expect(priorState.anonymousBackgroundShellCount).toBe(1);
      expect(priorState.turnActive).toBe(true);

      transitions.length = 0;

      // Fire the synthetic Interrupted event (matches what UserInterruptCoordinator sends).
      engine.processEvent(SESSION_ID, event(EventType.Interrupted, { detail: 'user-ctrl-c' }));

      const state = engine.getState(SESSION_ID)!;

      // Activity immediately idle (no stability window on Interrupted path).
      expect(state.activity).toBe('idle');

      // Every counter must be at its zero value.
      expect(state.pendingToolCount).toBe(0);
      expect(state.pendingToolStack).toEqual([]);
      expect(state.currentTool).toBeNull();
      expect(state.subagentDepth).toBe(0);
      expect(state.activeBackgroundShellIds.size).toBe(0);
      expect(state.anonymousBackgroundShellCount).toBe(0);
      expect(state.turnActive).toBe(false);
      expect(state.permissionPending).toBe(false);
      expect(state.pendingIdleAt).toBeNull();

      // Exactly one idle transition committed.
      expect(transitions).toHaveLength(1);
      expect(transitions[0].activity).toBe('idle');
    });
  });

  describe('background-shell tracking (Set + anonymous fallback)', () => {
    beforeEach(() => {
      engine.initSession(SESSION_ID);
      transitions.length = 0;
    });

    it('with shell_id detail uses Set tracking', () => {
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'bash_1' }));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'bash_2' }));
      const state = engine.getState(SESSION_ID)!;
      expect(state.activeBackgroundShellIds.size).toBe(2);
      expect(state.anonymousBackgroundShellCount).toBe(0);
    });

    it('without shell_id falls back to anonymous counter', () => {
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
      const state = engine.getState(SESSION_ID)!;
      expect(state.activeBackgroundShellIds.size).toBe(0);
      expect(state.anonymousBackgroundShellCount).toBe(2);
    });

    it('mixed: Set + anonymous coexist', () => {
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'bash_1' }));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
      const reason = asBgShell(engine.getActivityReason(SESSION_ID)!);
      expect(reason.count).toBe(2);
      expect(reason.ids).toEqual(['bash_1']);
    });

    it('markBackgroundShellEnded removes by id when known', () => {
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'bash_1' }));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'bash_2' }));
      engine.markBackgroundShellEnded(SESSION_ID, 'bash_1');
      const state = engine.getState(SESSION_ID)!;
      expect(state.activeBackgroundShellIds.has('bash_1')).toBe(false);
      expect(state.activeBackgroundShellIds.has('bash_2')).toBe(true);
    });

    it('markBackgroundShellEnded with unknown id is no-op (does NOT corrupt anonymous count)', () => {
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'bash_1' }));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
      engine.markBackgroundShellEnded(SESSION_ID, 'bash_unknown');
      const state = engine.getState(SESSION_ID)!;
      // Named shell call with unknown id: ignored, anonymous untouched.
      expect(state.activeBackgroundShellIds.size).toBe(1);
      expect(state.anonymousBackgroundShellCount).toBe(1);
    });

    it('markBackgroundShellEnded with no id decrements anonymous', () => {
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
      engine.markBackgroundShellEnded(SESSION_ID);
      const state = engine.getState(SESSION_ID)!;
      expect(state.anonymousBackgroundShellCount).toBe(1);
    });

    it('adoptAnonymousBackgroundShells (Subsystem G resume)', () => {
      engine.adoptAnonymousBackgroundShells(SESSION_ID, 3);
      const state = engine.getState(SESSION_ID)!;
      expect(state.anonymousBackgroundShellCount).toBe(3);
      expect(state.activity).toBe('thinking');
    });

    it('adoptAnonymousBackgroundShells with 0 is no-op', () => {
      engine.adoptAnonymousBackgroundShells(SESSION_ID, 0);
      const state = engine.getState(SESSION_ID)!;
      expect(state.anonymousBackgroundShellCount).toBe(0);
      expect(state.activity).toBe('idle');
    });

    it('command-string detail goes to anonymous (not named set)', () => {
      // Regression: the Claude PreToolUse directive falls back to
      // tool_input.command when shell_id is absent, so detail looks
      // like "npm run typecheck". That MUST be treated as anonymous,
      // not added to the named set as a synthetic id.
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'npm run typecheck' }));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'npx playwright test' }));
      const state = engine.getState(SESSION_ID)!;
      expect(state.activeBackgroundShellIds.size).toBe(0);
      expect(state.anonymousBackgroundShellCount).toBe(2);
    });

    it('repeated command-string starts increment anonymous (no Set collision)', () => {
      // If both went into the named set as keys, two starts of the
      // same command would Set.add to the same key and undercount.
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'npm test' }));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'npm test' }));
      const state = engine.getState(SESSION_ID)!;
      expect(state.anonymousBackgroundShellCount).toBe(2);
    });

    it('absurdly long detail goes to anonymous (length cap on shell_id shape)', () => {
      const wayTooLong = 'a'.repeat(200);
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: wayTooLong }));
      const state = engine.getState(SESSION_ID)!;
      expect(state.activeBackgroundShellIds.size).toBe(0);
      expect(state.anonymousBackgroundShellCount).toBe(1);
    });

    it('watcher anonymous decrement does NOT drain named set when anonymous is empty', () => {
      // The anonymous decrement path (no shellId, fired by the
      // background-shell watcher) used to drain a named entry as a
      // last resort. That clobbered live named bg shells whenever a
      // helper process (MCP server, statusline worker) churned, since
      // the watcher cannot distinguish "tracked named shell exited"
      // from "helper exited" without PID-aware identity decrement.
      //
      // New contract: anonymous decrement is a no-op when anon=0.
      // Genuinely stuck named entries are recovered by the 5-min
      // bg-shell escape-hatch watchdog (engine/watchdog.ts), not by
      // the watcher's count-based heuristic.
      const state = engine.getState(SESSION_ID)!;
      state.activeBackgroundShellIds.add('legacy-key-1');
      state.activeBackgroundShellIds.add('legacy-key-2');
      expect(state.anonymousBackgroundShellCount).toBe(0);

      engine.markBackgroundShellEnded(SESSION_ID); // no shellId, anon=0
      // Named entries preserved.
      expect(state.activeBackgroundShellIds.size).toBe(2);
      expect(state.anonymousBackgroundShellCount).toBe(0);

      engine.markBackgroundShellEnded(SESSION_ID);
      expect(state.activeBackgroundShellIds.size).toBe(2);
    });

    it('helper churn while a named bg shell is alive does not flip session to idle', () => {
      // Repro for task #121: a real named bg shell is running
      // (e.g. `npm run build` via Claude's `Bash run_in_background:true`).
      // A helper process exits and the watcher fires its deficit
      // signal -> markBackgroundShellEnded(sessionId) (no shellId).
      // With the bug this would drain the named entry and flip the
      // engine to idle while the bash is still alive.
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'bash_1' }));
      expect(engine.getState(SESSION_ID)!.activity).toBe('thinking');

      engine.markBackgroundShellEnded(SESSION_ID);

      const state = engine.getState(SESSION_ID)!;
      expect(state.activeBackgroundShellIds.has('bash_1')).toBe(true);
      expect(state.activity).toBe('thinking');
    });

    it('BackgroundShellEnd event with unknown shellId drains named set as last resort', () => {
      // KillBash fires this with detail=tool_input.shell_id. If the
      // start was anonymous (because PreToolUse used command as
      // detail), the shellId won't match the named set. Falls through
      // to anonymous, then to named-set drain - SOMETHING ended.
      const state = engine.getState(SESSION_ID)!;
      state.activeBackgroundShellIds.add('legacy-key');
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellEnd, { detail: 'bash_assigned_id' }));
      expect(state.activeBackgroundShellIds.size).toBe(0);
    });
  });

  describe('5-min escape hatch for orphaned background shells', () => {
    beforeEach(() => {
      engine.initSession(SESSION_ID);
      transitions.length = 0;
    });

    it('force-clears bg shell counter after escape hatch when only bg shells hold', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
      engine.processEvent(SESSION_ID, event(EventType.Idle));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      transitions.length = 0;
      syntheticEvents.length = 0;

      vi.advanceTimersByTime(TEST_BG_SHELL_HATCH_MS + 100);
      // Stability window applies even on watchdog-driven idle
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
      expect(engine.getState(SESSION_ID)?.anonymousBackgroundShellCount).toBe(0);
      const idles = transitions.filter((t) => t.activity === 'idle');
      expect(idles).toHaveLength(1);
      // Synthetic Idle/Timeout event emitted before transition
      expect(syntheticEvents).toHaveLength(1);
      expect(syntheticEvents[0].event.type).toBe(EventType.Idle);
      expect(syntheticEvents[0].event.detail).toBe(IdleReason.Timeout);
    });

    it('does NOT fire when other counters also hold', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
      engine.processEvent(SESSION_ID, event(EventType.Idle));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      transitions.length = 0;

      vi.advanceTimersByTime(TEST_BG_SHELL_HATCH_MS + 100);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      expect(engine.getState(SESSION_ID)?.anonymousBackgroundShellCount).toBe(1);
    });

    it('is reset by intermediate signals (polling pattern)', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
      engine.processEvent(SESSION_ID, event(EventType.Idle));

      vi.advanceTimersByTime(TEST_BG_SHELL_HATCH_MS / 2);
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'BashOutput' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'BashOutput' }));

      vi.advanceTimersByTime(TEST_BG_SHELL_HATCH_MS / 2 + 100);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
    });
  });

  describe('180s stale-thinking watchdog (hook loss safety net)', () => {
    beforeEach(() => {
      engine.initSession(SESSION_ID);
      transitions.length = 0;
    });

    it('forces idle after stale timeout when only turnActive holds', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      syntheticEvents.length = 0;
      vi.advanceTimersByTime(TEST_STALE_TIMEOUT_MS + 100);
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
      expect(engine.getState(SESSION_ID)?.turnActive).toBe(false);
      expect(syntheticEvents).toHaveLength(1);
      expect(syntheticEvents[0].event.detail).toBe(IdleReason.Timeout);
    });

    it('does NOT fire while a tool is pending', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      vi.advanceTimersByTime(TEST_STALE_TIMEOUT_MS + 100);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
    });

    it('does NOT fire while a subagent is active', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));
      vi.advanceTimersByTime(TEST_STALE_TIMEOUT_MS + 100);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
    });

    it('does NOT fire while a bg shell is active (escape hatch handles that)', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
      vi.advanceTimersByTime(TEST_STALE_TIMEOUT_MS + 100);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
    });

    it('is reset by intermediate signals', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      vi.advanceTimersByTime(TEST_STALE_TIMEOUT_MS / 2);
      engine.markThinkingSignal(SESSION_ID);
      vi.advanceTimersByTime(TEST_STALE_TIMEOUT_MS / 2 + 100);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
    });

    it('periodic markThinkingSignal calls over many timeout windows keep thinking alive', () => {
      // Pins the contract used by `processStatusUpdate` in
      // SessionTelemetry: while Claude's statusline is updating,
      // each update fires `markThinkingSignal`, refreshing
      // `lastSignalAt` and re-arming the watchdog timer. As long as the
      // signals arrive at sub-threshold intervals, the engine stays in
      // `thinking` indefinitely. This is what kept Task #121's
      // 189-second plan-composition gap from running away into an
      // unbounded idle flip-flop - the bumped 180s threshold on top of
      // status-update intervals handles the recorded scenario.
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      const signalIntervalMs = TEST_STALE_TIMEOUT_MS / 2;
      const totalDurationMs = TEST_STALE_TIMEOUT_MS * 60;
      let elapsed = 0;
      while (elapsed < totalDurationMs) {
        vi.advanceTimersByTime(signalIntervalMs);
        elapsed += signalIntervalMs;
        engine.markThinkingSignal(SESSION_ID);
        expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      }
      // No stale-thinking transition should have been recorded across
      // the entire window.
      const state = engine.getState(SESSION_ID)!;
      const staleTransitions = state.recentTransitions.filter(
        (transition) => transition.trigger === 'timer:stale-thinking',
      );
      expect(staleTransitions).toHaveLength(0);
    });
  });

  describe('idle hint (waiting-for-input notification)', () => {
    beforeEach(() => {
      engine.initSession(SESSION_ID);
      transitions.length = 0;
    });

    it('settles a delegated turn to idle via the stability window, NOT the stale watchdog', () => {
      // Reproduces the bug: the whole turn was delegated to a subagent. When it
      // stops, turnActive is still true with no other holders. Pre-fix, only the
      // 1000ms (prod 180s) stale watchdog could drive idle.
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStop));
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      expect(engine.getState(SESSION_ID)?.turnActive).toBe(true);
      transitions.length = 0;
      syntheticEvents.length = 0;

      engine.processEvent(SESSION_ID, event(EventType.IdleHint, { detail: 'Claude is waiting for your input' }));
      // turnActive cleared; idle deferred by the stability window (not committed yet).
      expect(engine.getState(SESSION_ID)?.turnActive).toBe(false);
      expect(transitions).toHaveLength(0);

      // Idle commits well before the stale-thinking timeout.
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(transitions).toHaveLength(1);
      expect(transitions[0].activity).toBe('idle');
      // It was NOT the watchdog: no synthetic Idle event, no stale compensation.
      expect(syntheticEvents).toHaveLength(0);
      expect(engine.getState(SESSION_ID)?.compensationCounters.staleThinking).toBe(0);
    });

    it('does NOT force idle while a tool is pending', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      transitions.length = 0;
      engine.processEvent(SESSION_ID, event(EventType.IdleHint, { detail: 'Claude is waiting for your input' }));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(transitions).toHaveLength(0);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      expect(engine.getState(SESSION_ID)?.turnActive).toBe(true);
    });

    it('does NOT force idle while a subagent is active', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));
      transitions.length = 0;
      engine.processEvent(SESSION_ID, event(EventType.IdleHint, { detail: 'Claude is waiting for your input' }));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(transitions).toHaveLength(0);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
    });

    it('does NOT force idle while a bg shell is active', () => {
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'bash_1' }));
      transitions.length = 0;
      engine.processEvent(SESSION_ID, event(EventType.IdleHint, { detail: 'Claude is waiting for your input' }));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(transitions).toHaveLength(0);
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
    });

    it('does NOT force idle while a permission is pending', () => {
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      engine.processEvent(SESSION_ID, event(EventType.Idle, { detail: IdleReason.Permission }));
      expect(engine.getState(SESSION_ID)?.activity).toBe('permission');
      transitions.length = 0;
      engine.processEvent(SESSION_ID, event(EventType.IdleHint, { detail: 'Claude is waiting for your input' }));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(transitions).toHaveLength(0);
      expect(engine.getState(SESSION_ID)?.activity).toBe('permission');
    });

    it('is a no-op when the session is already idle (turnActive false)', () => {
      engine.processEvent(SESSION_ID, event(EventType.IdleHint, { detail: 'Claude is waiting for your input' }));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      expect(transitions).toHaveLength(0);
      expect(engine.getState(SESSION_ID)?.activity).toBe('idle');
    });
  });

  describe('SessionEnd is log-only', () => {
    it('does not change activity, turnActive, or counters', () => {
      engine.initSession(SESSION_ID);
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      const before = { ...engine.getState(SESSION_ID)! };
      engine.processEvent(SESSION_ID, event(EventType.SessionEnd));
      const after = engine.getState(SESSION_ID)!;
      expect(after.activity).toBe(before.activity);
      expect(after.turnActive).toBe(before.turnActive);
      expect(after.subagentDepth).toBe(before.subagentDepth);
      expect(after.pendingToolCount).toBe(before.pendingToolCount);
    });
  });

  describe('getStatsSnapshot (Subsystem E)', () => {
    beforeEach(() => {
      engine.initSession(SESSION_ID);
      transitions.length = 0;
    });

    it('returns null for unknown session', () => {
      expect(engine.getStatsSnapshot('unknown')).toBeNull();
    });

    it('exposes all current state fields', () => {
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      engine.processEvent(SESSION_ID, event(EventType.SubagentStart));
      engine.processEvent(SESSION_ID, event(EventType.BackgroundShellStart, { detail: 'bash_1' }));

      const snapshot = engine.getStatsSnapshot(SESSION_ID)!;
      expect(snapshot.activity).toBe('thinking');
      expect(snapshot.pendingToolCount).toBe(1);
      expect(snapshot.subagentDepth).toBe(1);
      expect(snapshot.backgroundShellIds).toEqual(['bash_1']);
      expect(snapshot.turnActive).toBe(true);
      expect(snapshot.permissionPending).toBe(false);
      expect(snapshot.msSinceLastSignal).not.toBeNull();
    });

    it('includes ring buffer of recent audit log entries (capped at 50)', () => {
      // Drive 60 events that each mutate counters. Each ToolStart/Idle
      // pair produces multiple log entries: ToolStart (counter delta),
      // Idle event step, plus the actual idle transition after the
      // stability window. The buffer should cap at 50 regardless.
      for (let i = 0; i < 30; i++) {
        engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: `Tool${i}` }));
        engine.processEvent(SESSION_ID, event(EventType.Idle));
        vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      }
      const snapshot = engine.getStatsSnapshot(SESSION_ID)!;
      expect(snapshot.recentTransitions.length).toBeLessThanOrEqual(50);
      // Last entry should be the most recent
      const last = snapshot.recentTransitions[snapshot.recentTransitions.length - 1];
      expect(last.from).toBeDefined();
      expect(last.to).toBeDefined();
    });

    it('audit log records counter-affecting events that DO NOT change activity (non-transition steps)', () => {
      // Regression: log used to record only state transitions, missing
      // every counter shift in between. With richer logging, a sequence
      // of tool starts/ends during a thinking turn should each appear.
      engine.processEvent(SESSION_ID, event(EventType.Prompt));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Read' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'Read' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'Bash' }));

      const log = engine.getStatsSnapshot(SESSION_ID)!.recentTransitions;
      // Expect entries for each tool_start (tools +1) and tool_end (tools -1).
      const counterDeltaEntries = log.filter((entry) => entry.counterDelta !== undefined);
      expect(counterDeltaEntries.length).toBeGreaterThanOrEqual(4);
      // Some entries are non-transitions (from === to).
      const nonTransitions = log.filter((entry) => entry.from === entry.to);
      expect(nonTransitions.length).toBeGreaterThan(0);
      // Counter-delta strings include human-readable labels.
      expect(counterDeltaEntries.some((entry) => entry.counterDelta?.includes('tools +1'))).toBe(true);
      expect(counterDeltaEntries.some((entry) => entry.counterDelta?.includes('tools -1'))).toBe(true);
    });

    it('transitions carry a trigger label sourced from the originating event/timer/force path', () => {
      engine.processEvent(SESSION_ID, event(EventType.ToolStart, { tool: 'Bash' }));
      engine.processEvent(SESSION_ID, event(EventType.ToolEnd, { tool: 'Bash' }));
      engine.processEvent(SESSION_ID, event(EventType.Idle));
      vi.advanceTimersByTime(TEST_STABILITY_WINDOW_MS + 10);
      engine.forceThinking(SESSION_ID);

      const snapshot = engine.getStatsSnapshot(SESSION_ID)!;
      const triggers = snapshot.recentTransitions.map((transition) => transition.trigger);
      expect(triggers[0]).toBe('event:tool_start');
      // Stop -> stability-window-driven idle -> 'timer:stability'
      expect(triggers).toContain('timer:stability');
      // forceThinking -> 'force-thinking'
      expect(triggers[triggers.length - 1]).toBe('force-thinking');
    });
  });
});
