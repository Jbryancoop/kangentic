import { useRef, useState } from 'react';
import { ArrowUp, ArrowDown, Loader2, Clock, Calendar, ChevronDown } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { RateLimitWindow } from '../../../shared/types';
import { useBoardStore } from '../../stores/board-store';
import { useSessionStore } from '../../stores/session-store';
import { useConfigStore } from '../../stores/config-store';
import { getProgressColor } from '../../utils/color-lerp';
import { formatTokenCount } from '../../utils/format-tokens';
import { formatCost, formatDuration } from '../../utils/format-session';
import { formatDateTime, formatTime } from '../../lib/datetime';
import { agentDisplayName } from '../../utils/agent-display-name';
import { shellDisplayName } from '../../utils/shell-display-name';
import { useValuePulse } from '../../hooks/useValuePulse';
import { ContextBarPopover } from './ContextBarPopover';

interface ContextBarProps {
  sessionId: string;
  /** Fallback agent identifier when the session has no task row (e.g. transient command-terminal sessions). */
  agentFallback?: string | null;
}

const pill = 'px-2 py-0.5 rounded bg-surface-raised whitespace-nowrap select-none';
const containerClass = 'min-h-8 bg-surface/80 border-t border-edge flex flex-wrap items-center px-3 py-1.5 gap-x-2 gap-y-2 text-xs flex-shrink-0';

function formatResetTime(epochSeconds: number): string {
  const ms = epochSeconds * 1000 - Date.now();
  if (ms <= 0) return 'Resets now';
  if (ms < 24 * 60 * 60 * 1000) return `Resets in ${formatDuration(ms)}`;
  return `Resets ${formatDateTime(epochSeconds * 1000)}`;
}

// Maps adapter-declared RateLimitWindow.iconKind to a Lucide icon. The visual
// vocabulary lives here in the renderer so adapters declare semantics, not chrome.
const RATE_LIMIT_ICON: Record<RateLimitWindow['iconKind'], LucideIcon> = {
  session: Clock,
  period: Calendar,
};

/**
 * Visual context window usage bar displayed below terminal areas. Same
 * content in both surfaces (task detail dialog and bottom panel) -
 * per-cell visibility is controlled by `contextBar.show*` settings, except
 * model/effort which are permanent (they double as the in-place picker
 * triggers, so a hide toggle would silently disable a feature).
 *
 * A fraction pill (e.g. "28k / 200k") shows absolute context usage.
 * Tooltip on the progress bar shows cache vs conversation breakdown.
 */
export function ContextBar({ sessionId, agentFallback = null }: ContextBarProps) {
  const usage = useSessionStore((s) => s.sessionUsage[sessionId]);
  const latestRateLimits = useSessionStore((s) => s.latestRateLimits);
  const session = useSessionStore((s) => s.sessions.find((sess) => sess.id === sessionId));
  const sessionShell = session?.shell;
  const isResuming = session?.resuming ?? false;
  const task = useBoardStore((s) => s.tasks.find((t) => t.session_id === sessionId));
  const taskAgent = task?.agent ?? agentFallback;
  const setTaskRuntimeOverride = useBoardStore((s) => s.setTaskRuntimeOverride);
  // Effort fallback chain: live status (truth) -> task override -> swimlane
  // override. Some Claude models (Haiku 4.5) accept --effort but never echo
  // it back in status updates, so without this chain the pill stays blank
  // even though the user explicitly configured an effort tier.
  const taskEffortOverride = task?.effort_override ?? null;
  const swimlaneEffortOverride = useBoardStore((s) =>
    task ? s.swimlanes.find((lane) => lane.id === task.swimlane_id)?.effort_override ?? null : null,
  );
  const swimlaneModelOverride = useBoardStore((s) =>
    task ? s.swimlanes.find((lane) => lane.id === task.swimlane_id)?.model_override ?? null : null,
  );
  const taskEffortFallback = taskEffortOverride ?? swimlaneEffortOverride;
  // Resolve the agent that contributed the latest rate-limit snapshot so the
  // tooltip can name it. Falls back to undefined when the source session has
  // no task row (e.g. transient command-terminal sessions).
  const sourceAgent = useBoardStore((s) =>
    latestRateLimits ? s.tasks.find((t) => t.session_id === latestRateLimits.sourceSessionId)?.agent : undefined,
  );
  const agentVersionNumber = useConfigStore((s) => s.agentVersionNumber);
  const contextBarConfig = useConfigStore((s) => s.config.contextBar);
  // Adapter-declared affordance for agents whose CLI exposes no live-telemetry
  // channel. Label and tooltip live with the adapter (see AgentAdapter.liveTelemetryUnsupported);
  // this component never branches on agent name.
  const agentLiveTelemetryUnsupported = useConfigStore(
    (s) => s.agentList.find((a) => a.name === taskAgent)?.liveTelemetryUnsupported
  );
  // Capabilities from `discoverCapabilities` -- gates the popover triggers.
  // No agent-name branching: the model trigger is shown iff the adapter
  // returned a non-empty `models` array, and the effort trigger iff
  // `effortLevels` is non-empty. Adapters without discovery render the
  // pills as static labels, exactly as before.
  const agentCapabilities = useConfigStore(
    (s) => s.agentList.find((a) => a.name === taskAgent)?.capabilities,
  );

  // Popover state. One of the two triggers is open at a time; tracked here
  // so opening the model picker auto-closes the effort picker.
  const [openPopover, setOpenPopover] = useState<'model' | 'effort' | null>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const effortTriggerRef = useRef<HTMLButtonElement>(null);

  // Pulse hooks -- always called unconditionally (hooks rules)
  const costRef = useValuePulse(usage?.cost.totalCostUsd);
  const inputTokens = usage?.contextWindow.totalInputTokens;
  const outputTokens = usage?.contextWindow.totalOutputTokens;
  const tokenKey = `${inputTokens}-${outputTokens}`;
  const tokenRef = useValuePulse(tokenKey);
  const pctRef = useValuePulse(usage ? Math.round(usage.contextWindow.usedPercentage) : 0);
  const fractionRef = useValuePulse(usage?.contextWindow.usedTokens);
  const rateLimitsKey = latestRateLimits
    ? latestRateLimits.rateLimits.map((limitWindow) => `${limitWindow.id}:${Math.round(limitWindow.usedPercentage)}`).join('|')
    : '';
  const rateLimitsRef = useValuePulse(rateLimitsKey);

  // Model is "resolved" only when the CLI status line has reported a real
  // displayName. Until then we show a single spinner pill instead of flashing
  // through "Agent" -> "Claude" -> "Opus 4.6 (1M Context)" as data trickles in.
  const resolvedModelName = usage?.model.displayName || null;

  if (!usage || !resolvedModelName) {
    // Adapter-declared "no live telemetry" branch. The spinner would otherwise
    // display forever for these agents - show the adapter's static affordance
    // instead. Branching on a generic capability flag (not agent name) keeps
    // agent-specific copy inside src/main/agent/adapters/<agent>/.
    if (agentLiveTelemetryUnsupported) {
      return (
        <div
          className={containerClass}
          data-testid="usage-bar"
          data-live-telemetry="unsupported"
        >
          <span
            className={`${pill} text-fg-muted`}
            title={agentLiveTelemetryUnsupported.unavailableTitle}
          >
            {agentLiveTelemetryUnsupported.unavailableLabel}
          </span>
        </div>
      );
    }
    const spinnerLabel = isResuming ? 'Resuming agent...' : 'Starting agent...';
    return (
      <div
        className={containerClass}
        data-testid="usage-bar"
      >
        <span className={`${pill} text-fg-muted flex items-center gap-1.5`}>
          <Loader2 size={12} className="animate-spin" />
          {spinnerLabel}
        </span>
      </div>
    );
  }

  const pct = Math.round(usage.contextWindow.usedPercentage);
  const progressColor = getProgressColor(pct);

  const modelName = resolvedModelName;

  // Fallback to 0 for fields that may be absent from older main-process sessions
  const usedTokens = usage.contextWindow.usedTokens ?? 0;
  const cacheTokens = usage.contextWindow.cacheTokens ?? 0;
  const { contextWindowSize } = usage.contextWindow;

  const barTooltip = `${formatTokenCount(cacheTokens)} cached (system) \u00b7 ${formatTokenCount(Math.max(0, usedTokens - cacheTokens))} conversation`;

  // Determine which elements are visible. The settings toggles are the
  // single source of truth for both the task-detail and bottom-panel
  // surfaces - we no longer suppress fields based on `compact`. Users who
  // want a leaner bottom panel can flip the toggles off; users who enable
  // them get the same info in both places (feature parity).
  const showShell = !!sessionShell && contextBarConfig.showShell;
  const showVersion = contextBarConfig.showVersion;
  // Model + Effort are always shown when usage is present - they double as
  // the in-place model/effort picker triggers, so a "hide" toggle would
  // silently disable a feature, not just declutter chrome.
  const showCost = contextBarConfig.showCost;
  const showTokens = contextBarConfig.showTokens;
  const showFraction = contextBarConfig.showContextFraction;
  const showProgressBar = contextBarConfig.showProgressBar;
  // Visibility gate stays per-session: only adapters that ever populated
  // rateLimits (currently Claude) earn the pill. The displayed *value* comes
  // from the global `latestRateLimits` snapshot so every agent in the window
  // shows the freshest account-wide numbers, not its own stale ones.
  const showRateLimits = !!usage.rateLimits && usage.rateLimits.length > 0
    && !!latestRateLimits && latestRateLimits.rateLimits.length > 0
    && contextBarConfig.showRateLimits;

  // No empty-state early-return: model pill is permanent (it doubles as
  // the picker trigger), so the bar always has at least one cell of content
  // by the time we reach this point.

  return (
    <div
      className={containerClass}
      data-testid="usage-bar"
    >
      {showShell && (
        <span className={`${pill} text-fg-faint`} title={sessionShell as string}>
          {shellDisplayName(sessionShell as string)}
        </span>
      )}
      {showVersion && (
        <span className={`${pill} text-fg-muted`}>
          {agentDisplayName(taskAgent)}
          {agentVersionNumber && (
            <span className="text-fg-faint ml-1.5">v{agentVersionNumber}</span>
          )}
        </span>
      )}
      {(() => {
        // Effort source order: live status (truth) -> task override -> column
        // override. Falling back covers Claude models that accept --effort
        // but do not echo it in status JSON (e.g. Haiku 4.5).
        const effectiveEffort = usage.model.effort || taskEffortFallback;
        const modelOptions = agentCapabilities?.models ?? [];
        const effortOptions = agentCapabilities?.effortLevels ?? [];
        const showModelTrigger = !!task && agentCapabilities?.supportsModelOverride && modelOptions.length > 0;
        const showEffortTrigger = !!task && effortOptions.length > 0;
        const triggerBase = `${pill} text-fg-muted inline-flex items-center gap-1`;
        const interactiveBase = 'cursor-pointer hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-fg-faint';
        // Resolve the "current" value the popover should checkmark. For the
        // model picker we use the live displayName when it matches a known
        // option, otherwise the task override; same fallback chain for effort.
        const currentModelValue = modelOptions.find((id) => id === usage.model.id)
          ?? task?.model_override
          ?? null;
        const currentEffortValue = effectiveEffort ?? null;
        return (
          <>
            {showModelTrigger ? (
              <span className="relative inline-flex">
                <button
                  ref={modelTriggerRef}
                  type="button"
                  onClick={() => setOpenPopover((previous) => (previous === 'model' ? null : 'model'))}
                  className={`${triggerBase} ${interactiveBase}`}
                  data-testid="context-bar-model-trigger"
                  title="Click to change model"
                >
                  {modelName}
                  <ChevronDown size={11} className="text-fg-faint flex-shrink-0" />
                </button>
                {openPopover === 'model' && task && (
                  <ContextBarPopover
                    triggerRef={modelTriggerRef}
                    title="Model"
                    options={modelOptions.map((value) => ({ value, label: value }))}
                    currentValue={currentModelValue}
                    swimlaneDefault={swimlaneModelOverride}
                    onSelect={(value) => {
                      setOpenPopover(null);
                      setTaskRuntimeOverride(task.id, { model: value });
                    }}
                    onClose={() => setOpenPopover(null)}
                    testId="context-bar-model-popover"
                  />
                )}
              </span>
            ) : (
              <span className={`${pill} text-fg-muted`}>{modelName}</span>
            )}
            {showEffortTrigger ? (
              effectiveEffort && (
                <span className="relative inline-flex">
                  <button
                    ref={effortTriggerRef}
                    type="button"
                    onClick={() => setOpenPopover((previous) => (previous === 'effort' ? null : 'effort'))}
                    className={`${triggerBase} ${interactiveBase} text-fg-faint`}
                    data-testid="context-bar-effort-trigger"
                    title="Click to change effort"
                  >
                    {effectiveEffort}
                    <ChevronDown size={11} className="flex-shrink-0" />
                  </button>
                  {openPopover === 'effort' && task && (
                    <ContextBarPopover
                      triggerRef={effortTriggerRef}
                      title="Effort"
                      options={effortOptions.map((value) => ({ value, label: value }))}
                      currentValue={currentEffortValue}
                      swimlaneDefault={swimlaneEffortOverride}
                      onSelect={(value) => {
                        setOpenPopover(null);
                        setTaskRuntimeOverride(task.id, { effort: value });
                      }}
                      onClose={() => setOpenPopover(null)}
                      testId="context-bar-effort-popover"
                    />
                  )}
                </span>
              )
            ) : (
              effectiveEffort && (
                <span className={`${pill} text-fg-faint`}>{effectiveEffort}</span>
              )
            )}
          </>
        );
      })()}
      {showRateLimits && latestRateLimits && (() => {
        const rateLimits = latestRateLimits.rateLimits;
        const sourceLabel = sourceAgent ? ` via ${agentDisplayName(sourceAgent)}` : '';
        const updatedSuffix = `\nUpdated ${formatTime(latestRateLimits.capturedAt)}${sourceLabel}`;
        const tooltipBody = rateLimits
          .map((limitWindow) => `${limitWindow.label}: ${formatResetTime(limitWindow.resetsAt)}`)
          .join('\n');
        return (
          <span
            ref={rateLimitsRef}
            className={`${pill} text-fg-muted tabular-nums flex items-center gap-2 flex-1 basis-0 min-w-[220px]`}
            title={`${tooltipBody}${updatedSuffix}`}
            data-testid="rate-limits-pill"
          >
            {rateLimits.map((limitWindow) => {
              const Icon = RATE_LIMIT_ICON[limitWindow.iconKind];
              const pctRow = Math.round(limitWindow.usedPercentage);
              return (
                <span key={limitWindow.id} className="flex items-center gap-1.5 flex-1 min-w-0">
                  <Icon size={11} className="text-fg-faint flex-shrink-0" aria-label={limitWindow.label} />
                  <span className="flex-1 min-w-[40px] h-1.5 bg-surface-hover rounded-full overflow-hidden">
                    <span
                      className="block h-full rounded-full transition-[width,background-color] duration-300"
                      style={{
                        width: `${Math.min(pctRow, 100)}%`,
                        minWidth: pctRow > 0 ? '2px' : undefined,
                        backgroundColor: getProgressColor(pctRow),
                      }}
                    />
                  </span>
                  <span className="flex-shrink-0">{pctRow}%</span>
                </span>
              );
            })}
          </span>
        );
      })()}
      {showCost && <span ref={costRef} className={`${pill} text-fg-muted tabular-nums`} title="Session API cost">{formatCost(usage.cost.totalCostUsd)}</span>}

      {showTokens && (
        <span ref={tokenRef} className={`${pill} text-fg-muted tabular-nums flex items-center gap-3`} title="Input / output tokens">
          <span className="flex items-center gap-1">
            <ArrowUp size={11} className="text-fg-faint" />
            {formatTokenCount(usage.contextWindow.totalInputTokens)}
          </span>
          <span className="flex items-center gap-1">
            <ArrowDown size={11} className="text-fg-faint" />
            {formatTokenCount(usage.contextWindow.totalOutputTokens)}
          </span>
        </span>
      )}

      {showFraction && (
        <span ref={fractionRef} className={`${pill} text-fg-muted tabular-nums`} title="Context tokens used / total window size">
          {formatTokenCount(usedTokens)} / {formatTokenCount(contextWindowSize)}
        </span>
      )}

      {showProgressBar && (
        <div className={`${pill} text-fg-muted flex items-center gap-2 flex-1 basis-0 min-w-[160px]`}>
          <div className="flex-1 h-1.5 bg-surface-hover rounded-full overflow-hidden" title={barTooltip}>
            <div
              className="h-full rounded-full transition-[width,background-color] duration-300"
              style={{ width: `${Math.min(pct, 100)}%`, backgroundColor: progressColor }}
            />
          </div>
          <span ref={pctRef} className="tabular-nums text-fg-faint whitespace-nowrap transition-colors duration-300" title={`${100 - pct}% remaining`}>{pct}% context</span>
        </div>
      )}
    </div>
  );
}
