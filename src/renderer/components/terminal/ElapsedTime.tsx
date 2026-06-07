import { useEffect, useState } from 'react';
import { formatDuration } from '../../utils/format-session';

interface ElapsedTimeProps {
  /** ISO 8601 timestamp the session started at; the count is `now - startedAt`. */
  startedAt: string;
  className?: string;
}

/**
 * Ticking wall-clock elapsed time since `startedAt`.
 *
 * Isolated in its own leaf component so the 1s interval re-renders only this
 * text node, not the whole ContextBar (which would otherwise recompute the
 * model picker, progress bar, and rate-limit math every second). The interval
 * is component-local and cleared on unmount, so it needs no HMR Pattern A
 * preservation (see .claude/rules/hmr-patterns.md).
 */
export function ElapsedTime({ startedAt, className }: ElapsedTimeProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const intervalId = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(intervalId);
  }, []);

  const startMs = Date.parse(startedAt);
  const elapsedMs = Number.isNaN(startMs) ? 0 : Math.max(0, now - startMs);

  // Auto width (content-sized). The cell is placed last in the ContextBar, so
  // its per-second growth is absorbed by the flex-1 progress pill to its left
  // and never reflows the other cells - no fixed-width reservation needed.
  // tabular-nums keeps the digits from jittering as they change.
  return <span className={`tabular-nums ${className ?? ''}`}>{formatDuration(elapsedMs)}</span>;
}
