import type { SessionSummary } from '../../../../shared/types';

/**
 * Build the tooltip string for the Tools cell. Lists the top 5 tools by
 * total invocation count (success + interrupted) so a quick mouseover
 * reveals what the task was actually doing without expanding the row.
 * Falls back to the bare count when no per-tool breakdown was captured
 * (older session records, sessions that pre-date the column).
 *
 * Pure function - no React, no side effects. Extracted here so it can be
 * unit-tested without a JSX/browser environment.
 */
export function buildToolsTooltip(summary: SessionSummary): string {
  const breakdown = summary.toolBreakdown ?? [];
  if (breakdown.length === 0) return `${summary.toolCallCount} tool calls`;
  const sorted = breakdown
    .slice()
    .sort((a, b) => (b.callCount + b.interruptedCount) - (a.callCount + a.interruptedCount))
    .slice(0, 5);
  return sorted.map((tool) => `${tool.toolName} ${tool.callCount + tool.interruptedCount}`).join(', ');
}
