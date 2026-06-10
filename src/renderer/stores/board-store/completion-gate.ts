import type { CompletingTask } from './types';

/**
 * A Done-drop completion in flight. The FlyingCard mounts and starts flying the
 * instant a Done drop is detected, but the move must not persist until two
 * independent signals have BOTH arrived:
 *
 *   - `animationDone`: the FlyingCard finished its fly (transitionend, the 700ms
 *     fallback timer, the no-drop-zone path, or being superseded by a newer drop).
 *   - `approved`: the move is allowed to persist. A no-worktree drop (or a direct
 *     store call) is approved on creation; a worktree drop is approved when its
 *     concurrent `git.checkPendingChanges` probe comes back clean, or when the
 *     user confirms the pending-changes dialog.
 *
 * `persistStarted` guards against persisting twice when both signals are already
 * set and a redundant trigger arrives (e.g. the fallback timer firing after
 * transitionend). The gate keeps its own copy of `completing` because the
 * singular `completingTask` store field may already point at a NEWER drop by the
 * time this gate's persistence runs.
 */
export interface CompletionGate {
  completing: CompletingTask;
  animationDone: boolean;
  approved: boolean;
  persistStarted: boolean;
}

/**
 * Build a fresh gate for a drop. `gated` true means persistence waits for an
 * explicit approval (worktree drop, probe pending); false pre-approves it
 * (no worktree, or a direct store caller that owns its own move).
 */
export function createGate(completing: CompletingTask, gated: boolean): CompletionGate {
  return {
    completing,
    animationDone: false,
    approved: !gated,
    persistStarted: false,
  };
}

/**
 * True when both signals have landed and persistence has not already begun.
 * The single source of truth for "should this gate's move run now"; both the
 * animation-done and approval triggers funnel through it, so persistence fires
 * exactly once regardless of which signal arrives last.
 */
export function canPersist(gate: CompletionGate): boolean {
  return gate.animationDone && gate.approved && !gate.persistStarted;
}
