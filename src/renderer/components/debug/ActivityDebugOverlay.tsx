import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Bug, GripVertical, X, Loader2, Mail, Lock, Wrench, Users, Terminal, ChevronDown } from 'lucide-react';
import type { ActivityStatsSnapshot, ActivityReason, ActivityState } from '../../../shared/types';
import { useConfigStore } from '../../stores/config-store';
import { useSessionStore } from '../../stores/session-store';
import { useProjectStore } from '../../stores/project-store';
import { useBoardStore } from '../../stores/board-store';
import { useToastStore } from '../../stores/toast-store';

const POLL_INTERVAL_MS = 2_000;

/**
 * Module-scoped position cache. Survives close+reopen within the same
 * JS context (HMR included) so the user does not have to re-drag on
 * every Ctrl+Shift+D toggle. `null` until the user drags - on first
 * open the overlay defaults to a centered position. Resets only on
 * full page reload.
 */
let cachedPosition: OverlayPosition | null = null;

/**
 * Floating panel showing live activity-engine state for each running
 * session in the current project. Gated by the
 * `developer.activityDebugOverlay` global setting (Developer settings
 * tab, below the shared-settings separator). Reads `globalConfig` so a
 * per-project override cannot accidentally toggle it. Polls
 * `getActivityStats` every 2 seconds while mounted.
 *
 * The outer component always mounts so the keyboard shortcut listener
 * stays installed regardless of whether the panel is currently visible.
 * Inner content is only rendered when the toggle is on.
 */
export function ActivityDebugOverlay() {
  const overlayEnabled = useConfigStore((state) => {
    const developerConfig = state.globalConfig.developer ?? {};
    return developerConfig.activityDebugOverlay === true;
  });
  const updateConfig = useConfigStore((state) => state.updateConfig);

  // Ctrl+Shift+D / Cmd+Shift+D toggles the overlay. Power-user-only,
  // not exposed in any in-app UI besides the Developer settings.
  // Truly global: no INPUT/TEXTAREA target filter (would block the
  // shortcut whenever xterm's hidden textarea has focus, which is the
  // common case while a task detail dialog is open). The modifier
  // combination ensures this can't conflict with normal typing.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (!event.shiftKey) return;
      if (event.key !== 'D' && event.key !== 'd') return;
      event.preventDefault();
      event.stopPropagation();
      const next = !overlayEnabled;
      void updateConfig({ developer: { activityDebugOverlay: next } });
      useToastStore.getState().addToast({
        message: next ? 'Activity engine debug overlay enabled' : 'Activity engine debug overlay disabled',
        variant: 'info',
      });
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [overlayEnabled, updateConfig]);

  if (!overlayEnabled) return null;
  return <ActivityDebugOverlayContent />;
}

/** Persisted across HMR + close+reopen so the overlay stays where the user dragged it. */
interface OverlayPosition {
  /** Left edge in px from window left. */
  left: number;
  /** Top edge in px from window top. */
  top: number;
}

const PANEL_WIDTH_PX = 420; // approximates max-w-md
const PANEL_MIN_HEIGHT_PX = 80;
/** Estimated panel height for initial centering. Real height is dynamic;
 *  this only affects the default landing spot. */
const PANEL_ESTIMATED_HEIGHT_PX = 300;

/**
 * Compute the default position when the overlay opens with no cached
 * position. Centers the panel on the viewport so the user sees it
 * immediately on enabling debug mode; subsequent drags persist via
 * `cachedPosition`.
 */
function computeCenteredPosition(): OverlayPosition {
  const left = Math.max(20, (window.innerWidth - PANEL_WIDTH_PX) / 2);
  const top = Math.max(20, (window.innerHeight - PANEL_ESTIMATED_HEIGHT_PX) / 2);
  return { left, top };
}

function ActivityDebugOverlayContent() {
  const sessions = useSessionStore((state) => state.sessions);
  const transientSessionId = useSessionStore((state) => state.transientSessionId);
  const tasks = useBoardStore((state) => state.tasks);
  const currentProjectId = useProjectStore((state) => state.currentProject?.id);
  const updateConfig = useConfigStore((state) => state.updateConfig);

  // The poll loop subscribes to a STABLE list of sessionIds. If we
  // depended on `sessions.filter(...)` directly, the filter result is
  // a new array every render and the effect would tear down + re-arm
  // the interval on every parent re-render (including the re-render
  // triggered by setSnapshots inside the poll itself). Memo + array-
  // identity-by-id-string flattens that into a stable dep.
  const projectSessionIds = useMemo(() => {
    return sessions
      .filter((session) => session.projectId === currentProjectId && session.status === 'running')
      .map((session) => session.id);
  }, [sessions, currentProjectId]);
  const projectSessionIdsKey = projectSessionIds.join(',');

  // Resolve a friendly label per session: "Command Terminal" for the
  // transient session, the task title for task-bound sessions, falling
  // back to the short session id.
  const sessionLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const session of sessions) {
      if (session.id === transientSessionId) {
        labels.set(session.id, 'Command Terminal');
        continue;
      }
      const task = session.taskId ? tasks.find((t) => t.id === session.taskId) : null;
      labels.set(session.id, task?.title ?? session.id.slice(0, 8));
    }
    return labels;
  }, [sessions, tasks, transientSessionId]);

  const [snapshots, setSnapshots] = useState<ActivityStatsSnapshot[]>([]);

  // Drag-to-reposition. The panel is always pixel-positioned: on first
  // open it lands centered on the viewport; subsequent drags update
  // both the React state and the module-scoped `cachedPosition` so
  // close+reopen restores the last dragged spot.
  //
  // Lag-free recipe (Windows can fire pointermove at 1000Hz):
  //   1. Position lives in a ref. The drag handler writes DOM-direct
  //      via panel.style.left/top so pointermove does NOT trigger
  //      React re-renders.
  //   2. Snapshot polling is paused while a drag is active so the
  //      overlay's content does not re-render mid-drag. A render
  //      mid-drag would re-apply stale `style={{ left, top }}` from
  //      React state and snap the panel back.
  //   3. Panel height is captured once on pointer-down. Reading
  //      offsetHeight on every move would force a layout reflow per
  //      pointermove tick.
  //   4. State is committed once on pointer-up. After the commit, the
  //      next poll re-renders with the current position and the next
  //      drag starts fresh.
  const [position, setPosition] = useState<OverlayPosition>(() => cachedPosition ?? computeCenteredPosition());
  const positionRef = useRef<OverlayPosition>(position);
  const dragRef = useRef<{
    pointerId: number;
    offsetX: number;
    offsetY: number;
    panelHeight: number;
  } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const idsAtMount = projectSessionIdsKey.length === 0 ? [] : projectSessionIdsKey.split(',');
    const poll = async () => {
      // Skip mid-drag: a setSnapshots while dragging would re-render
      // the panel and re-apply stale `style.left/top` from state,
      // causing visual snap-back until the next pointermove fixes it.
      if (dragRef.current !== null) return;
      const results: ActivityStatsSnapshot[] = [];
      for (const sessionId of idsAtMount) {
        try {
          const snapshot = await window.electronAPI.sessions.getActivityStats(sessionId);
          if (snapshot) results.push(snapshot);
        } catch {
          // Ignore probe failures - the overlay is best-effort.
        }
      }
      if (!cancelled) setSnapshots(results);
    };
    void poll();
    const interval = setInterval(() => { void poll(); }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [projectSessionIdsKey]);

  // Sync positionRef with state ONLY when not actively dragging. During
  // a drag the ref holds the live cursor position and must not be
  // overwritten by stale committed state if React re-renders.
  if (dragRef.current === null) {
    positionRef.current = position;
  }

  // GPU-accelerated transform-only positioning: `translate3d()` only
  // triggers Composite, never Layout or Paint, which is what makes a
  // drag feel buttery at 60-144 fps. Writing to `left`/`top` would
  // trigger a layout reflow on every move (even DOM-direct).
  const applyPositionToDom = useCallback((left: number, top: number) => {
    const panel = panelRef.current;
    if (!panel) return;
    panel.style.transform = `translate3d(${left}px, ${top}px, 0)`;
  }, []);

  // Apply position via a layout effect rather than inline `style` in
  // JSX. Critical for smoothness: this component subscribes to several
  // Zustand stores (sessions, tasks, project, config) which re-render
  // it frequently during an active session. If `style={{ transform }}`
  // were inline in JSX, every store update would race the DOM-direct
  // writes from the drag handler - the React re-render would re-apply
  // a stale transform, then the next pointermove would correct it.
  // Using useLayoutEffect with `position` as the only dep means the
  // transform write only happens on commit-to-state events: initial
  // mount and pointer-up. During a drag the ref+rAF path owns the DOM
  // uncontested.
  useLayoutEffect(() => {
    applyPositionToDom(position.left, position.top);
  }, [position, applyPositionToDom]);

  // rAF coalescing: pointermove can fire at 1000Hz on Windows, but we
  // only paint at the display refresh rate (60-144 fps). Storing the
  // latest x/y in a ref and flushing once per frame eliminates
  // redundant style writes and lets the browser composite at frame
  // rate. Pending-frame ref tracks whether a flush is queued.
  const pendingFrameRef = useRef<number | null>(null);
  const flushPendingPosition = useCallback(() => {
    pendingFrameRef.current = null;
    const { left, top } = positionRef.current;
    applyPositionToDom(left, top);
  }, [applyPositionToDom]);

  // Track the currently-active native pointer listeners so unmount
  // cleanup can remove them. Without this, toggling the overlay off
  // (Ctrl+Shift+D, project switch, etc.) MID-DRAG would leak window
  // listeners until the next pointer-up - and a later pointer-up for
  // an unrelated drag could match the captured pointerId.
  const activeDragListenersRef = useRef<{
    onMove: (event: PointerEvent) => void;
    onUp: (event: PointerEvent) => void;
  } | null>(null);

  useEffect(() => {
    return () => {
      const listeners = activeDragListenersRef.current;
      if (listeners) {
        window.removeEventListener('pointermove', listeners.onMove);
        window.removeEventListener('pointerup', listeners.onUp);
        window.removeEventListener('pointercancel', listeners.onUp);
        activeDragListenersRef.current = null;
      }
      if (pendingFrameRef.current !== null) {
        cancelAnimationFrame(pendingFrameRef.current);
        pendingFrameRef.current = null;
      }
      dragRef.current = null;
    };
  }, []);

  // Native pointermove/pointerup listeners attached on pointer-down.
  // Bypasses React's synthetic event system (cheaper per-event) and
  // uses pointer capture so the move stream stays on the panel even
  // if the cursor leaves the header.
  const onHeaderPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const panel = panelRef.current;
    if (!panel) return;
    const target = event.target as HTMLElement;
    if (target.closest('[data-overlay-button]')) return;
    const rect = panel.getBoundingClientRect();
    const dragState = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      // Cache panel height once: reading offsetHeight per move would
      // force a layout reflow on every pointermove tick.
      panelHeight: rect.height,
    };
    dragRef.current = dragState;
    // Anchor at the current spot before any move arrives so the panel
    // doesn't jump.
    applyPositionToDom(rect.left, rect.top);
    positionRef.current = { left: rect.left, top: rect.top };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();

    // Native handlers: lighter per-event than React synthetic events.
    const onMove = (moveEvent: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== moveEvent.pointerId) return;
      const maxLeft = window.innerWidth - PANEL_WIDTH_PX;
      const maxTop = window.innerHeight - drag.panelHeight;
      const left = Math.max(0, Math.min(maxLeft, moveEvent.clientX - drag.offsetX));
      const top = Math.max(0, Math.min(maxTop, moveEvent.clientY - drag.offsetY));
      positionRef.current = { left, top };
      // Coalesce writes into one per animation frame.
      if (pendingFrameRef.current === null) {
        pendingFrameRef.current = requestAnimationFrame(flushPendingPosition);
      }
    };
    const onUp = (upEvent: PointerEvent) => {
      if (dragRef.current?.pointerId !== upEvent.pointerId) return;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      activeDragListenersRef.current = null;
      if (pendingFrameRef.current !== null) {
        cancelAnimationFrame(pendingFrameRef.current);
        pendingFrameRef.current = null;
        // Apply the latest position synchronously so the final paint
        // matches positionRef.current before React's re-render.
        flushPendingPosition();
      }
      dragRef.current = null;
      // Commit final position to React state so future re-renders
      // produce DOM matching the current visual position. Mirror to
      // the module-scoped cache so close+reopen restores the same spot.
      const final = positionRef.current;
      setPosition(final);
      cachedPosition = final;
    };
    activeDragListenersRef.current = { onMove, onUp };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [applyPositionToDom, flushPendingPosition]);

  const handleClose = useCallback(() => {
    void updateConfig({ developer: { activityDebugOverlay: false } });
  }, [updateConfig]);

  if (snapshots.length === 0 && projectSessionIds.length === 0) return null;

  return (
    <div
      ref={panelRef}
      className="fixed top-0 left-0 z-50 max-w-md bg-surface-raised border border-edge rounded-md shadow-lg text-xs select-none"
      style={{
        // Transform is applied via useLayoutEffect, not here. Putting
        // it in JSX would race with the DOM-direct writes from the
        // drag handler whenever a parent re-render fires.
        // - willChange: hints the browser to keep this on its own
        //   composite layer (GPU) so transform changes never fall back
        //   to CPU paint.
        // - touchAction:'none': prevents browser from swallowing the
        //   pointer stream for native scroll/pan, which would stutter
        //   the drag on touch devices.
        willChange: 'transform',
        touchAction: 'none',
      }}
      data-testid="activity-debug-overlay"
    >
      <div
        className="flex items-center gap-2 px-3 py-2 border-b border-edge cursor-grab active:cursor-grabbing"
        onPointerDown={onHeaderPointerDown}
        title="Drag to reposition"
      >
        <GripVertical size={12} className="text-fg-disabled shrink-0" />
        <div className="flex items-center gap-1.5 text-fg-faint flex-1 min-w-0">
          <Bug size={12} />
          <span className="font-medium">Activity Engine Debug</span>
        </div>
        <button
          type="button"
          data-overlay-button
          onClick={handleClose}
          className="text-fg-faint hover:text-fg-tertiary"
          title="Close (Ctrl+Shift+D)"
        >
          <X size={12} />
        </button>
      </div>
      <div className="max-h-96 overflow-auto p-3 space-y-3">
        {snapshots.length === 0 ? (
          <div className="text-fg-faint">No running sessions in this project.</div>
        ) : (
          snapshots.map((snapshot) => (
            <SnapshotRow
              key={snapshot.sessionId}
              snapshot={snapshot}
              label={sessionLabels.get(snapshot.sessionId) ?? snapshot.sessionId.slice(0, 8)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function SnapshotRow({ snapshot, label }: { snapshot: ActivityStatsSnapshot; label: string }) {
  const bgShellCount = snapshot.backgroundShellIds.length + snapshot.anonymousBackgroundShellCount;
  return (
    <div className="space-y-2 border-b border-edge/40 pb-3 last:border-b-0 last:pb-0">
      {/* Identity on the left, status pill floated to the right.
          Reads as "Session X · Y" with the pill as the eye-anchor.
          Wraps to two lines on narrow widths. */}
      <div className="flex items-center gap-2 flex-wrap text-[11px] min-w-0">
        <span className="font-medium text-fg-secondary truncate" title={snapshot.sessionId}>{label}</span>
        <span className="font-mono text-fg-disabled shrink-0" title="Session ID prefix">
          {snapshot.sessionId.slice(0, 8)}
        </span>
        <div className="ml-auto shrink-0">
          <StatusRow snapshot={snapshot} />
        </div>
      </div>

      {/* Counter grid: full names, hover tooltips explaining each. Non-zero
          counters are emphasized; zeros and "no" flags are dimmed so the
          eye lands on what's actually active. */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <CounterRow
          label="Pending tools"
          value={snapshot.pendingToolCount}
          tooltip="Tool calls currently in flight (PreToolUse fired, PostToolUse not yet)"
        />
        <CounterRow
          label="Subagents"
          value={snapshot.subagentDepth}
          tooltip="Active nested Task subagent depth"
        />
        <CounterRow
          label="Background shells"
          value={bgShellCount}
          tooltip="Bash(run_in_background:true) calls plus shells the watcher adopted from the OS process tree"
        />
        <FlagRow
          label="Turn active"
          value={snapshot.turnActive}
          tooltip="True between any thinking-initiating event (Prompt, ToolStart, BackgroundShellStart, etc.) and the next idle event"
        />
        <FlagRow
          label="Permission"
          value={snapshot.permissionPending}
          tooltip="Agent is waiting for the user to approve a tool use"
        />
        <FlagRow
          label="Idle pending"
          value={snapshot.pendingIdleArmed}
          tooltip="An idle transition is queued in the 400ms stability window (suppresses idle→thinking flicker)"
        />
      </div>

      {/* Recent transitions: timeline of state changes. Each line is one
          transition; the trigger label tells you which event/timer/force
          path caused it. Read top-to-bottom = oldest-to-newest. */}
      {snapshot.recentTransitions.length > 0 && (
        <RecentTransitions snapshot={snapshot} />
      )}
    </div>
  );
}

/**
 * Section showing the most recent engine state transitions. Defaults
 * to last 5 visible (the typical signal envelope is small) with a
 * "show all 10" toggle for the full ring buffer. Each row's trigger
 * label gets a hover tooltip explaining the engine path that fired,
 * and a copy-to-clipboard action exports the table as plain text for
 * bug reports.
 */
function RecentTransitions({ snapshot }: { snapshot: ActivityStatsSnapshot }) {
  const allEntries = snapshot.recentTransitions;
  const containerRef = useRef<HTMLDivElement>(null);
  // Tracks whether the user is "tailing" the log (scrolled to the
  // bottom). When they are, new entries auto-scroll into view.
  // When they've scrolled up to read history, we leave them alone.
  const wasAtBottomRef = useRef(true);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const handleScroll = useCallback(() => {
    const element = containerRef.current;
    if (!element) return;
    // 4px slop to avoid rounding-error false positives from
    // sub-pixel scroll positions during smooth-scrolling.
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 4;
    wasAtBottomRef.current = atBottom;
    setIsAtBottom(atBottom);
  }, []);

  // When new entries arrive, auto-scroll if the user was tailing.
  // Depend on the last entry's timestamp so adding without changing
  // length (ring buffer eviction) still triggers a scroll.
  const lastEntryTs = allEntries[allEntries.length - 1]?.ts ?? 0;
  useEffect(() => {
    if (!wasAtBottomRef.current) return;
    const element = containerRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lastEntryTs, allEntries.length]);

  if (allEntries.length === 0) return null;
  const baseTs = allEntries[0].ts;

  const jumpToLatest = () => {
    const element = containerRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  };

  return (
    <div className="space-y-1 pt-1 relative">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wider font-medium text-fg-faint">
          Activity log
        </span>
        <span className="text-[10px] text-fg-disabled tabular-nums" title={`${allEntries.length} entries in ring buffer`}>
          {allEntries.length}
        </span>
      </div>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        // Sized for ~10 rows of compact text-[11px] content. Exceeds
        // that, the scrollbar engages and the user can scroll up.
        className="max-h-48 overflow-y-auto pr-1 space-y-1"
      >
        {allEntries.map((entry, index) => {
          const deltaSeconds = (entry.ts - baseTs) / 1000;
          const deltaLabel = deltaSeconds === 0 ? '+0.0s' : `+${deltaSeconds.toFixed(1)}s`;
          const isTransition = entry.from !== entry.to;
          return (
            <div key={`${entry.ts}-${index}`} className="flex items-center gap-2 font-mono text-[11px] min-w-0">
              <span className="text-fg-disabled w-12 shrink-0 tabular-nums">{deltaLabel}</span>
              {isTransition ? (
                <span className="flex items-center gap-1 shrink-0">
                  <ActivityChip state={entry.from} />
                  <span className="text-fg-disabled">→</span>
                  <ActivityChip state={entry.to} />
                </span>
              ) : (
                <span className="shrink-0 text-fg-disabled italic" title={`Still in ${entry.to}`}>
                  {entry.to}
                </span>
              )}
              <span
                className="text-fg-faint truncate cursor-help"
                title={triggerExplanation(entry.trigger, entry.reasonKind)}
              >
                {entry.trigger}
              </span>
              {entry.counterDelta && (
                <span className="text-fg-disabled shrink-0 ml-auto" title="Counter changes during this step">
                  {entry.counterDelta}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {!isAtBottom && (
        <button
          type="button"
          data-overlay-button
          onClick={jumpToLatest}
          className="absolute bottom-1 right-3 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] bg-surface-raised border border-edge text-fg-secondary hover:bg-surface-hover shadow-sm"
          title="Jump to latest entry and resume tailing"
        >
          <ChevronDown size={10} />
          <span>latest</span>
        </button>
      )}
    </div>
  );
}

/**
 * Plain-language explanation of a transition trigger. Surfaces the
 * trigger vocabulary without requiring the reader to grep the engine
 * source. Falls back to a generic prefix-based hint for unknown
 * triggers.
 */
function triggerExplanation(trigger: string, reasonKind: ActivityReason['kind']): string {
  const reasonHint = `Reason at commit: ${reasonKind}`;

  // Exact-match first for the well-known triggers.
  const exact: Record<string, string> = {
    'force-thinking': 'PTY tracker / heartbeat recovery / external caller forced the session into thinking',
    'force-idle': 'PTY silence timeout / shutdown / external caller forced idle and reset all counters',
    'interrupted': 'User pressed Esc - all counters reset and session forced to idle',
    'timer:stability': 'The 400ms idle stability window expired and the queued idle commit fired',
    'timer:stale-thinking': 'The 45s stale-thinking watchdog forced idle (turn was active but no other counters held it)',
    'timer:bg-shell-hatch': 'The 5-min orphan-bg-shell escape hatch fired (only bg shells were holding thinking, no signals received)',
    'event:bg-shells-adopted': 'Watcher saw shell-like processes the hooks did not fire for and adopted them as anonymous bg shells',
  };
  if (trigger in exact) return `${exact[trigger]}. ${reasonHint}`;

  // Pattern-match for parameterized triggers.
  if (trigger.startsWith('event:bg-shell-ended:')) {
    return `Background shell ended. ${reasonHint}`;
  }
  if (trigger.startsWith('event:idle:')) {
    const detail = trigger.split(':')[2];
    return `Idle event with detail "${detail}" - usually a permission prompt or PTY-driven idle. ${reasonHint}`;
  }
  if (trigger.startsWith('event:')) {
    const eventType = trigger.slice('event:'.length);
    return `Hook event "${eventType}" was processed. ${reasonHint}`;
  }
  if (trigger.startsWith('timer:')) {
    return `Engine timer fired. ${reasonHint}`;
  }

  return `Trigger: ${trigger}. ${reasonHint}`;
}

/**
 * Single source of truth for the engine's current state. One pill
 * combines:
 *   - the activity state (thinking/idle/permission, communicated by
 *     the pill's color)
 *   - the reason WHY (communicated by the icon and the trailing text)
 *
 * Replaces the previous `ActivityBadge + ReasonCallout` pair, which
 * duplicated the state in two places.
 */
function StatusRow({ snapshot }: { snapshot: ActivityStatsSnapshot }) {
  const presentation = statusPresentation(snapshot);
  const { Icon, iconClass, pillClasses, label } = presentation;
  return (
    <div className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium ${pillClasses}`}>
      <Icon size={12} className={`shrink-0 ${iconClass}`} />
      <span className="truncate">{label}</span>
    </div>
  );
}

function statusPresentation(snapshot: ActivityStatsSnapshot): {
  Icon: typeof Wrench;
  iconClass: string;
  pillClasses: string;
  label: string;
} {
  // Permission overrides everything - it's its own top-level state.
  if (snapshot.activity === 'permission') {
    return {
      Icon: Lock,
      iconClass: 'text-amber-400',
      pillClasses: 'bg-amber-500/15 text-amber-200 border border-amber-500/25',
      label: 'Awaiting permission',
    };
  }
  if (snapshot.activity === 'idle') {
    return {
      Icon: Mail,
      iconClass: 'text-fg-faint',
      pillClasses: 'bg-fg-faint/10 text-fg-secondary border border-fg-faint/20',
      label: 'Idle',
    };
  }
  // Thinking - icon and trailing text reflect the dominant reason.
  const reason = snapshot.reason;
  const pill = 'bg-green-500/15 text-green-100 border border-green-500/25';
  switch (reason.kind) {
    case 'tool':
      return {
        Icon: Wrench,
        iconClass: 'text-blue-300',
        pillClasses: pill,
        label: reason.currentTool
          ? `Thinking · running ${reason.currentTool}`
          : `Thinking · ${reason.pendingCount} tool${reason.pendingCount === 1 ? '' : 's'} in flight`,
      };
    case 'subagent':
      return {
        Icon: Users,
        iconClass: 'text-purple-300',
        pillClasses: pill,
        label: `Thinking · ${reason.depth} subagent${reason.depth === 1 ? '' : 's'}`,
      };
    case 'background-shell': {
      const idsHint = reason.ids.length > 0 ? ` (${reason.ids.join(', ')})` : '';
      return {
        Icon: Terminal,
        iconClass: 'text-emerald-300',
        pillClasses: pill,
        label: `Thinking · ${reason.count} background shell${reason.count === 1 ? '' : 's'}${idsHint}`,
      };
    }
    case 'turn-active':
      return {
        Icon: Loader2,
        iconClass: 'text-green-300 animate-spin',
        pillClasses: pill,
        label: 'Thinking · turn active',
      };
    // These two shouldn't reach here in practice - thinking implies a
    // non-idle/non-permission reason - but TypeScript needs them.
    case 'idle':
      return {
        Icon: Loader2,
        iconClass: 'text-green-300 animate-spin',
        pillClasses: pill,
        label: 'Thinking',
      };
    case 'permission':
      return {
        Icon: Lock,
        iconClass: 'text-amber-300',
        pillClasses: pill,
        label: 'Thinking · awaiting permission',
      };
  }
}

/**
 * Compact text-only activity indicator for the recent-transitions row.
 * Smaller than the status pill, no background fill - just colored
 * text so the from/to in `idle → thinking` reads naturally.
 */
function ActivityChip({ state }: { state: ActivityState }) {
  const color = state === 'thinking'
    ? 'text-green-300'
    : state === 'permission'
      ? 'text-amber-300'
      : 'text-fg-faint';
  return <span className={`shrink-0 ${color}`}>{state}</span>;
}

/**
 * Numeric counter row. Non-zero values are emphasized; zeros are
 * dimmed so the eye lands on what is actually active.
 */
function CounterRow({ label, value, tooltip }: { label: string; value: number; tooltip: string }) {
  const isActive = value > 0;
  return (
    <div className="flex items-center justify-between gap-2" title={tooltip}>
      <span className="text-fg-faint truncate cursor-help">{label}</span>
      <span
        className={`font-mono tabular-nums shrink-0 ${
          isActive ? 'text-fg-primary font-medium' : 'text-fg-disabled'
        }`}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * Boolean flag row. "yes" is emphasized in amber; "no" is dimmed.
 */
function FlagRow({ label, value, tooltip }: { label: string; value: boolean; tooltip: string }) {
  return (
    <div className="flex items-center justify-between gap-2" title={tooltip}>
      <span className="text-fg-faint truncate cursor-help">{label}</span>
      <span
        className={`font-mono tabular-nums shrink-0 ${
          value ? 'text-amber-300 font-medium' : 'text-fg-disabled'
        }`}
      >
        {value ? 'yes' : 'no'}
      </span>
    </div>
  );
}
