import type { SessionEngineState, TransitionTrigger } from './shapes';

/**
 * A "watchdog hold" describes a state shape where the engine could be
 * stuck in `thinking` because of one specific holder (bg shells, stuck
 * pending tools, or a hanging turnActive flag) and what to do if that
 * hold persists past its threshold.
 *
 * The 3 holds are mutually exclusive in practice (each branch's
 * predicate partitions the state space), but the rules are no longer
 * "exactly one signal source non-zero" - the pending-tools hold
 * allows turnActive to be either value because Ctrl+C-induced hook
 * drops leave both `pendingToolCount > 0` AND `turnActive === true`.
 * See each predicate for the exact shape it matches.
 */
export interface WatchdogHold {
  /** Returns true when the state matches this hold's "stuck" shape. */
  predicate(state: SessionEngineState): boolean;
  /** ms of silence before the hold counts as stuck. */
  thresholdMs: number;
  /** Audit-log label written to the transition record. */
  trigger: TransitionTrigger;
  /** Mutates state to clear the stuck holder. Called once threshold fires. */
  reset(state: SessionEngineState): void;
  /**
   * If true, the synthesized idle goes through the stability window
   * (400ms) rather than committing immediately. Used by the
   * bg-shells/pending-tools hatches because they synthesize idle from
   * a long absence of signal - a stability window catches the rare
   * case where a delayed hook arrives within 400ms of the hatch.
   * Stale-thinking opts out: the hold predicate already requires
   * 45 sec of silence, so flicker risk is nil.
   */
  applyStabilityWindow: boolean;
}

export interface WatchdogConfig {
  /** ms threshold for the bg-shell hatch and the stuck-pending-tools hatch. */
  bgShellEscapeHatchMs: number;
  /** ms threshold for the stale-thinking hatch. */
  staleThinkingTimeoutMs: number;
}

/**
 * Build the canonical 3-hold watchdog table.
 */
export function buildWatchdogHolds(config: WatchdogConfig): readonly WatchdogHold[] {
  return [
    {
      // Held by bg shells alone.
      predicate: (state) =>
        !state.turnActive
        && state.pendingToolCount === 0
        && state.subagentDepth === 0
        && (state.activeBackgroundShellIds.size + state.anonymousBackgroundShellCount) > 0
        && !state.permissionPending,
      thresholdMs: config.bgShellEscapeHatchMs,
      trigger: 'timer:bg-shell-hatch',
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
