import type { SessionEngineState, TransitionTrigger } from './shapes';

/**
 * Declarative timer-anchor strategy for a watchdog hold: which timestamp the
 * hold's deadline is measured from. Co-located with the hold (rather than
 * inferred from `trigger` inside the engine) so a new hold must choose an
 * anchor explicitly, and a new anchor kind becomes a compile error in
 * `watchdogBaseTime` instead of a silent `lastSignalAt` fall-through.
 *
 * - `bg-shell-hold-since`: `state.bgShellHoldSince`. Signal-only keep-alives
 *   (`markThinkingSignal`) cannot move it; only a watcher-confirmed
 *   `markBackgroundShellsAlive` advances it, so a phantom is still reclaimed
 *   at its threshold. Also drives `scheduleTimer`'s stamp/clear maintenance.
 * - `signal-or-pty-output`: the FRESHER of `lastSignalAt` and
 *   `lastPtyOutputAt` - streaming TUI output keeps a genuinely-running
 *   foreground tool alive even when hooks and the status heartbeat are silent.
 * - `signal`: `lastSignalAt` only.
 */
export type WatchdogAnchor =
  | 'bg-shell-hold-since'
  | 'signal-or-pty-output'
  | 'signal';

/**
 * A "watchdog hold" describes a state shape where the engine could be
 * stuck in `thinking` because of one specific holder (bg shells, stuck
 * pending tools, or a hanging turnActive flag) and what to do if that
 * hold persists past its threshold.
 *
 * The holds are mutually exclusive in practice (each branch's predicate
 * partitions the state space), but the rules are no longer "exactly one
 * signal source non-zero" - the pending-tools hold allows turnActive to
 * be either value because Ctrl+C-induced hook drops leave both
 * `pendingToolCount > 0` AND `turnActive === true`. See each predicate
 * for the exact shape it matches.
 *
 * The bg-shell sole-holder case is split into TWO holds by evidence
 * quality (both labeled `timer:bg-shell-hatch`): a NAMED-present hold
 * (a `background_shell_start` hook positively declared the shell, so
 * absence of watcher confirmation extends the deadline to the long
 * 5-min cap) and an ANONYMOUS-only hold (heuristic resume-time
 * adoptions, reclaimed fast at the 30s grace). See the table below.
 */
export interface WatchdogHold {
  /** Returns true when the state matches this hold's "stuck" shape. */
  predicate(state: SessionEngineState): boolean;
  /** ms of silence before the hold counts as stuck. */
  thresholdMs: number;
  /** Audit-log label written to the transition record. */
  trigger: TransitionTrigger;
  /**
   * Which timestamp this hold's deadline is measured from. Read by
   * `watchdogBaseTime` (arming + firing) and, for `bg-shell-hold-since`,
   * by `scheduleTimer`'s `bgShellHoldSince` stamp/clear maintenance.
   */
  anchor: WatchdogAnchor;
  /** Mutates state to clear the stuck holder. Called once threshold fires. */
  reset(state: SessionEngineState): void;
  /**
   * If true, the synthesized idle goes through the stability window
   * (400ms) rather than committing immediately. Used by the
   * bg-shells/pending-tools hatches because they synthesize idle from
   * a long absence of signal - a stability window catches the rare
   * case where a delayed hook arrives within 400ms of the hatch.
   * Stale-thinking opts out: the hold predicate already requires
   * 180 sec of silence, so flicker risk is nil.
   */
  applyStabilityWindow: boolean;
}

export interface WatchdogConfig {
  /**
   * ms threshold for the stuck-pending-tools hatch (measured off
   * `max(lastSignalAt, lastPtyOutputAt)`) AND the long cap for the
   * named-bg-shell sole-holder hold. A hook-declared (named) shell is
   * positive evidence of real work, so it is reclaimed only at this long
   * cap when the watcher cannot confirm liveness, never at the short grace.
   */
  bgShellEscapeHatchMs: number;
  /**
   * ms grace for the ANONYMOUS-only bg-shell hatch. Anonymous shells are
   * heuristic resume-time adoptions (no `background_shell_start` hook), so
   * fast reclaim stays correct. Measured off `bgShellHoldSince` (when bg
   * shells became the sole holder) in the engine, NOT off `lastSignalAt` -
   * so signal-only keep-alive pulses cannot push it out. Only watcher-
   * confirmed liveness (`markBackgroundShellsAlive`, emitted on an in-sync
   * cycle) refreshes the anchor; a phantom shows a deficit and is reclaimed
   * at the grace. See `activity-engine.ts` scheduleTimer/onTick.
   */
  bgShellOnlyGraceMs: number;
  /** ms threshold for the stale-thinking hatch. */
  staleThinkingTimeoutMs: number;
}

/**
 * Build the canonical watchdog table (named-bg / anon-bg /
 * stuck-pending-tools / stale-thinking).
 */
export function buildWatchdogHolds(config: WatchdogConfig): readonly WatchdogHold[] {
  return [
    {
      // Held by a NAMED bg shell (alone). A `background_shell_start` hook
      // positively declared this shell, so absence of watcher confirmation
      // must EXTEND, not shorten, the hold: it is reclaimed only at the long
      // 5-min cap. Positive exit evidence (a `BackgroundShellEnd` event or a
      // Tier A PID-death from the watcher) reclaims it sooner via the normal
      // event path; a genuinely-running shell is held active by
      // `markBackgroundShellsAlive` refreshing the anchor each cycle the
      // watcher (Tier A) confirms its PID alive. Measured off
      // `bgShellHoldSince` so signal-only keep-alives cannot move it.
      // `anonymousBackgroundShellCount` may be > 0 here: any named shell
      // upgrades the whole hold to the long cap, and the reset clears both.
      predicate: (state) =>
        !state.turnActive
        && state.pendingToolCount === 0
        && state.subagentDepth === 0
        && state.activeBackgroundShellIds.size > 0
        && !state.permissionPending,
      thresholdMs: config.bgShellEscapeHatchMs,
      trigger: 'timer:bg-shell-hatch',
      anchor: 'bg-shell-hold-since',
      reset: (state) => {
        state.activeBackgroundShellIds.clear();
        state.anonymousBackgroundShellCount = 0;
      },
      applyStabilityWindow: true,
    },
    {
      // Held by ANONYMOUS bg shells alone (no named shell present). These
      // are count-based heuristic adoptions (e.g. resume-time descendants
      // with no `background_shell_start` hook), so reclaiming fast at the
      // 30s grace is correct. Same anchor and reset as the named hold; the
      // only difference is the shorter threshold. Note the named->anon
      // transition (a named shell drains while anon remains): the anchor is
      // NOT reset (the trigger is unchanged), so the grace is measured from
      // when bg shells first became the sole holder and can fire promptly -
      // correct, since the anon shells have been unconfirmed that long.
      predicate: (state) =>
        !state.turnActive
        && state.pendingToolCount === 0
        && state.subagentDepth === 0
        && state.activeBackgroundShellIds.size === 0
        && state.anonymousBackgroundShellCount > 0
        && !state.permissionPending,
      thresholdMs: config.bgShellOnlyGraceMs,
      trigger: 'timer:bg-shell-hatch',
      anchor: 'bg-shell-hold-since',
      reset: (state) => {
        state.activeBackgroundShellIds.clear();
        state.anonymousBackgroundShellCount = 0;
      },
      applyStabilityWindow: true,
    },
    {
      // Held by pending foreground tools (turnActive may be true or
      // false - both indicate stuck state). Fires after
      // `bgShellEscapeHatchMs` (5 min) of silence. Common cause: user
      // pressed Ctrl+C, Claude killed the bash, but PostToolUseFailure
      // didn't propagate. Without this hatch the engine is stuck in
      // 'thinking' forever - the stale-thinking watchdog requires
      // pendingToolCount=0 to fire, the bg-shell hatch requires
      // bg shells, and the Idle clamp only works if Idle actually
      // fires. Real long-running foreground tools rarely run 5 min in
      // total silence - they emit nested ToolStart/End from sub-tools
      // and subagents that refresh lastSignalAt.
      predicate: (state) =>
        state.pendingToolCount > 0
        && state.subagentDepth === 0
        && (state.activeBackgroundShellIds.size + state.anonymousBackgroundShellCount) === 0
        && !state.permissionPending,
      thresholdMs: config.bgShellEscapeHatchMs,
      trigger: 'timer:stuck-pending-tools',
      anchor: 'signal-or-pty-output',
      reset: (state) => {
        state.pendingToolCount = 0;
        state.pendingToolStack.length = 0;
        state.currentTool = null;
        // Also clear turnActive so the engine commits to idle - the
        // matching Idle/Stop hook for this turn was lost along with the
        // PostToolUse, so leaving turnActive set would leave the
        // session stuck even after the tools clear.
        state.turnActive = false;
      },
      applyStabilityWindow: true,
    },
    {
      // Held by `turnActive` alone (a thinking event fired but the
      // matching Idle hook never arrived).
      predicate: (state) =>
        state.turnActive
        && state.pendingToolCount === 0
        && state.subagentDepth === 0
        && (state.activeBackgroundShellIds.size + state.anonymousBackgroundShellCount) === 0
        && !state.permissionPending,
      thresholdMs: config.staleThinkingTimeoutMs,
      trigger: 'timer:stale-thinking',
      anchor: 'signal',
      reset: (state) => {
        state.turnActive = false;
      },
      applyStabilityWindow: false,
    },
  ];
}

/**
 * Find the (first) hold whose predicate matches the given state, or
 * undefined when no hold is active. Used by `scheduleTimer` to pick
 * the right deadline AND by `onTick` to know which hold's reset to
 * invoke.
 */
export function findActiveWatchdogHold(
  state: SessionEngineState,
  holds: readonly WatchdogHold[],
): WatchdogHold | undefined {
  for (const hold of holds) {
    if (hold.predicate(state)) return hold;
  }
  return undefined;
}
