import { AlertTriangle } from 'lucide-react';
import { formatTokenCount } from '../../utils/format-tokens';
import { formatDuration, formatCost } from '../../utils/format-session';
import type { PerToolStat } from '../../../shared/types';

// Tool durations are often sub-second (Read, Edit, Grep). The shared
// `formatDuration` helper rounds to seconds, so it would render every
// fast tool as "0s". Use a finer-grained format here.
function formatToolDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)}s`;
  return formatDuration(milliseconds);
}

interface ByToolTableProps {
  rows: PerToolStat[];
}

/**
 * Per-tool breakdown table (Tool / Calls / Total / Avg, plus optional
 * cost / tokens / failed columns when the data is present). Shared by the
 * archived-task Session Summary (DB-fed) and the live ContextBar tool-call
 * popover (telemetry-fed), so the two surfaces render identically.
 */
export function ByToolTable({ rows }: ByToolTableProps) {
  const anyCost = rows.some((row) => typeof row.costUsd === 'number');
  const anyInputTokens = rows.some((row) => typeof row.inputTokens === 'number');
  const anyOutputTokens = rows.some((row) => typeof row.outputTokens === 'number');
  const anyInterrupted = rows.some((row) => row.interruptedCount > 0);

  return (
    <div
      data-testid="session-summary-by-tool"
      className="px-4 pb-3 overflow-x-auto border-t border-edge/40"
    >
      <table className="w-full text-xs tabular-nums">
        <thead>
          <tr className="text-fg-faint">
            <th className="text-left font-normal pt-2 pb-1 pr-3">Tool</th>
            <th className="text-right font-normal pt-2 pb-1 pr-3">Calls</th>
            <th className="text-right font-normal pt-2 pb-1 pr-3">Total</th>
            <th className="text-right font-normal pt-2 pb-1 pr-3">Avg</th>
            {anyCost && <th className="text-right font-normal pt-2 pb-1 pr-3">Cost</th>}
            {anyInputTokens && <th className="text-right font-normal pt-2 pb-1 pr-3">In</th>}
            {anyOutputTokens && <th className="text-right font-normal pt-2 pb-1 pr-3">Out</th>}
            {anyInterrupted && <th className="text-right font-normal pt-2 pb-1">Failed</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const totalCalls = row.callCount + row.interruptedCount;
            const averageMs = totalCalls > 0 ? Math.round(row.totalDurationMs / totalCalls) : 0;
            return (
              <tr key={row.toolName} className="border-t border-edge/40">
                <td className="py-1 pr-3 text-fg-secondary font-mono max-w-[180px] truncate" title={row.toolName}>
                  {row.toolName}
                </td>
                <td className="py-1 pr-3 text-right text-fg-secondary">{row.callCount}</td>
                <td className="py-1 pr-3 text-right text-fg-secondary">{formatToolDuration(row.totalDurationMs)}</td>
                <td className="py-1 pr-3 text-right text-fg-secondary">{formatToolDuration(averageMs)}</td>
                {anyCost && (
                  <td className="py-1 pr-3 text-right text-fg-secondary">
                    {typeof row.costUsd === 'number' ? formatCost(row.costUsd) : '-'}
                  </td>
                )}
                {anyInputTokens && (
                  <td className="py-1 pr-3 text-right text-fg-secondary">
                    {typeof row.inputTokens === 'number' ? formatTokenCount(row.inputTokens) : '-'}
                  </td>
                )}
                {anyOutputTokens && (
                  <td className="py-1 pr-3 text-right text-fg-secondary">
                    {typeof row.outputTokens === 'number' ? formatTokenCount(row.outputTokens) : '-'}
                  </td>
                )}
                {anyInterrupted && (
                  <td className="py-1 text-right">
                    {row.interruptedCount > 0
                      ? <span className="inline-flex items-center gap-0.5 text-amber-400/80"><AlertTriangle size={10} />{row.interruptedCount}</span>
                      : <span className="text-fg-disabled">-</span>}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
