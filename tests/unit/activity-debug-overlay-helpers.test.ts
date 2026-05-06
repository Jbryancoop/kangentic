/**
 * Unit tests for the four pure helper functions exported from
 * src/renderer/components/debug/ActivityDebugOverlay.tsx.
 *
 * All four are module-private utilities promoted to named exports (Option A)
 * so the test can import them without any mocking or rendering.
 *
 * Coverage:
 *   computeGridLayout  - grid columns and panel width for every boundary count
 *   reasonsEqual       - structural equality for every ActivityReason kind
 *   snapshotsContentEqual - structural equality for ActivityStatsSnapshot
 *   triggerExplanation - exact lookup, every prefix pattern, and the fallback
 *
 * No browser globals are exercised here. The functions that reference `window`
 * (computeCenteredPosition, drag event handlers) are NOT exported and are
 * intentionally out of scope for this tier.
 */
import { describe, it, expect } from 'vitest';
import {
  computeGridLayout,
  reasonsEqual,
  snapshotsContentEqual,
  triggerExplanation,
} from '../../src/renderer/components/debug/ActivityDebugOverlay';
import type { ActivityReason, ActivityStatsSnapshot, ActivityState } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Constants mirrored from the component file so assertions can be derived
// rather than hardcoded. When the component changes these knobs, the tests
// will keep the right shape as long as the assertions use these constants.
// ---------------------------------------------------------------------------
const COL_WIDTH_PX = 360;
const GAP_PX = 12;
const PANEL_PADDING_X_PX = 24;
const MAX_COLS = 3;

/** Single-column width (sessionCount <= 1). */
const ONE_COL_WIDTH = COL_WIDTH_PX + PANEL_PADDING_X_PX;

function nColWidth(cols: number): number {
  return COL_WIDTH_PX * cols + GAP_PX * (cols - 1) + PANEL_PADDING_X_PX;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSnapshot(overrides: Partial<ActivityStatsSnapshot> = {}): ActivityStatsSnapshot {
  return {
    sessionId: 'session-1',
    activity: 'idle' as ActivityState,
    reason: { kind: 'idle' } as ActivityReason,
    pendingToolCount: 0,
    subagentDepth: 0,
    backgroundShellIds: [],
    anonymousBackgroundShellCount: 0,
    turnActive: false,
    permissionPending: false,
    msSinceLastSignal: null,
    pendingIdleArmed: false,
    recentTransitions: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeGridLayout
// ---------------------------------------------------------------------------

describe('computeGridLayout', () => {
  describe('single-column region (sessionCount <= 1)', () => {
    it('returns 1 column for 0 sessions', () => {
      const layout = computeGridLayout(0);
      expect(layout.cols).toBe(1);
      expect(layout.widthPx).toBe(ONE_COL_WIDTH);
    });

    it('returns 1 column for exactly 1 session', () => {
      const layout = computeGridLayout(1);
      expect(layout.cols).toBe(1);
      expect(layout.widthPx).toBe(ONE_COL_WIDTH);
    });
  });

  describe('two-column region', () => {
    it('returns 2 columns for 2 sessions', () => {
      // ceil(sqrt(2)) = ceil(1.414) = 2
      const layout = computeGridLayout(2);
      expect(layout.cols).toBe(2);
      expect(layout.widthPx).toBe(nColWidth(2));
    });

    it('returns 2 columns for 3 sessions', () => {
      // ceil(sqrt(3)) = ceil(1.732) = 2
      const layout = computeGridLayout(3);
      expect(layout.cols).toBe(2);
      expect(layout.widthPx).toBe(nColWidth(2));
    });

    it('returns 2 columns for 4 sessions', () => {
      // ceil(sqrt(4)) = 2, still under MAX_COLS=3
      const layout = computeGridLayout(4);
      expect(layout.cols).toBe(2);
      expect(layout.widthPx).toBe(nColWidth(2));
    });
  });

  describe('three-column region (capped at MAX_COLS)', () => {
    it('returns 3 columns for 5 sessions', () => {
      // ceil(sqrt(5)) = ceil(2.236) = 3
      const layout = computeGridLayout(5);
      expect(layout.cols).toBe(MAX_COLS);
      expect(layout.widthPx).toBe(nColWidth(MAX_COLS));
    });

    it('returns 3 columns for 9 sessions', () => {
      // ceil(sqrt(9)) = 3, exactly MAX_COLS
      const layout = computeGridLayout(9);
      expect(layout.cols).toBe(MAX_COLS);
      expect(layout.widthPx).toBe(nColWidth(MAX_COLS));
    });

    it('caps at 3 columns for 10 sessions (scroll threshold)', () => {
      // ceil(sqrt(10)) = 4, but MAX_COLS=3 caps it
      const layout = computeGridLayout(10);
      expect(layout.cols).toBe(MAX_COLS);
      expect(layout.widthPx).toBe(nColWidth(MAX_COLS));
    });

    it('caps at 3 columns for large session counts', () => {
      const layout = computeGridLayout(100);
      expect(layout.cols).toBe(MAX_COLS);
      expect(layout.widthPx).toBe(nColWidth(MAX_COLS));
    });
  });

  it('widthPx formula is stable: COL_WIDTH * cols + GAP * (cols-1) + PADDING', () => {
    for (const sessionCount of [2, 3, 4, 5, 6, 7, 8, 9]) {
      const { cols, widthPx } = computeGridLayout(sessionCount);
      expect(widthPx).toBe(nColWidth(cols));
    }
  });
});

// ---------------------------------------------------------------------------
// reasonsEqual
// ---------------------------------------------------------------------------

describe('reasonsEqual', () => {
  it('returns true for identical reference', () => {
    const reason: ActivityReason = { kind: 'idle' };
    expect(reasonsEqual(reason, reason)).toBe(true);
  });

  describe('kind: idle', () => {
    it('returns true for two distinct idle reasons', () => {
      expect(reasonsEqual({ kind: 'idle' }, { kind: 'idle' })).toBe(true);
    });
  });

  describe('kind: permission', () => {
    it('returns true for two distinct permission reasons', () => {
      expect(reasonsEqual({ kind: 'permission' }, { kind: 'permission' })).toBe(true);
    });
  });

  describe('kind: turn-active', () => {
    it('returns true for two distinct turn-active reasons', () => {
      expect(reasonsEqual({ kind: 'turn-active' }, { kind: 'turn-active' })).toBe(true);
    });
  });

  describe('kind: tool', () => {
    it('returns true when pendingCount and currentTool match', () => {
      const reasonA: ActivityReason = { kind: 'tool', pendingCount: 2, currentTool: 'bash' };
      const reasonB: ActivityReason = { kind: 'tool', pendingCount: 2, currentTool: 'bash' };
      expect(reasonsEqual(reasonA, reasonB)).toBe(true);
    });

    it('returns true when both currentTool are null', () => {
      const reasonA: ActivityReason = { kind: 'tool', pendingCount: 1, currentTool: null };
      const reasonB: ActivityReason = { kind: 'tool', pendingCount: 1, currentTool: null };
      expect(reasonsEqual(reasonA, reasonB)).toBe(true);
    });

    it('returns false when pendingCount differs', () => {
      const reasonA: ActivityReason = { kind: 'tool', pendingCount: 1, currentTool: 'bash' };
      const reasonB: ActivityReason = { kind: 'tool', pendingCount: 2, currentTool: 'bash' };
      expect(reasonsEqual(reasonA, reasonB)).toBe(false);
    });

    it('returns false when currentTool differs', () => {
      const reasonA: ActivityReason = { kind: 'tool', pendingCount: 1, currentTool: 'bash' };
      const reasonB: ActivityReason = { kind: 'tool', pendingCount: 1, currentTool: 'read' };
      expect(reasonsEqual(reasonA, reasonB)).toBe(false);
    });

    it('returns false when one currentTool is null and the other is not', () => {
      const reasonA: ActivityReason = { kind: 'tool', pendingCount: 1, currentTool: null };
      const reasonB: ActivityReason = { kind: 'tool', pendingCount: 1, currentTool: 'bash' };
      expect(reasonsEqual(reasonA, reasonB)).toBe(false);
    });
  });

  describe('kind: subagent', () => {
    it('returns true when depth matches', () => {
      const reasonA: ActivityReason = { kind: 'subagent', depth: 2 };
      const reasonB: ActivityReason = { kind: 'subagent', depth: 2 };
      expect(reasonsEqual(reasonA, reasonB)).toBe(true);
    });

    it('returns false when depth differs', () => {
      const reasonA: ActivityReason = { kind: 'subagent', depth: 1 };
      const reasonB: ActivityReason = { kind: 'subagent', depth: 3 };
      expect(reasonsEqual(reasonA, reasonB)).toBe(false);
    });
  });

  describe('kind: background-shell', () => {
    it('returns true when count and ids match', () => {
      const reasonA: ActivityReason = { kind: 'background-shell', count: 2, ids: ['s1', 's2'] };
      const reasonB: ActivityReason = { kind: 'background-shell', count: 2, ids: ['s1', 's2'] };
      expect(reasonsEqual(reasonA, reasonB)).toBe(true);
    });

    it('returns true for empty ids arrays', () => {
      const reasonA: ActivityReason = { kind: 'background-shell', count: 0, ids: [] };
      const reasonB: ActivityReason = { kind: 'background-shell', count: 0, ids: [] };
      expect(reasonsEqual(reasonA, reasonB)).toBe(true);
    });

    it('returns false when count differs', () => {
      const reasonA: ActivityReason = { kind: 'background-shell', count: 1, ids: [] };
      const reasonB: ActivityReason = { kind: 'background-shell', count: 2, ids: [] };
      expect(reasonsEqual(reasonA, reasonB)).toBe(false);
    });

    it('returns false when ids length differs', () => {
      const reasonA: ActivityReason = { kind: 'background-shell', count: 2, ids: ['s1', 's2'] };
      const reasonB: ActivityReason = { kind: 'background-shell', count: 2, ids: ['s1'] };
      expect(reasonsEqual(reasonA, reasonB)).toBe(false);
    });

    it('returns false when ids differ in content', () => {
      const reasonA: ActivityReason = { kind: 'background-shell', count: 2, ids: ['s1', 's2'] };
      const reasonB: ActivityReason = { kind: 'background-shell', count: 2, ids: ['s1', 's3'] };
      expect(reasonsEqual(reasonA, reasonB)).toBe(false);
    });

    it('returns false when ids order differs', () => {
      const reasonA: ActivityReason = { kind: 'background-shell', count: 2, ids: ['s1', 's2'] };
      const reasonB: ActivityReason = { kind: 'background-shell', count: 2, ids: ['s2', 's1'] };
      expect(reasonsEqual(reasonA, reasonB)).toBe(false);
    });
  });

  describe('cross-kind', () => {
    it('returns false when kinds differ (idle vs permission)', () => {
      expect(reasonsEqual({ kind: 'idle' }, { kind: 'permission' })).toBe(false);
    });

    it('returns false when kinds differ (tool vs subagent)', () => {
      const toolReason: ActivityReason = { kind: 'tool', pendingCount: 1, currentTool: null };
      const subagentReason: ActivityReason = { kind: 'subagent', depth: 1 };
      expect(reasonsEqual(toolReason, subagentReason)).toBe(false);
    });

    it('returns false when kinds differ (background-shell vs turn-active)', () => {
      const bgReason: ActivityReason = { kind: 'background-shell', count: 0, ids: [] };
      expect(reasonsEqual(bgReason, { kind: 'turn-active' })).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// snapshotsContentEqual
// ---------------------------------------------------------------------------

describe('snapshotsContentEqual', () => {
  it('returns true for identical reference', () => {
    const snapshot = makeSnapshot();
    expect(snapshotsContentEqual(snapshot, snapshot)).toBe(true);
  });

  it('returns true for two value-equal snapshots with no transitions', () => {
    const snapshotA = makeSnapshot();
    const snapshotB = makeSnapshot();
    expect(snapshotsContentEqual(snapshotA, snapshotB)).toBe(true);
  });

  it('returns false when sessionId differs', () => {
    const snapshotA = makeSnapshot({ sessionId: 'session-1' });
    const snapshotB = makeSnapshot({ sessionId: 'session-2' });
    expect(snapshotsContentEqual(snapshotA, snapshotB)).toBe(false);
  });

  it('returns false when activity state differs', () => {
    const snapshotA = makeSnapshot({ activity: 'idle' });
    const snapshotB = makeSnapshot({ activity: 'thinking' as ActivityState });
    expect(snapshotsContentEqual(snapshotA, snapshotB)).toBe(false);
  });

  it('returns false when pendingToolCount differs', () => {
    const snapshotA = makeSnapshot({ pendingToolCount: 0 });
    const snapshotB = makeSnapshot({ pendingToolCount: 1 });
    expect(snapshotsContentEqual(snapshotA, snapshotB)).toBe(false);
  });

  it('returns false when subagentDepth differs', () => {
    const snapshotA = makeSnapshot({ subagentDepth: 0 });
    const snapshotB = makeSnapshot({ subagentDepth: 1 });
    expect(snapshotsContentEqual(snapshotA, snapshotB)).toBe(false);
  });

  it('returns false when anonymousBackgroundShellCount differs', () => {
    const snapshotA = makeSnapshot({ anonymousBackgroundShellCount: 0 });
    const snapshotB = makeSnapshot({ anonymousBackgroundShellCount: 2 });
    expect(snapshotsContentEqual(snapshotA, snapshotB)).toBe(false);
  });

  it('returns false when turnActive differs', () => {
    const snapshotA = makeSnapshot({ turnActive: false });
    const snapshotB = makeSnapshot({ turnActive: true });
    expect(snapshotsContentEqual(snapshotA, snapshotB)).toBe(false);
  });

  it('returns false when permissionPending differs', () => {
    const snapshotA = makeSnapshot({ permissionPending: false });
    const snapshotB = makeSnapshot({ permissionPending: true });
    expect(snapshotsContentEqual(snapshotA, snapshotB)).toBe(false);
  });

  it('returns false when pendingIdleArmed differs', () => {
    const snapshotA = makeSnapshot({ pendingIdleArmed: false });
    const snapshotB = makeSnapshot({ pendingIdleArmed: true });
    expect(snapshotsContentEqual(snapshotA, snapshotB)).toBe(false);
  });

  describe('backgroundShellIds comparison', () => {
    it('returns true when both have the same ids in order', () => {
      const snapshotA = makeSnapshot({ backgroundShellIds: ['s1', 's2'] });
      const snapshotB = makeSnapshot({ backgroundShellIds: ['s1', 's2'] });
      expect(snapshotsContentEqual(snapshotA, snapshotB)).toBe(true);
    });

    it('returns false when backgroundShellIds length differs', () => {
      const snapshotA = makeSnapshot({ backgroundShellIds: ['s1'] });
      const snapshotB = makeSnapshot({ backgroundShellIds: ['s1', 's2'] });
      expect(snapshotsContentEqual(snapshotA, snapshotB)).toBe(false);
    });

    it('returns false when backgroundShellIds content differs', () => {
      const snapshotA = makeSnapshot({ backgroundShellIds: ['s1', 's2'] });
      const snapshotB = makeSnapshot({ backgroundShellIds: ['s1', 's3'] });
      expect(snapshotsContentEqual(snapshotA, snapshotB)).toBe(false);
    });
  });

  describe('reason comparison (delegates to reasonsEqual)', () => {
    it('returns false when reason kind differs', () => {
      const snapshotA = makeSnapshot({ reason: { kind: 'idle' } });
      const snapshotB = makeSnapshot({ reason: { kind: 'permission' } });
      expect(snapshotsContentEqual(snapshotA, snapshotB)).toBe(false);
    });

    it('returns false when tool reason pendingCount differs', () => {
      const reasonA: ActivityReason = { kind: 'tool', pendingCount: 1, currentTool: null };
      const reasonB: ActivityReason = { kind: 'tool', pendingCount: 2, currentTool: null };
      expect(snapshotsContentEqual(makeSnapshot({ reason: reasonA }), makeSnapshot({ reason: reasonB }))).toBe(false);
    });
  });

  describe('recentTransitions ring-buffer comparison', () => {
    it('returns true when both have empty transitions', () => {
      expect(snapshotsContentEqual(makeSnapshot({ recentTransitions: [] }), makeSnapshot({ recentTransitions: [] }))).toBe(true);
    });

    it('returns false when transition count differs', () => {
      const transition = { ts: 1000, from: 'idle' as ActivityState, to: 'thinking' as ActivityState, reasonKind: 'tool' as ActivityReason['kind'], trigger: 'event:tool_start' };
      const snapshotA = makeSnapshot({ recentTransitions: [] });
      const snapshotB = makeSnapshot({ recentTransitions: [transition] });
      expect(snapshotsContentEqual(snapshotA, snapshotB)).toBe(false);
    });

    it('returns false when last-entry ts differs', () => {
      const transitionA = { ts: 1000, from: 'idle' as ActivityState, to: 'thinking' as ActivityState, reasonKind: 'tool' as ActivityReason['kind'], trigger: 'event:tool_start' };
      const transitionB = { ts: 2000, from: 'idle' as ActivityState, to: 'thinking' as ActivityState, reasonKind: 'tool' as ActivityReason['kind'], trigger: 'event:tool_start' };
      const snapshotA = makeSnapshot({ recentTransitions: [transitionA] });
      const snapshotB = makeSnapshot({ recentTransitions: [transitionB] });
      expect(snapshotsContentEqual(snapshotA, snapshotB)).toBe(false);
    });

    it('returns false when last-entry trigger differs', () => {
      const transitionA = { ts: 1000, from: 'idle' as ActivityState, to: 'thinking' as ActivityState, reasonKind: 'idle' as ActivityReason['kind'], trigger: 'event:tool_start' };
      const transitionB = { ts: 1000, from: 'idle' as ActivityState, to: 'thinking' as ActivityState, reasonKind: 'idle' as ActivityReason['kind'], trigger: 'force-thinking' };
      const snapshotA = makeSnapshot({ recentTransitions: [transitionA] });
      const snapshotB = makeSnapshot({ recentTransitions: [transitionB] });
      expect(snapshotsContentEqual(snapshotA, snapshotB)).toBe(false);
    });

    it('returns true when same last-entry even with different middle entries (ring-buffer semantics)', () => {
      // The implementation only checks length + last entry, not middle entries,
      // because middle entries in a ring buffer cannot mutate in place.
      const lastEntry = { ts: 2000, from: 'thinking' as ActivityState, to: 'idle' as ActivityState, reasonKind: 'idle' as ActivityReason['kind'], trigger: 'force-idle' };
      const firstEntryA = { ts: 900, from: 'idle' as ActivityState, to: 'thinking' as ActivityState, reasonKind: 'tool' as ActivityReason['kind'], trigger: 'event:tool_start' };
      const firstEntryB = { ts: 1100, from: 'idle' as ActivityState, to: 'thinking' as ActivityState, reasonKind: 'tool' as ActivityReason['kind'], trigger: 'event:tool_start' };
      const snapshotA = makeSnapshot({ recentTransitions: [firstEntryA, lastEntry] });
      const snapshotB = makeSnapshot({ recentTransitions: [firstEntryB, lastEntry] });
      // Same length (2) and same last entry - function returns true
      expect(snapshotsContentEqual(snapshotA, snapshotB)).toBe(true);
    });

    it('handles empty recentTransitions gracefully (no last entry)', () => {
      // Both have length 0 - lastA and lastB are both undefined.
      // (undefined?.ts ?? 0) === (undefined?.ts ?? 0) => 0 === 0 => true.
      // (undefined?.trigger ?? '') === (undefined?.trigger ?? '') => '' === '' => true.
      const snapshotA = makeSnapshot({ recentTransitions: [] });
      const snapshotB = makeSnapshot({ recentTransitions: [] });
      expect(snapshotsContentEqual(snapshotA, snapshotB)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// triggerExplanation
// ---------------------------------------------------------------------------

describe('triggerExplanation', () => {
  // Exact-match triggers from TRIGGER_EXACT_EXPLANATIONS.
  describe('exact lookup table entries', () => {
    const EXACT_TRIGGERS = [
      'force-thinking',
      'force-idle',
      'interrupted',
      'timer:stability',
      'timer:stale-thinking',
      'timer:bg-shell-hatch',
      'event:bg-shells-adopted',
    ] as const;

    for (const trigger of EXACT_TRIGGERS) {
      it(`returns an exact explanation for "${trigger}"`, () => {
        const result = triggerExplanation(trigger, 'idle');
        // Must contain the reason hint suffix.
        expect(result).toContain('Reason at commit: idle');
        // Must NOT start with the generic fallback prefix.
        expect(result).not.toMatch(/^Trigger: /);
      });
    }

    it('appends the reasonKind in the exact-match path', () => {
      const result = triggerExplanation('force-thinking', 'tool');
      expect(result).toContain('Reason at commit: tool');
    });
  });

  describe('parameterized prefix: event:bg-shell-ended:', () => {
    it('matches any bg-shell-ended suffix', () => {
      const result = triggerExplanation('event:bg-shell-ended:abc-123', 'idle');
      expect(result).toContain('Background shell ended');
      expect(result).toContain('Reason at commit: idle');
    });

    it('uses the supplied reasonKind in the hint', () => {
      const result = triggerExplanation('event:bg-shell-ended:xyz', 'background-shell');
      expect(result).toContain('Reason at commit: background-shell');
    });
  });

  describe('parameterized prefix: event:idle:', () => {
    it('embeds the detail segment in the message', () => {
      const result = triggerExplanation('event:idle:pty-silence', 'idle');
      expect(result).toContain('"pty-silence"');
      expect(result).toContain('Reason at commit: idle');
    });

    it('works with any detail value', () => {
      const result = triggerExplanation('event:idle:permission-granted', 'permission');
      expect(result).toContain('"permission-granted"');
    });
  });

  describe('generic event: prefix', () => {
    it('embeds the event type for unknown event triggers', () => {
      const result = triggerExplanation('event:tool_start', 'tool');
      expect(result).toContain('"tool_start"');
      expect(result).toContain('processed');
      expect(result).toContain('Reason at commit: tool');
    });

    it('embeds the event type for multi-segment event triggers', () => {
      const result = triggerExplanation('event:some:unknown:event', 'subagent');
      // event: prefix is sliced, remainder is 'some:unknown:event'
      expect(result).toContain('"some:unknown:event"');
    });
  });

  describe('generic timer: prefix', () => {
    it('returns engine timer message for unknown timer triggers', () => {
      const result = triggerExplanation('timer:unknown-timer', 'idle');
      expect(result).toContain('Engine timer fired');
      expect(result).toContain('Reason at commit: idle');
    });
  });

  describe('generic fallback', () => {
    it('returns the trigger name in the fallback message for unknown triggers', () => {
      const result = triggerExplanation('some-unknown-trigger', 'idle');
      expect(result).toContain('some-unknown-trigger');
      expect(result).toContain('Reason at commit: idle');
    });

    it('fallback includes all reasonKind variants', () => {
      const kinds: ActivityReason['kind'][] = ['idle', 'permission', 'tool', 'subagent', 'background-shell', 'turn-active'];
      for (const kind of kinds) {
        const result = triggerExplanation('unknown', kind);
        expect(result).toContain(`Reason at commit: ${kind}`);
      }
    });
  });

  describe('prefix priority: exact match wins over generic prefix', () => {
    it('event:bg-shells-adopted uses exact lookup, not generic event: prefix', () => {
      const exactResult = triggerExplanation('event:bg-shells-adopted', 'idle');
      // The exact entry mentions "Watcher saw shell-like processes"
      expect(exactResult).toContain('Watcher');
      // The generic event: prefix path would say 'processed'
      expect(exactResult).not.toMatch(/^Hook event/);
    });

    it('timer:stability uses exact lookup, not generic timer: prefix', () => {
      const result = triggerExplanation('timer:stability', 'idle');
      expect(result).toContain('400ms');
      expect(result).not.toBe('Engine timer fired. Reason at commit: idle');
    });
  });
});
