import { useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useBoardStore } from '../../stores/board-store';
import { useConfigStore } from '../../stores/config-store';
import { ContextBarPopover } from './ContextBarPopover';

const pill = 'px-2 py-0.5 rounded bg-surface-raised whitespace-nowrap select-none';

interface ModelEffortPickerProps {
  taskId: string;
  /** Agent name used to resolve `AgentCapabilities` (models / effortLevels / supportsModelOverride). */
  agent: string | null;
  /** Live model display name when the agent is running. Pre-spawn callers pass null. */
  liveModelName?: string | null;
  /** Live model ID for option matching (the canonical CLI value, e.g. `claude-opus-4-7`). */
  liveModelId?: string | null;
  /** Live effort tier when reported by the agent. Pre-spawn callers pass null. */
  liveEffort?: string | null;
  /**
   * `live`: hide the effort pill when no current value (matches today's
   * ContextBar behaviour - hiding agent state we don't have).
   * `prespawn`: always show pills when their capability is supported, with
   * `Default` placeholders so the user can pick before first spawn.
   */
  mode: 'live' | 'prespawn';
}

/**
 * Capability-gated model + effort pill row used by the ContextBar (live) and
 * PreSpawnContextBar (pre-spawn). All gating is via `AgentCapabilities` flags
 * exposed by the adapter - no agent-name branching in the renderer.
 *
 * Selecting a value calls the existing `setTaskRuntimeOverride` store action.
 * The IPC handler short-circuits to `mode: 'persisted'` when there's no live
 * session, so the same code path works for both live and pre-spawn writes.
 */
export function ModelEffortPicker({
  taskId,
  agent,
  liveModelName = null,
  liveModelId = null,
  liveEffort = null,
  mode,
}: ModelEffortPickerProps) {
  const task = useBoardStore((s) => s.tasks.find((t) => t.id === taskId));
  const swimlaneModelOverride = useBoardStore((s) =>
    task ? s.swimlanes.find((lane) => lane.id === task.swimlane_id)?.model_override ?? null : null,
  );
  const swimlaneEffortOverride = useBoardStore((s) =>
    task ? s.swimlanes.find((lane) => lane.id === task.swimlane_id)?.effort_override ?? null : null,
  );
  const setTaskRuntimeOverride = useBoardStore((s) => s.setTaskRuntimeOverride);
  const agentCapabilities = useConfigStore(
    (s) => s.agentList.find((a) => a.name === agent)?.capabilities,
  );

  const [openPopover, setOpenPopover] = useState<'model' | 'effort' | null>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const effortTriggerRef = useRef<HTMLButtonElement>(null);

  if (!task) return null;

  const modelOptions = agentCapabilities?.models ?? [];
  const effortOptions = agentCapabilities?.effortLevels ?? [];
  const supportsModel = !!agentCapabilities?.supportsModelOverride && modelOptions.length > 0;
  const supportsEffort = effortOptions.length > 0;

  const taskModelOverride = task.model_override ?? null;
  const taskEffortOverride = task.effort_override ?? null;
  // Effort fallback chain: live status (truth) -> task override -> swimlane
  // override. Some Claude models (Haiku 4.5) accept --effort but never echo
  // it back in status updates, so without this chain the pill stays blank
  // even though the user explicitly configured an effort tier.
  const effectiveEffort = liveEffort ?? taskEffortOverride ?? swimlaneEffortOverride;

  // Display labels:
  // - live mode: existing behavior (live > overrides; effort pill suppressed when null)
  // - prespawn: show overrides falling through to "Default" so users can click to pick
  const modelLabel = liveModelName ?? taskModelOverride ?? swimlaneModelOverride ?? 'Default';
  const showModelTrigger = supportsModel;
  const showEffortTrigger = supportsEffort && (mode === 'prespawn' || effectiveEffort != null);
  const effortLabel = effectiveEffort ?? 'Default';

  // Resolve checkmark target: live ID match > task override.
  const currentModelValue = (liveModelId ? modelOptions.find((id) => id === liveModelId) : undefined)
    ?? taskModelOverride
    ?? null;
  const currentEffortValue = effectiveEffort ?? null;

  const triggerBase = `${pill} text-fg-muted inline-flex items-center gap-1`;
  const interactiveBase = 'cursor-pointer hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-fg-faint';

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
            {modelLabel}
            <ChevronDown size={11} className="text-fg-faint flex-shrink-0" />
          </button>
          {openPopover === 'model' && (
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
        liveModelName && <span className={`${pill} text-fg-muted`}>{liveModelName}</span>
      )}
      {showEffortTrigger ? (
        <span className="relative inline-flex">
          <button
            ref={effortTriggerRef}
            type="button"
            onClick={() => setOpenPopover((previous) => (previous === 'effort' ? null : 'effort'))}
            className={`${triggerBase} ${interactiveBase} text-fg-faint`}
            data-testid="context-bar-effort-trigger"
            title="Click to change effort"
          >
            {effortLabel}
            <ChevronDown size={11} className="flex-shrink-0" />
          </button>
          {openPopover === 'effort' && (
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
      ) : (
        effectiveEffort && (
          <span className={`${pill} text-fg-faint`}>{effectiveEffort}</span>
        )
      )}
    </>
  );
}
