import { memo, useMemo } from 'react';
import type { ActivityStatsSnapshot, ActivityState, SessionEvent } from '../../../shared/types';
import { EventType } from '../../../shared/types';

/**
 * Horizontal timeline + compensation counter strip for one session in
 * the Activity Debug Overlay. Renders four tracks over the last 120s
 * of session activity with a left gutter for row labels, a top time
 * axis (-120s … -60s … now), gridlines at 30s intervals, and a "now"
 * marker on the right edge. The intent is "glance at the chart, see
 * where the gaps are, see what fired during them".
 *
 * Tracks (top → bottom):
 *   state  - color band (idle / thinking / permission)
 *   events - vertical ticks colored by EventType group
 *   pty    - subtle ticks; opacity scales with bucket count
 *   timer  - active watchdog deadline line + dashed deadline marker.
 *            Label matches the engine's `timer:*` trigger prefix
 *            (timer:stale-thinking, timer:bg-shell-hatch,
 *            timer:stuck-pending-tools) so non-zero compensation
 *            counters tie visually to the same row.
 *
 * The counter strip above tallies recovery / compensation events
 * (`stale-thinking ×N`, `force-thinking ×N`, …). All zeros = clean
 * session. Non-zero is a "click into the timeline to see what
 * happened" cue.
 *
 * Hand-coded SVG (no charting deps) so production builds stay slim.
 */

const WINDOW_MS = 120_000;
const TRACK_HEIGHT_PX = 18;
const TRACK_GAP_PX = 4;
const GUTTER_WIDTH_PX = 36;
const TIMELINE_HEIGHT_PX = TRACK_HEIGHT_PX * 4 + TRACK_GAP_PX * 3; // 84

type EventGroup = 'tool' | 'subagent' | 'background-shell' | 'idle' | 'interrupted' | 'log-only';

const EVENT_GROUP_COLORS: Record<EventGroup, string> = {
  tool: '#22c55e',
  subagent: '#a855f7',
  'background-shell': '#f97316',
  idle: '#94a3b8',
  interrupted: '#ef4444',
  'log-only': '#cbd5e1',
};

const ACTIVITY_BAND_COLORS: Record<ActivityState, string> = {
  idle: 'rgba(148, 163, 184, 0.25)',
  thinking: 'rgba(245, 158, 11, 0.45)',
  permission: 'rgba(59, 130, 246, 0.45)',
};

function classifyEvent(eventType: string): EventGroup {
  switch (eventType) {
    case EventType.ToolStart:
    case EventType.ToolEnd:
    case EventType.ToolSelectionStart:
      return 'tool';
    case EventType.SubagentStart:
    case EventType.SubagentStop:
      return 'subagent';
    case EventType.BackgroundShellStart:
    case EventType.BackgroundShellEnd:
      return 'background-shell';
    case EventType.Idle:
      return 'idle';
    case EventType.Interrupted:
      return 'interrupted';
    default:
      return 'log-only';
  }
}

interface WatchdogPick {
  thresholdMs: number;
  shortLabel: string;
}

/**
 * Pick the watchdog hold that currently applies, mirroring
 * `findActiveWatchdogHold` in the engine. We re-derive it in the
 * renderer from the snapshot's predicate fields - the engine doesn't
 * surface "active hold" directly, and adding that would clutter the
 * snapshot type. If the engine adds a fourth hold or reorders
 * predicates, update here too. Thresholds match the engine's defaults.
 */
function pickWatchdog(snapshot: ActivityStatsSnapshot): WatchdogPick | null {
  if (snapshot.activity !== 'thinking') return null;
  if (snapshot.permissionPending) return null;
  const bgShells = snapshot.backgroundShellIds.length + snapshot.anonymousBackgroundShellCount;

  if (
    !snapshot.turnActive
    && snapshot.pendingToolCount === 0
    && snapshot.subagentDepth === 0
    && bgShells > 0
  ) {
    return { thresholdMs: 5 * 60_000, shortLabel: 'bg-shell-hatch 5m' };
  }
  if (
    snapshot.pendingToolCount > 0
    && snapshot.subagentDepth === 0
    && bgShells === 0
  ) {
    return { thresholdMs: 5 * 60_000, shortLabel: 'stuck-pending-tools 5m' };
  }
  if (
    snapshot.turnActive
    && snapshot.pendingToolCount === 0
    && snapshot.subagentDepth === 0
    && bgShells === 0
  ) {
    return { thresholdMs: 180_000, shortLabel: 'stale-thinking 180s' };
  }
  return null;
}

const COUNTER_LABELS: Record<keyof ActivityStatsSnapshot['compensationCounters'], string> = {
  staleThinking: 'stale-thinking',
  bgShellHatch: 'bg-shell-hatch',
  stuckPendingTools: 'stuck-pending-tools',
  forceThinking: 'force-thinking',
  forceIdle: 'force-idle',
};

interface ActivityTimelineProps {
  snapshot: ActivityStatsSnapshot;
  sessionEvents: SessionEvent[] | undefined;
}

export const ActivityTimeline = memo(function ActivityTimeline({
  snapshot,
  sessionEvents,
}: ActivityTimelineProps) {
  // Anchor the window at the snapshot's poll time. Date.now() is fine
  // here - the snapshot is at most 2s old (poll interval) so the
  // visual drift is invisible at our scale.
  const now = Date.now();
  const windowStart = now - WINDOW_MS;

  // Reconstruct activity bands from recentTransitions.
  const bands = useMemo(() => {
    const out: { start: number; end: number; state: ActivityState }[] = [];
    const transitions = snapshot.recentTransitions.filter((record) => record.from !== record.to);
    if (transitions.length === 0) {
      out.push({ start: windowStart, end: now, state: snapshot.activity });
      return out;
    }
    const firstTransition = transitions[0];
    out.push({
      start: windowStart,
      end: Math.max(windowStart, firstTransition.ts),
      state: firstTransition.from,
    });
    for (let index = 0; index < transitions.length; index += 1) {
      const segment = transitions[index];
      const next = transitions[index + 1];
      out.push({
        start: Math.max(windowStart, segment.ts),
        end: next ? Math.max(windowStart, next.ts) : now,
        state: segment.to,
      });
    }
    return out.filter((band) => band.end > band.start);
  }, [snapshot.recentTransitions, snapshot.activity, windowStart, now]);

  const eventTicks = useMemo(() => {
    if (!sessionEvents) return [];
    return sessionEvents
      .filter((event) => event.ts >= windowStart && event.ts <= now)
      .map((event) => ({
        ts: event.ts,
        group: classifyEvent(event.type),
        type: event.type,
      }));
  }, [sessionEvents, windowStart, now]);

  const maxChunkCount = useMemo(() => {
    let max = 1;
    for (const entry of snapshot.recentPtyChunks) {
      if (entry.tsBucket >= windowStart && entry.count > max) max = entry.count;
    }
    return max;
  }, [snapshot.recentPtyChunks, windowStart]);

  const watchdog = useMemo(() => pickWatchdog(snapshot), [snapshot]);

  const counterEntries = useMemo(() => {
    const counters = snapshot.compensationCounters;
    return (Object.keys(COUNTER_LABELS) as Array<keyof typeof COUNTER_LABELS>).map((key) => ({
      key,
      label: COUNTER_LABELS[key],
      count: counters[key],
    }));
  }, [snapshot.compensationCounters]);

  const viewWidth = 1000;
  const plotWidth = viewWidth - GUTTER_WIDTH_PX;
  const tsToX = (timestamp: number): number => {
    const fraction = (timestamp - windowStart) / WINDOW_MS;
    const clamped = Math.max(0, Math.min(1, fraction));
    return GUTTER_WIDTH_PX + clamped * plotWidth;
  };
  const trackY = (index: number): number => index * (TRACK_HEIGHT_PX + TRACK_GAP_PX);

  // Track labels mirror the engine's vocabulary: "state" matches
  // `state.activity`, "events" matches the JSONL event stream, "pty"
  // matches the PTY chunk path, and "timer" matches the engine's
  // `timer:*` trigger prefix (timer:stale-thinking, timer:bg-shell-
  // hatch, timer:stuck-pending-tools) so a non-zero compensation
  // counter ties visually to the same row.
  const trackLabels = ['state', 'events', 'pty', 'timer'];
  const axisTicks = [120, 90, 60, 30, 0];

  return (
    <div className="space-y-1.5 pt-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wider font-medium text-fg-faint">
          Compensations
        </span>
        <span className="text-[10px] text-fg-disabled tabular-nums" title="Last 120s">
          120s window
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {counterEntries.map((entry) => (
          <span
            key={entry.key}
            className={
              'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-mono ' +
              (entry.count > 0
                ? 'border-edge bg-surface-raised text-fg-secondary'
                : 'border-edge-faint bg-surface text-fg-disabled')
            }
            title={
              entry.count > 0
                ? `${entry.label} fired ${entry.count} time${entry.count === 1 ? '' : 's'} this session`
                : `${entry.label} - no firings yet`
            }
          >
            {entry.label}
            <span className="tabular-nums">×{entry.count}</span>
          </span>
        ))}
      </div>
      <svg
        viewBox={`0 0 ${viewWidth} ${TIMELINE_HEIGHT_PX + 16}`}
        preserveAspectRatio="none"
        className="w-full block"
        style={{ height: TIMELINE_HEIGHT_PX + 28 }}
        role="img"
        aria-label="Activity timeline (last 120 seconds)"
      >
        {axisTicks.slice(1, -1).map((secondsBeforeNow) => {
          const x = tsToX(now - secondsBeforeNow * 1000);
          return (
            <line
              key={`grid-${secondsBeforeNow}`}
              x1={x}
              x2={x}
              y1={0}
              y2={TIMELINE_HEIGHT_PX}
              stroke="currentColor"
              strokeWidth={0.5}
              opacity={0.15}
              strokeDasharray="2 3"
              className="text-fg-disabled"
            />
          );
        })}

        {bands.map((band, index) => (
          <rect
            key={`band-${index}`}
            x={tsToX(band.start)}
            y={trackY(0)}
            width={Math.max(1, tsToX(band.end) - tsToX(band.start))}
            height={TRACK_HEIGHT_PX}
            fill={ACTIVITY_BAND_COLORS[band.state]}
          >
            <title>{`${band.state} (${((band.end - band.start) / 1000).toFixed(1)}s)`}</title>
          </rect>
        ))}

        {eventTicks.map((tick, index) => (
          <line
            key={`event-${index}`}
            x1={tsToX(tick.ts)}
            x2={tsToX(tick.ts)}
            y1={trackY(1)}
            y2={trackY(1) + TRACK_HEIGHT_PX}
            stroke={EVENT_GROUP_COLORS[tick.group]}
            strokeWidth={1.2}
          >
            <title>{`${tick.type} @ -${((now - tick.ts) / 1000).toFixed(1)}s`}</title>
          </line>
        ))}

        {snapshot.recentPtyChunks.map((entry, index) => {
          if (entry.tsBucket < windowStart) return null;
          const opacity = Math.min(1, 0.18 + 0.82 * (entry.count / maxChunkCount));
          return (
            <line
              key={`pty-${index}`}
              x1={tsToX(entry.tsBucket)}
              x2={tsToX(entry.tsBucket)}
              y1={trackY(2)}
              y2={trackY(2) + TRACK_HEIGHT_PX}
              stroke="#64748b"
              strokeWidth={0.8}
              opacity={opacity}
            >
              <title>{`${entry.count} chunk${entry.count === 1 ? '' : 's'} in this 100ms bucket`}</title>
            </line>
          );
        })}

        {watchdog && snapshot.lastSignalAt !== null && (() => {
          const startX = tsToX(snapshot.lastSignalAt);
          const deadlineMs = snapshot.lastSignalAt + watchdog.thresholdMs;
          const deadlineX = tsToX(deadlineMs);
          const lineY = trackY(3) + TRACK_HEIGHT_PX / 2;
          const pastDeadline = deadlineMs <= now;
          return (
            <g>
              <line
                x1={startX}
                x2={deadlineX}
                y1={lineY}
                y2={lineY}
                stroke="#ea580c"
                strokeWidth={1.2}
                opacity={0.85}
              />
              <line
                x1={deadlineX}
                x2={deadlineX}
                y1={trackY(3)}
                y2={trackY(3) + TRACK_HEIGHT_PX}
                stroke="#ea580c"
                strokeWidth={1.5}
                strokeDasharray="3 2"
                opacity={pastDeadline ? 1 : 0.9}
              >
                <title>{`Timer: ${watchdog.shortLabel}. Fires at ${
                  deadlineMs > now
                    ? `+${((deadlineMs - now) / 1000).toFixed(1)}s from now`
                    : `${((now - deadlineMs) / 1000).toFixed(1)}s ago`
                }`}</title>
              </line>
            </g>
          );
        })()}

        {[1, 2, 3].map((index) => (
          <line
            key={`sep-${index}`}
            x1={GUTTER_WIDTH_PX}
            x2={viewWidth}
            y1={trackY(index) - TRACK_GAP_PX / 2}
            y2={trackY(index) - TRACK_GAP_PX / 2}
            stroke="currentColor"
            strokeWidth={0.3}
            opacity={0.18}
            className="text-fg-disabled"
          />
        ))}

        <line
          x1={viewWidth - 0.5}
          x2={viewWidth - 0.5}
          y1={0}
          y2={TIMELINE_HEIGHT_PX}
          stroke="currentColor"
          strokeWidth={1}
          opacity={0.5}
          className="text-fg-secondary"
        />

        {trackLabels.map((label, index) => (
          <text
            key={`label-${index}`}
            x={GUTTER_WIDTH_PX - 4}
            y={trackY(index) + TRACK_HEIGHT_PX / 2 + 3}
            textAnchor="end"
            fontSize={9}
            fill="currentColor"
            opacity={0.75}
            className="text-fg-faint font-mono"
            stroke="none"
          >
            {label}
          </text>
        ))}

        {axisTicks.map((secondsBeforeNow) => {
          const x = tsToX(now - secondsBeforeNow * 1000);
          const label = secondsBeforeNow === 0 ? 'now' : `-${secondsBeforeNow}s`;
          return (
            <text
              key={`axis-${secondsBeforeNow}`}
              x={x}
              y={TIMELINE_HEIGHT_PX + 12}
              textAnchor={secondsBeforeNow === 0 ? 'end' : 'middle'}
              fontSize={9}
              fill="currentColor"
              opacity={0.7}
              className="text-fg-faint font-mono"
              stroke="none"
            >
              {label}
            </text>
          );
        })}
      </svg>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-fg-disabled">
        <span>
          state:{' '}
          <span style={{ color: 'rgb(245, 158, 11)' }}>thinking</span>{' '}
          <span style={{ color: 'rgb(59, 130, 246)' }}>permission</span>
        </span>
        <span>
          events:{' '}
          <span style={{ color: EVENT_GROUP_COLORS.tool }}>tool</span>{' '}
          <span style={{ color: EVENT_GROUP_COLORS.subagent }}>subagent</span>{' '}
          <span style={{ color: EVENT_GROUP_COLORS['background-shell'] }}>bg</span>{' '}
          <span style={{ color: EVENT_GROUP_COLORS.idle }}>idle</span>{' '}
          <span style={{ color: EVENT_GROUP_COLORS.interrupted }}>int</span>
        </span>
        {watchdog ? (
          <span>
            timer:{' '}
            <span style={{ color: '#ea580c' }} title={watchdog.shortLabel}>
              {watchdog.shortLabel}
            </span>
          </span>
        ) : (
          <span>timer: idle</span>
        )}
      </div>
    </div>
  );
});
