import React, { useEffect, useRef } from 'react';
import { Check } from 'lucide-react';
import { usePopoverPosition } from '../../hooks/usePopoverPosition';

/**
 * Enumeration-only popover for the ContextBar model and effort triggers.
 * Lists the options reported by the agent's `discoverCapabilities` (e.g.
 * Claude's `models = ['opus','sonnet','haiku']` or `effortLevels =
 * ['low','medium','high','xhigh','max']`), checkmarks the current value,
 * and includes a final "Use column default" item that clears the per-task
 * override (passes `null` to `onSelect`).
 *
 * Recovery contract: this popover never accepts free-form text. The user
 * cannot enter an invalid model/effort string and end up in a CLI that
 * refuses to start. Combined with the handler's suspend-not-kill restart
 * fallback, every selection is recoverable - if the new model fails, the
 * user just opens the popover again and picks a different one.
 *
 * Outside-click and Escape both close. Escape uses capture-phase + stop
 * propagation so the parent task-detail dialog doesn't also dismiss.
 */
export function ContextBarPopover({
  triggerRef,
  title,
  options,
  currentValue,
  swimlaneDefault,
  onSelect,
  onClose,
  testId,
}: {
  triggerRef: React.RefObject<HTMLElement | null>;
  title: string;
  options: ReadonlyArray<{ value: string; label: string; hint?: string }>;
  /** The currently active value (live status > task override > swimlane override). Checkmark is rendered next to this. */
  currentValue: string | null;
  /**
   * The swimlane's override for this field, if any. Drives the bottom-row
   * copy: when present we show "Use column default (X)" and the click can
   * live-apply via slash; when null we show "Clear override" with a hint
   * that it only takes effect on next spawn (no slash command for "agent
   * default" exists, so the live session keeps its current value).
   */
  swimlaneDefault: string | null;
  /** Called with the picked value, or `null` for "Use column default" (clears the per-task override). */
  onSelect: (value: string | null) => void;
  onClose: () => void;
  testId?: string;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  // The ContextBar is always pinned to the bottom of its container (task-detail
  // dialog, bottom panel, or the floating command-terminal overlay). Prefer
  // opening upward so the menu never renders past a floating container's bottom
  // edge (which clips it) even when there is viewport room below the trigger.
  const { style: popoverStyle } = usePopoverPosition(triggerRef, popoverRef, true, { mode: 'dropdown', preferVertical: 'above' });

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        popoverRef.current && !popoverRef.current.contains(event.target as Node) &&
        triggerRef.current && !triggerRef.current.contains(event.target as Node)
      ) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClickOutside, true);
    return () => document.removeEventListener('mousedown', handleClickOutside, true);
  }, [onClose, triggerRef]);

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', handleEscape, true);
    return () => document.removeEventListener('keydown', handleEscape, true);
  }, [onClose]);

  return (
    <div
      ref={popoverRef}
      style={popoverStyle}
      // `w-max` sizes to the widest row so long model ids
      // (e.g. `claude-haiku-4-5-20251001`) stay on one line; short option
      // sets like effort levels ("low" .. "max") stay snug. The max-w caps
      // pathological CLI-reported names with ellipsis truncation so they
      // can't push the popover off-screen; the full value still surfaces in
      // the button's title attribute.
      className="absolute z-50 bg-surface-raised border border-edge rounded-lg shadow-xl py-1 w-max max-w-[420px] max-h-[340px] overflow-y-auto"
      data-testid={testId}
    >
      <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
        {title}
      </div>
      {options.map((option) => {
        const isCurrent = option.value === currentValue;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onSelect(option.value)}
            title={option.value}
            // Click target sizing: `py-2` + `text-sm` ≈ 38px tall (above WCAG
            // 2.5.5 AA's 24px floor and close to AAA's 44px). `min-w-[180px]`
            // keeps short option lists like effort (`low`..`max`) from
            // collapsing to a 60px-wide target. Long model ids still grow
            // the popover past this floor via the parent's `w-max`.
            className="w-full min-w-[180px] px-3 py-2 text-sm text-fg-secondary text-left hover:bg-surface-hover/40 flex items-center gap-2 whitespace-nowrap"
            data-testid={testId ? `${testId}-option-${option.value}` : undefined}
          >
            <Check size={12} className={`flex-shrink-0 ${isCurrent ? 'text-fg-secondary' : 'text-transparent'}`} />
            <span className="flex-1 truncate">{option.label}</span>
            {option.hint && <span className="text-fg-faint text-xs flex-shrink-0">{option.hint}</span>}
          </button>
        );
      })}
      {swimlaneDefault !== null && (
        // Only show "Use column default" when the column actually has a
        // default to revert to. When the column is on Auto/agent-default,
        // clicking would silently persist `null` without changing the live
        // session - confusing UX. Users with a per-task pin can still pick
        // any specific value from the list above to "revert".
        <div className="border-t border-edge mt-1 pt-1">
          <button
            type="button"
            onClick={() => onSelect(null)}
            title={swimlaneDefault}
            className="w-full min-w-[180px] px-3 py-2 text-xs text-fg-faint text-left hover:bg-surface-hover/40 flex items-center gap-2 whitespace-nowrap"
            data-testid={testId ? `${testId}-option-clear` : undefined}
          >
            <Check size={12} className={`flex-shrink-0 ${currentValue === null ? 'text-fg-secondary' : 'text-transparent'}`} />
            <span className="flex-1 truncate">Use column default <span className="text-fg-disabled">({swimlaneDefault})</span></span>
          </button>
        </div>
      )}
    </div>
  );
}
