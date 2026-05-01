/**
 * Tests for `parseToolBreakdown` / `isPerToolStat` (via `getSummaryForTask`)
 * and for the `updateMetrics` -> `getSummaryForTask` round-trip with
 * `tool_breakdown`.
 *
 * Both helpers are module-private. They are exercised indirectly through
 * `getSummaryForTask`, which is the sole caller of `parseToolBreakdown`.
 * This approach is preferred over exporting the helpers because:
 *   - it tests the actual integration path (DB column -> deserialized PerToolStat[])
 *   - it avoids exposing implementation details in the public module surface
 *   - it gives the same branch coverage as direct tests
 *
 * better-sqlite3 is compiled for Electron's Node ABI and cannot load under
 * vitest's system Node. All tests use a queue-based mock DB that returns
 * pre-programmed values per `prepare()` call, matching the exact call order
 * inside `getSummaryForTask`.
 */

import { describe, it, expect, vi } from 'vitest';
import { SessionRepository } from '../../src/main/db/repositories/session-repository';
import type Database from 'better-sqlite3';
import type { SessionRecord } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Mock DB helpers
// ---------------------------------------------------------------------------

/**
 * A queue-based mock DB for `getSummaryForTask`.
 *
 * `getSummaryForTask` calls `prepare().get()` exactly twice:
 *   call 0 - the latestRecord query (returns a SessionRecord row)
 *   call 1 - the aggregated query (returns the aggregate stats row)
 *
 * Pass `latestRecordReturn` for call 0 and `aggregateReturn` for call 1.
 * Additional `prepare()` calls (if any) fall back to returning undefined.
 */
function createGetSummaryMockDb(options: {
  latestRecordReturn: unknown;
  aggregateReturn: unknown;
}): Database.Database {
  const getReturns: unknown[] = [options.latestRecordReturn, options.aggregateReturn];
  let callIndex = 0;

  const mockDb = {
    prepare: vi.fn((_sql: string) => {
      const index = callIndex;
      callIndex += 1;
      return {
        run: vi.fn(() => ({ changes: 0 })),
        get: vi.fn((..._params: unknown[]) => getReturns[index]),
        all: vi.fn(() => []),
      };
    }),
  } as unknown as Database.Database;

  return mockDb;
}

/**
 * A single-statement mock DB for `updateMetrics`. Captures the SQL and params
 * passed to `.run()` so we can assert the right column is written.
 */
function createUpdateMetricsMockDb(): {
  db: Database.Database;
  capturedParams: unknown[][];
} {
  const capturedParams: unknown[][] = [];

  const db = {
    prepare: vi.fn((_sql: string) => ({
      run: vi.fn((...params: unknown[]) => {
        capturedParams.push(params);
        return { changes: 1 };
      }),
      get: vi.fn(),
      all: vi.fn(() => []),
    })),
  } as unknown as Database.Database;

  return { db, capturedParams };
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Minimal aggregate row returned by the second query in getSummaryForTask. */
function makeAggregateRow() {
  return {
    total_tool_calls: 5,
    total_lines_added: 10,
    total_lines_removed: 3,
    max_files_changed: 2,
    earliest_started_at: '2026-04-01T10:00:00Z',
    latest_ended_at: '2026-04-01T11:00:00Z',
  };
}

/** Minimal session record, overridable via the `toolBreakdown` parameter. */
function makeLatestRecord(toolBreakdown: string | null): SessionRecord & { task_created_at: string } {
  return {
    id: 'session-1',
    task_id: 'task-1',
    session_type: 'claude_agent',
    agent_session_id: 'agent-1',
    command: 'claude',
    cwd: '/project',
    permission_mode: null,
    prompt: null,
    status: 'exited',
    exit_code: 0,
    started_at: '2026-04-01T10:00:00Z',
    suspended_at: null,
    exited_at: '2026-04-01T11:00:00Z',
    suspended_by: null,
    total_cost_usd: 0.05,
    total_input_tokens: 1000,
    total_output_tokens: 200,
    model_id: 'claude-opus-4',
    model_display_name: 'Claude Opus 4',
    total_duration_ms: 3600000,
    tool_call_count: 5,
    lines_added: 10,
    lines_removed: 3,
    files_changed: 2,
    tool_breakdown: toolBreakdown,
    task_created_at: '2026-04-01T09:00:00Z',
  } as SessionRecord & { task_created_at: string };
}

// ---------------------------------------------------------------------------
// Gap 1: parseToolBreakdown / isPerToolStat via getSummaryForTask
// ---------------------------------------------------------------------------

describe('parseToolBreakdown (via getSummaryForTask)', () => {
  function getSummaryWithBreakdown(toolBreakdown: string | null) {
    const db = createGetSummaryMockDb({
      latestRecordReturn: makeLatestRecord(toolBreakdown),
      aggregateReturn: makeAggregateRow(),
    });
    const repo = new SessionRepository(db);
    return repo.getSummaryForTask('task-1');
  }

  it('returns a typed PerToolStat[] for a valid full row', () => {
    const row = JSON.stringify([
      { toolName: 'Bash', callCount: 3, totalDurationMs: 1500, interruptedCount: 1, costUsd: 0.01, inputTokens: 200, outputTokens: 50 },
    ]);
    const summary = getSummaryWithBreakdown(row);
    expect(summary).not.toBeNull();
    expect(summary!.toolBreakdown).toEqual([
      { toolName: 'Bash', callCount: 3, totalDurationMs: 1500, interruptedCount: 1, costUsd: 0.01, inputTokens: 200, outputTokens: 50 },
    ]);
  });

  it('accepts a valid row with optional fields absent (cost/tokens omitted)', () => {
    const row = JSON.stringify([
      { toolName: 'Read', callCount: 2, totalDurationMs: 200, interruptedCount: 0 },
    ]);
    const summary = getSummaryWithBreakdown(row);
    expect(summary!.toolBreakdown).toEqual([
      { toolName: 'Read', callCount: 2, totalDurationMs: 200, interruptedCount: 0 },
    ]);
    // Optional fields must be absent, not null, when the writer omitted them.
    expect(summary!.toolBreakdown[0].costUsd).toBeUndefined();
    expect(summary!.toolBreakdown[0].inputTokens).toBeUndefined();
    expect(summary!.toolBreakdown[0].outputTokens).toBeUndefined();
  });

  it('silently drops a row whose required field toolName is not a string', () => {
    const row = JSON.stringify([
      { toolName: 42, callCount: 1, totalDurationMs: 100, interruptedCount: 0 },
    ]);
    const summary = getSummaryWithBreakdown(row);
    expect(summary!.toolBreakdown).toEqual([]);
  });

  it('silently drops a row whose required field callCount is missing', () => {
    const row = JSON.stringify([
      { toolName: 'Bash', totalDurationMs: 100, interruptedCount: 0 },
    ]);
    const summary = getSummaryWithBreakdown(row);
    expect(summary!.toolBreakdown).toEqual([]);
  });

  it('silently drops a row where optional field costUsd is wrong type (e.g. string "free")', () => {
    const row = JSON.stringify([
      { toolName: 'Bash', callCount: 1, totalDurationMs: 100, interruptedCount: 0, costUsd: 'free' },
    ]);
    const summary = getSummaryWithBreakdown(row);
    expect(summary!.toolBreakdown).toEqual([]);
  });

  it('returns [] for non-array JSON (e.g. an object "{}")', () => {
    const summary = getSummaryWithBreakdown('{}');
    expect(summary!.toolBreakdown).toEqual([]);
  });

  it('returns [] for invalid JSON', () => {
    const summary = getSummaryWithBreakdown('{not valid json');
    expect(summary!.toolBreakdown).toEqual([]);
  });

  it('returns [] for null input (session predates the tool_breakdown column)', () => {
    const summary = getSummaryWithBreakdown(null);
    expect(summary!.toolBreakdown).toEqual([]);
  });

  it('returns [] for empty string input', () => {
    // Empty string is falsy - parseToolBreakdown returns [] without attempting JSON.parse.
    const summary = getSummaryWithBreakdown('');
    expect(summary!.toolBreakdown).toEqual([]);
  });

  it('drops only invalid rows and keeps valid ones in a mixed array', () => {
    const row = JSON.stringify([
      { toolName: 'Bash', callCount: 2, totalDurationMs: 800, interruptedCount: 0 },
      { toolName: 999, callCount: 1, totalDurationMs: 100, interruptedCount: 0 }, // invalid
      { toolName: 'Read', callCount: 1, totalDurationMs: 50, interruptedCount: 0 },
    ]);
    const summary = getSummaryWithBreakdown(row);
    expect(summary!.toolBreakdown).toHaveLength(2);
    expect(summary!.toolBreakdown.map((tool) => tool.toolName)).toEqual(['Bash', 'Read']);
  });

  it('returns null (not an empty summary) when no session record has metrics', () => {
    // latestRecord = undefined simulates a task with no completed sessions.
    const db = createGetSummaryMockDb({
      latestRecordReturn: undefined,
      aggregateReturn: makeAggregateRow(),
    });
    const repo = new SessionRepository(db);
    const summary = repo.getSummaryForTask('task-1');
    expect(summary).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Gap 2: updateMetrics -> getSummaryForTask round-trip (tool_breakdown column)
// ---------------------------------------------------------------------------

describe('updateMetrics tool_breakdown round-trip', () => {
  it('passes the toolBreakdown JSON string to the UPDATE statement', () => {
    const { db, capturedParams } = createUpdateMetricsMockDb();
    const repo = new SessionRepository(db);

    const toolBreakdownJson = JSON.stringify([
      { toolName: 'Bash', callCount: 3, totalDurationMs: 900, interruptedCount: 1 },
    ]);

    repo.updateMetrics('session-1', {
      totalCostUsd: 0.05,
      totalInputTokens: 1000,
      totalOutputTokens: 200,
      modelId: 'claude-opus-4',
      modelDisplayName: 'Claude Opus 4',
      totalDurationMs: 3600000,
      toolCallCount: 3,
      toolBreakdown: toolBreakdownJson,
    });

    expect(capturedParams).toHaveLength(1);
    // tool_breakdown is the 8th positional param; session id is the 9th.
    // Positional order in the UPDATE: cost, input, output, modelId, displayName, duration, count, breakdown, id
    const params = capturedParams[0];
    expect(params[7]).toBe(toolBreakdownJson);
    expect(params[8]).toBe('session-1');
  });

  it('passes NULL for toolBreakdown when no tool events exist', () => {
    const { db, capturedParams } = createUpdateMetricsMockDb();
    const repo = new SessionRepository(db);

    repo.updateMetrics('session-1', {
      totalCostUsd: 0.01,
      totalInputTokens: 500,
      totalOutputTokens: 100,
      modelId: 'claude-opus-4',
      modelDisplayName: 'Claude Opus 4',
      totalDurationMs: 1000,
      toolCallCount: 0,
      toolBreakdown: null,
    });

    const params = capturedParams[0];
    expect(params[7]).toBeNull();
  });

  it('getSummaryForTask returns toolBreakdown [] when the stored value is NULL', () => {
    // End-to-end check: NULL stored in DB -> getSummaryForTask returns [].
    const db = createGetSummaryMockDb({
      latestRecordReturn: makeLatestRecord(null),
      aggregateReturn: makeAggregateRow(),
    });
    const repo = new SessionRepository(db);
    const summary = repo.getSummaryForTask('task-1');
    expect(summary!.toolBreakdown).toEqual([]);
  });

  it('getSummaryForTask returns deserialized toolBreakdown array when a valid JSON string is stored', () => {
    const toolBreakdownJson = JSON.stringify([
      { toolName: 'Bash', callCount: 5, totalDurationMs: 2500, interruptedCount: 2, costUsd: 0.02 },
      { toolName: 'Read', callCount: 3, totalDurationMs: 300, interruptedCount: 0 },
    ]);
    const db = createGetSummaryMockDb({
      latestRecordReturn: makeLatestRecord(toolBreakdownJson),
      aggregateReturn: makeAggregateRow(),
    });
    const repo = new SessionRepository(db);
    const summary = repo.getSummaryForTask('task-1');
    expect(summary!.toolBreakdown).toHaveLength(2);
    expect(summary!.toolBreakdown[0]).toMatchObject({ toolName: 'Bash', callCount: 5, costUsd: 0.02 });
    expect(summary!.toolBreakdown[1]).toMatchObject({ toolName: 'Read', callCount: 3 });
  });
});
