/**
 * Replay tests: drive captured production events.jsonl files through
 * the activity engine in fast-time and assert expected end-state.
 *
 * These pin behavior against real-world data. A regression in the
 * engine that changes how it handles a real event sequence will diff
 * the expected outcome here.
 *
 * Fixtures live at `tests/fixtures/replay/*.jsonl` (sanitized - see
 * `tests/fixtures/replay/_sanitize.mjs`). Expected outcomes are
 * embedded in this test file (one describe block per fixture).
 *
 * Engine timing for replay is set to no-op windows (0/0/0) so each
 * event commits instantly and final state reflects the predicate
 * exactly. Production timing windows are out-of-scope for replay
 * tests - they're tested separately in activity-engine.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ActivityEngine } from '../../src/main/pty/activity/engine';
import { EventType } from '../../src/shared/types';
import type { ActivityState, SessionEvent } from '../../src/shared/types';

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'replay');
const SESSION_ID = 'replay-session';

interface ReplayResult {
  finalActivity: ActivityState;
  totalTransitions: number;
  /** Every committed activity value, in order (one entry per onActivityChange). */
  transitions: ActivityState[];
  finalState: {
    pendingToolCount: number;
    subagentDepth: number;
    activeBackgroundShellIds: string[];
    anonymousBackgroundShellCount: number;
    turnActive: boolean;
    permissionPending: boolean;
  };
  staleThinkingCompensations: number;
  /** PTY-tracker / heartbeat forced-thinking transitions (the safety net). */
  forceThinkingCompensations: number;
  /** Unattributable `background_shell_end` events made no-ops by the engine
   *  invariant (a spurious end that matched no tracked shell). */
  unmatchedBgShellEndCompensations: number;
  /** Trigger of the last committed thinking->idle transition, or null. */
  lastThinkingToIdleTrigger: string | null;
}

function loadFixture(name: string): SessionEvent[] {
  const filePath = path.join(FIXTURES_DIR, name);
  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  return lines.map((line) => JSON.parse(line) as SessionEvent);
}

function replay(events: SessionEvent[]): ReplayResult {
  const transitions: ActivityState[] = [];
  const engine = new ActivityEngine(
    {
      onActivityChange(_sessionId, activity) {
        transitions.push(activity);
      },
    },
    {
      bgShellEscapeHatchMs: 1000,        // sane finite values for tick processing
      staleThinkingTimeoutMs: 60_000,
      idleStabilityWindowMs: 0,          // skip window for deterministic replay
    },
  );
  engine.initSession(SESSION_ID);
  for (const event of events) {
    engine.processEvent(SESSION_ID, event);
  }
  const state = engine.getState(SESSION_ID)!;
  const snapshot = engine.getStatsSnapshot(SESSION_ID)!;
  const lastThinkingToIdle = [...snapshot.recentTransitions]
    .reverse()
    .find((record) => record.from === 'thinking' && record.to === 'idle');
  const result: ReplayResult = {
    finalActivity: state.activity,
    totalTransitions: transitions.length,
    transitions: transitions.slice(),
    finalState: {
      pendingToolCount: state.pendingToolCount,
      subagentDepth: state.subagentDepth,
      activeBackgroundShellIds: Array.from(state.activeBackgroundShellIds),
      anonymousBackgroundShellCount: state.anonymousBackgroundShellCount,
      turnActive: state.turnActive,
      permissionPending: state.permissionPending,
    },
    staleThinkingCompensations: snapshot.compensationCounters.staleThinking,
    forceThinkingCompensations: snapshot.compensationCounters.forceThinking,
    unmatchedBgShellEndCompensations: snapshot.compensationCounters.unmatchedBgShellEnd,
    lastThinkingToIdleTrigger: lastThinkingToIdle?.trigger ?? null,
  };
  engine.dispose();
  return result;
}

describe('ActivityEngine replay tests', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('session-001-bg-shell-orphans', () => {
    let result: ReplayResult;
    beforeEach(() => {
      const events = loadFixture('session-001-bg-shell-orphans.jsonl');
      result = replay(events);
    });

    it('processes the entire event stream without throwing', () => {
      expect(result.totalTransitions).toBeGreaterThan(0);
    });

    it('ends with 3 orphan bg shells tracked (started, never KillBashed)', () => {
      // session-001 has 3 background_shell_start events with command
      // strings as detail (e.g. "npm run test:unit"). With current
      // engine, these go into activeBackgroundShellIds with the command
      // as the id (because no shell_id directive yet - Subsystem C).
      // Total bg shells held = 3.
      const total =
        result.finalState.activeBackgroundShellIds.length
        + result.finalState.anonymousBackgroundShellCount;
      expect(total).toBe(3);
    });

    it('ends in thinking state because of orphan bg shells', () => {
      // 3 bg shells held -> predicate stays thinking. The escape
      // hatch would force-clear in production after 5 min.
      expect(result.finalActivity).toBe('thinking');
    });

    it('subagent depth balanced (4 starts + 4 stops = 0 net)', () => {
      expect(result.finalState.subagentDepth).toBe(0);
    });

    it('orphan tool_starts cleared by Idle clamp (production hook loss self-heals)', () => {
      // Real production sessions have unbalanced tool_start/tool_end
      // counts because of hook-loss edge cases. The engine self-heals:
      // every Idle event (Claude's Stop hook) clamps pendingToolCount
      // back to 0. Without the clamp, dropped PostToolUse hooks would
      // hold the predicate in 'thinking' indefinitely via the tool
      // reason. The bg-shell counts are independent and still gate
      // the predicate correctly.
      expect(result.finalState.pendingToolCount).toBe(0);
    });
  });

  describe('session-009-phantom-bg-shell-no-end', () => {
    // Real capture of the production bug (session 4632519c, task #175). The
    // agent ran `npm install` (anonymous) which was promoted to the named bg
    // shell `beg7osflu` as worktree setup, finished its turn (idle), and waited
    // for input - but no background_shell_end ever fired for it. The engine is
    // left holding one orphan: the exact precondition the timing-driven grace
    // reclaims (that recovery is exercised in activity-engine.test.ts).
    let result: ReplayResult;
    beforeEach(() => {
      const events = loadFixture('session-009-phantom-bg-shell-no-end.jsonl');
      result = replay(events);
    });

    it('ends with exactly 1 orphaned bg shell tracked (start with no end)', () => {
      const total =
        result.finalState.activeBackgroundShellIds.length
        + result.finalState.anonymousBackgroundShellCount;
      expect(total).toBe(1);
    });

    it('ends thinking, held only by the orphan after the turn is over', () => {
      expect(result.finalActivity).toBe('thinking');
      expect(result.finalState.turnActive).toBe(false);
      expect(result.finalState.pendingToolCount).toBe(0);
      expect(result.finalState.subagentDepth).toBe(0);
    });
  });

  describe('session-002-many-bg-shells', () => {
    let result: ReplayResult;
    beforeEach(() => {
      const events = loadFixture('session-002-many-bg-shells.jsonl');
      result = replay(events);
    });

    it('processes the entire event stream without throwing', () => {
      expect(result.totalTransitions).toBeGreaterThan(0);
    });

    it('ends with non-zero bg shell count (orphans)', () => {
      const total =
        result.finalState.activeBackgroundShellIds.length
        + result.finalState.anonymousBackgroundShellCount;
      expect(total).toBeGreaterThan(0);
    });
  });

  describe('session-003-no-bg-shells', () => {
    let result: ReplayResult;
    beforeEach(() => {
      // Despite the filename mentioning killbash, this session captured
      // a long agent run with NO background shells. Useful for testing
      // the engine's handling of high-volume tool/subagent events.
      const events = loadFixture('session-003-with-killbash.jsonl');
      result = replay(events);
    });

    it('no bg shells present', () => {
      const total =
        result.finalState.activeBackgroundShellIds.length
        + result.finalState.anonymousBackgroundShellCount;
      expect(total).toBe(0);
    });

    it('subagent depth was overshot (more stops than starts: 4+9=net -5)', () => {
      // Real production sessions have unbalanced subagent events too.
      // Math.max(0, ...) clamps to 0 - never goes negative.
      expect(result.finalState.subagentDepth).toBe(0);
    });

    it('processes 900 events without throwing', () => {
      expect(result.totalTransitions).toBeGreaterThan(0);
    });
  });

  describe('session-004-large-22-bg-shells (stress test)', () => {
    let result: ReplayResult;
    beforeEach(() => {
      const events = loadFixture('session-004-large-22-bg-shells.jsonl');
      result = replay(events);
    });

    it('handles 22+ bg shells without counter corruption', () => {
      const total =
        result.finalState.activeBackgroundShellIds.length
        + result.finalState.anonymousBackgroundShellCount;
      expect(total).toBeGreaterThanOrEqual(0);
      expect(total).toBeLessThanOrEqual(22);
      expect(result.finalState.subagentDepth).toBeGreaterThanOrEqual(0);
      expect(result.finalState.pendingToolCount).toBeGreaterThanOrEqual(0);
    });

    it('processes all events without throwing', () => {
      expect(result.totalTransitions).toBeGreaterThan(0);
    });
  });

  describe('session-005-waiting-for-input-idle-hint', () => {
    // Derived from the trace of task #156's session
    // 2d75b9e3-4ebb-420c-9d63-7ec48ba46c4b (sanitized). The whole turn was
    // delegated to a subagent; when the subagent stopped, turnActive was still
    // true and the only signal that arrived was a "Claude is waiting for your
    // input" notification (classified at the source into idle_hint). With no
    // pending tools/subagents/bg-shells, the pre-fix engine had nothing to drive
    // idle except the 180s stale-thinking watchdog. The idle_hint now settles it.
    let result: ReplayResult;
    beforeEach(() => {
      const events = loadFixture('session-005-waiting-for-input-idle-hint.jsonl');
      result = replay(events);
    });

    it('reaches idle (not stuck thinking) after the waiting-for-input hint', () => {
      expect(result.finalActivity).toBe('idle');
      expect(result.finalState.turnActive).toBe(false);
    });

    it('settles via the idle_hint, NOT the 180s stale-thinking watchdog', () => {
      expect(result.lastThinkingToIdleTrigger).not.toBeNull();
      expect(result.lastThinkingToIdleTrigger).toMatch(/^event:idle_hint/);
      expect(result.lastThinkingToIdleTrigger).not.toBe('timer:stale-thinking');
    });

    it('never fires the stale-thinking compensation', () => {
      expect(result.staleThinkingCompensations).toBe(0);
    });

    it('all holders are clear at the end (no orphaned counters)', () => {
      expect(result.finalState.pendingToolCount).toBe(0);
      expect(result.finalState.subagentDepth).toBe(0);
      expect(
        result.finalState.activeBackgroundShellIds.length
        + result.finalState.anonymousBackgroundShellCount,
      ).toBe(0);
      expect(result.finalState.permissionPending).toBe(false);
    });
  });

  describe('session-006-ask-user-question-resume', () => {
    // Real capture from task #(fix-pr-linking) session
    // 037d97e9-ae42-49e7-ae69-b22b5016b848 (sanitized). The agent called
    // AskUserQuestion, which fired idle:permission (turnActive cleared). When
    // the user answered, the only signal was the AskUserQuestion tool_end at
    // depth 0 - a LOG_ONLY event that clears permissionPending but does not
    // re-arm turnActive. Pre-fix, the predicate dropped to idle and the card
    // sat idle (~65s observed) until the PTY force-thinking net caught up. The
    // resumed turn must show as thinking the instant the pause resolves.
    let result: ReplayResult;
    beforeEach(() => {
      const events = loadFixture('session-006-ask-user-question-resume.jsonl');
      result = replay(events);
    });

    it('resumes to thinking immediately when the permission pause resolves (NOT idle)', () => {
      expect(result.finalActivity).toBe('thinking');
      expect(result.finalState.turnActive).toBe(true);
      expect(result.finalState.permissionPending).toBe(false);
    });

    it('never dips to idle between the permission pause and the resumed turn', () => {
      // Once the turn goes active, the pause resolves permission -> thinking
      // directly. A pre-fix run records a permission -> idle dip here. The
      // leading entry is the pre-turn initial idle from initSession (expected).
      const firstActive = result.transitions.findIndex((activity) => activity !== 'idle');
      expect(firstActive).toBeGreaterThanOrEqual(0);
      expect(result.transitions.slice(firstActive)).not.toContain('idle');
      expect(result.transitions[result.transitions.length - 1]).toBe('thinking');
    });

    it('recovers via the tool_end hook, NOT the PTY force-thinking net', () => {
      // The whole point of the fix: the hook event restores the turn, so the
      // safety net never has to fire for the resume.
      expect(result.forceThinkingCompensations).toBe(0);
      expect(result.staleThinkingCompensations).toBe(0);
    });

    it('leaves no orphaned holders (clean counters at the resume)', () => {
      expect(result.finalState.pendingToolCount).toBe(0);
      expect(result.finalState.subagentDepth).toBe(0);
      expect(
        result.finalState.activeBackgroundShellIds.length
        + result.finalState.anonymousBackgroundShellCount,
      ).toBe(0);
    });
  });

  describe('session-007-exit-plan-mode-resume', () => {
    // Real capture from task #(fix-board) session
    // 83f6b918-0942-466f-b116-5c5bf51940d9 (sanitized). This session paused
    // TWICE: first an AskUserQuestion, then an ExitPlanMode plan-approval. Both
    // resolved via a depth-0 tool_end with no fresh prompt/tool_start hook;
    // pre-fix the ExitPlanMode resume sat idle ~83s until the PTY net fired.
    // Proves the fix is generic across permission-class pauses, not just
    // AskUserQuestion.
    let result: ReplayResult;
    beforeEach(() => {
      const events = loadFixture('session-007-exit-plan-mode-resume.jsonl');
      result = replay(events);
    });

    it('resumes to thinking after the ExitPlanMode plan-approval resolves', () => {
      expect(result.finalActivity).toBe('thinking');
      expect(result.finalState.turnActive).toBe(true);
      expect(result.finalState.permissionPending).toBe(false);
    });

    it('never dips to idle across EITHER permission pause (both cycles recover)', () => {
      // A pre-fix run records a permission -> idle dip twice (once per resolved
      // pause). The leading entry is the pre-turn initial idle (expected).
      const firstActive = result.transitions.findIndex((activity) => activity !== 'idle');
      expect(firstActive).toBeGreaterThanOrEqual(0);
      expect(result.transitions.slice(firstActive)).not.toContain('idle');
    });

    it('recovers via hooks, NOT the PTY force-thinking net (no compensation)', () => {
      expect(result.forceThinkingCompensations).toBe(0);
      expect(result.staleThinkingCompensations).toBe(0);
    });

    it('leaves no orphaned holders at the end', () => {
      expect(result.finalState.pendingToolCount).toBe(0);
      expect(result.finalState.subagentDepth).toBe(0);
      expect(
        result.finalState.activeBackgroundShellIds.length
        + result.finalState.anonymousBackgroundShellCount,
      ).toBe(0);
    });
  });

  describe('session-010-subagent-permission-resume', () => {
    // Real capture from task #194 session 4ee951bb (sanitized). A PowerShell
    // tool INSIDE a Plan subagent raised a permission prompt (idle:permission
    // at subagentDepth 1). The user approved it: the tool ran to completion
    // and its tool_end arrived carrying the same toolId - but at depth 1,
    // where the depth-0 clearing gate ignored it. The PTY net deliberately
    // exempts 'permission' (a live prompt repaints the TUI), so the card sat
    // in the needs-attention state for the remaining 77s of the subagent's
    // life. The awaited tool's own completion must clear the flag regardless
    // of depth.
    const FIXTURE = 'session-010-subagent-permission-resume.jsonl';
    const APPROVED_TOOL_ID = 'toolu_0159sz6ngCMPXwqAqi3CUUiV';

    function sliceThroughApprovedToolEnd(events: SessionEvent[]): SessionEvent[] {
      const approvedToolEndIndex = events.findIndex(
        (candidate) => candidate.type === EventType.ToolEnd && candidate.toolId === APPROVED_TOOL_ID,
      );
      expect(approvedToolEndIndex).toBeGreaterThan(0);
      return events.slice(0, approvedToolEndIndex + 1);
    }

    it('clears permission the moment the approved subagent tool completes', () => {
      // Red without the awaited-toolId clear: the depth-0 gate ignores the
      // approving tool_end and this slice replays to a stuck 'permission'.
      const events = loadFixture(FIXTURE);
      const result = replay(sliceThroughApprovedToolEnd(events));
      expect(result.finalActivity).toBe('thinking');
      expect(result.finalState.permissionPending).toBe(false);
      expect(result.finalState.turnActive).toBe(true);
      // The Plan subagent and its spawning Agent tool are still in flight.
      expect(result.finalState.subagentDepth).toBe(1);
      expect(result.finalState.pendingToolCount).toBe(1);
    });

    it('transitions idle -> thinking -> permission -> thinking with no idle dip', () => {
      const events = loadFixture(FIXTURE);
      const result = replay(sliceThroughApprovedToolEnd(events));
      // Leading idle is the initSession baseline. A pre-fix run ends on
      // 'permission' with no recovery entry.
      expect(result.transitions).toEqual(['idle', 'thinking', 'permission', 'thinking']);
    });

    it('full replay ends thinking with clean counters and no safety-net compensations', () => {
      const result = replay(loadFixture(FIXTURE));
      expect(result.finalActivity).toBe('thinking');
      expect(result.finalState.permissionPending).toBe(false);
      expect(result.finalState.pendingToolCount).toBe(0);
      expect(result.finalState.subagentDepth).toBe(0);
      expect(
        result.finalState.activeBackgroundShellIds.length
        + result.finalState.anonymousBackgroundShellCount,
      ).toBe(0);
      // Recovery came from the hook event, not the PTY net or watchdogs.
      expect(result.forceThinkingCompensations).toBe(0);
      expect(result.staleThinkingCompensations).toBe(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // The coupled tool-blind-remap bug (foreground Agent completion was
  // mis-mapped to background_shell_end). The two input-layer bugs
  // (over-decrement via the Agent mis-remap, over-increment via the failed
  // shell-id promotion) PARTIALLY CANCEL, so replaying the raw capture
  // looks fine. These three fixtures encode the bridge's output under the
  // full fix and under each deliberately-partial fix, so the harm and the
  // coupling are pinned at the engine level.
  // ───────────────────────────────────────────────────────────────────
  describe('session-008: coupled bg-shell / Agent-remap fix (GREEN, both fixes)', () => {
    const FIXTURE = 'session-008-coupled-bg-shell-corrected.jsonl';

    it('tracks the single backgrounded Bash with count 1 (named, not double-counted)', () => {
      // Replay up to (not including) the KillBash that ends the shell.
      const events = loadFixture(FIXTURE);
      const beforeKill = events.slice(0, -1);
      const result = replay(beforeKill);
      // The Pre+Post pair promoted the anonymous slot to a named slot:
      // exactly one shell, tracked by id, no anonymous double-count.
      expect(result.finalState.activeBackgroundShellIds).toEqual(['bash_1']);
      expect(result.finalState.anonymousBackgroundShellCount).toBe(0);
      // The Agent completion was a plain tool_end, so nothing decremented
      // the bg-shell count: no spurious end.
      expect(result.unmatchedBgShellEndCompensations).toBe(0);
    });

    it('stays thinking after the main Stop while the real shell runs', () => {
      const events = loadFixture(FIXTURE);
      const beforeKill = events.slice(0, -1);
      const result = replay(beforeKill);
      // turnActive cleared by the Idle, but the named shell holds thinking.
      expect(result.finalActivity).toBe('thinking');
      expect(result.finalState.turnActive).toBe(false);
    });

    it('idles only once the real shell actually exits, via the bg-shell-end trigger', () => {
      const result = replay(loadFixture(FIXTURE));
      expect(result.finalActivity).toBe('idle');
      expect(result.finalState.activeBackgroundShellIds).toEqual([]);
      expect(result.finalState.anonymousBackgroundShellCount).toBe(0);
      expect(result.unmatchedBgShellEndCompensations).toBe(0);
      expect(result.lastThinkingToIdleTrigger).toMatch(/^event:background_shell_end/);
    });
  });

  describe('session-008: RED, fix-1-only (status remaps removed, shell-id field still wrong)', () => {
    // With the field name still wrong, the PostToolUse promotion re-emit is
    // detail-less, so the single real shell is double-counted as anonymous.
    // Removing the Agent mis-remap ALONE leaves this over-count, which keeps
    // the session thinking for the WRONG reason (phantom shells). This is why
    // fix #2 must land with fix #1.
    it('over-counts the bg shell (anon=2) when the shell-id field is not fixed', () => {
      const result = replay(loadFixture('session-008-coupled-bg-shell-red-fix1-only.jsonl'));
      expect(result.finalState.anonymousBackgroundShellCount).toBe(2);
      expect(result.finalState.activeBackgroundShellIds).toEqual([]);
      expect(result.finalActivity).toBe('thinking');
    });
  });

  describe('session-008: RED, fix-2-only (promotion works, Agent mis-remap still present)', () => {
    // With promotion fixed, the real shell is tracked by id (bash_1). The
    // Agent completion still leaks as a spurious, detail-less
    // background_shell_end. WITHOUT the engine invariant (#6) the old
    // last-resort drain would have removed bash_1 -> bgShell 0 -> premature
    // idle / false "task done" while playwright still ran. WITH #6 the
    // unattributable end is a no-op that bumps a counter, so the real shell
    // survives. This fixture is the red-green for both fix #1 and the
    // engine invariant.
    it('makes the spurious Agent end a no-op (counter bumps) and keeps the real shell', () => {
      const result = replay(loadFixture('session-008-coupled-bg-shell-red-fix2-only.jsonl'));
      expect(result.unmatchedBgShellEndCompensations).toBe(1);
      expect(result.finalState.activeBackgroundShellIds).toEqual(['bash_1']);
      expect(result.finalState.anonymousBackgroundShellCount).toBe(0);
      // The real shell survives -> still thinking, NOT a premature idle.
      expect(result.finalActivity).toBe('thinking');
    });
  });

  describe('cross-fixture invariants', () => {
    it('all fixtures produce a deterministic outcome (no flakiness)', () => {
      const fixtures = [
        'session-001-bg-shell-orphans.jsonl',
        'session-002-many-bg-shells.jsonl',
        'session-003-with-killbash.jsonl',
        'session-004-large-22-bg-shells.jsonl',
        'session-006-ask-user-question-resume.jsonl',
        'session-007-exit-plan-mode-resume.jsonl',
        'session-010-subagent-permission-resume.jsonl',
        'session-008-coupled-bg-shell-corrected.jsonl',
        'session-008-coupled-bg-shell-red-fix1-only.jsonl',
        'session-008-coupled-bg-shell-red-fix2-only.jsonl',
      ];
      for (const name of fixtures) {
        const events = loadFixture(name);
        const r1 = replay(events);
        const r2 = replay(events);
        expect(r1).toEqual(r2);
      }
    });

    it('every fixture has a non-empty event stream', () => {
      const names = fs
        .readdirSync(FIXTURES_DIR)
        .filter((f) => f.endsWith('.jsonl'));
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        const events = loadFixture(name);
        expect(events.length).toBeGreaterThan(0);
        // First event should be session_start (Claude Code's invariant)
        expect(events[0].type).toBe(EventType.SessionStart);
      }
    });
  });
});
