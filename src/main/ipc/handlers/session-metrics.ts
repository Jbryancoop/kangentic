import type { SessionRepository } from '../../db/repositories/session-repository';
import type { SessionManager } from '../../pty/session-manager';

/**
 * Capture session metrics (cost, tokens, model, duration, tool calls) from
 * the in-memory caches and persist them to the session record in the DB.
 *
 * Must be called BEFORE the session is removed from the manager (caches
 * are cleared on remove). Safe to call from both exit and suspend paths.
 *
 * When `usageCache[sessionId]` is empty (session exited before status.json
 * appeared, queued session that never spawned, etc.) the cost/token/model
 * columns are written as NULL instead of zero. This matters because
 * `getSummaryForTask` filters `WHERE total_cost_usd IS NOT NULL` to pick
 * the latest meaningful record - a zero row would mask a prior real one.
 * The tool_call_count is always written because it's derived from a counter
 * that's accurate independently of usage telemetry.
 *
 * Best-effort: swallows all errors so it never breaks the calling flow.
 */
export function captureSessionMetrics(
  sessionManager: SessionManager,
  sessionRepo: SessionRepository,
  sessionId: string,
  recordId: string,
): void {
  try {
    const usage = sessionManager.getUsageCache()[sessionId];
    const toolCallCount = sessionManager.getToolCallCount(sessionId);
    const toolBreakdown = sessionManager.getToolBreakdown(sessionId);

    sessionRepo.updateMetrics(recordId, {
      totalCostUsd: usage?.cost.totalCostUsd ?? null,
      totalInputTokens: usage?.contextWindow.totalInputTokens ?? null,
      totalOutputTokens: usage?.contextWindow.totalOutputTokens ?? null,
      modelId: usage?.model.id ?? null,
      modelDisplayName: usage?.model.displayName ?? null,
      totalDurationMs: usage?.cost.totalDurationMs ?? null,
      toolCallCount,
      toolBreakdown: toolBreakdown.length > 0 ? JSON.stringify(toolBreakdown) : null,
    });
  } catch {
    // Metrics capture is best-effort -- never break the calling flow
  }
}
