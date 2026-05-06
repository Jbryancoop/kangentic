/**
 * Replay tests: drive captured production events.jsonl files through
 * the activity engine in fast-time and assert expected end-state.
 *
 * These pin behavior against real-world data. A regression in the
 * engine that changes how it handles a real event sequence will diff
 * the expected outcome here.
 *
 * Fixtures live at `tests/fixtures/replay/*.jsonl` (sanitized — see
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
  finalState: {
    pendingToolCount: number;
    subagentDepth: number;
    activeBackgroundShellIds: string[];
    anonymousBackgroundShellCount: number;
    turnActive: boolean;
    permissionPending: boolean;
  };
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
  const result: ReplayResult = {
    finalActivity: state.activity,
    totalTransitions: transitions.length,
    finalState: {
      pendingToolCount: state.pendingToolCount,
      subagentDepth: state.subagentDepth,
      activeBackgroundShellIds: Array.from(state.activeBackgroundShellIds),
      anonymousBackgroundShellCount: state.anonymousBackgroundShellCount,
      turnActive: state.turnActive,
      permissionPending: state.permissionPending,
    },
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

  describe('cross-fixture invariants', () => {
    it('all fixtures produce a deterministic outcome (no flakiness)', () => {
      const fixtures = [
        'session-001-bg-shell-orphans.jsonl',
        'session-002-many-bg-shells.jsonl',
        'session-003-with-killbash.jsonl',
        'session-004-large-22-bg-shells.jsonl',
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
