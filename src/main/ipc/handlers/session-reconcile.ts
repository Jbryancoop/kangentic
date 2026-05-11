import { SessionRepository } from '../../db/repositories/session-repository';
import { UsageHistoryRepository } from '../../db/repositories/usage-history-repository';
import { getProjectDb } from '../../db/database';
import { getProjectRepos } from '../helpers';
import { captureSessionMetrics } from './session-metrics';
import { markRecordExited, markRecordSuspended } from '../../engine/session-lifecycle';
import { decideSuspendDbAction, isLiveSession } from '../../pty/session-registry';
import type { Session, SuspendedBy, Task } from '../../../shared/types';
import type { IpcContext } from '../ipc-context';

/**
 * Persist the DB side of a session suspend: capture metrics, mark the latest
 * session record `suspended` (or `exited` for a never-started queued record),
 * and clear `task.session_id`. Idempotent - early-exits when there is no
 * session_id to clear.
 *
 * Caller MUST hold `withTaskLock(taskId)` because this writes to per-task
 * state. Synchronous on purpose: better-sqlite3 is sync, and centralizing the
 * writes here lets the idle-timeout path mirror SESSION_SUSPEND without
 * duplicating the branching.
 */
export function applySuspendDbWrites(
  context: IpcContext,
  projectId: string,
  taskId: string,
  source: SuspendedBy,
): void {
  const { tasks } = getProjectRepos(context, projectId);
  const task = tasks.getById(taskId);
  if (!task?.session_id) return;

  const db = getProjectDb(projectId);
  const sessionRepo = new SessionRepository(db);
  const usageHistoryRepo = new UsageHistoryRepository(db);
  const record = sessionRepo.getLatestForTask(taskId);
  const action = decideSuspendDbAction(record);
  if (record && action === 'suspend') {
    captureSessionMetrics(
      context.sessionManager,
      sessionRepo,
      usageHistoryRepo,
      task.session_id,
      record.id,
      record.started_at,
      record.session_type,
    );
    markRecordSuspended(sessionRepo, record.id, source);
  } else if (record && action === 'exit-queued') {
    markRecordExited(sessionRepo, record.id);
  }
  tasks.update({ id: taskId, session_id: null });
}

/**
 * Read a task and reconcile its `session_id` against the live SessionRegistry.
 *
 * Four outcomes:
 *
 *   - `liveSession` set (primary path): `task.session_id` points at a
 *     running/queued registry entry. Returned as-is, no DB writes.
 *   - `liveSession` set (heal-by-taskId): `task.session_id` was null or
 *     pointed at a now-suspended/exited entry, but the registry still
 *     holds a live PTY for the same taskId. Re-link `task.session_id` to
 *     the live session and return it. The renderer's `reconcileSession`
 *     action evicts the stale row by taskId and upserts the live one.
 *   - `liveSession` null + `task.session_id` was non-null: the DB
 *     reference was stale AND no live registry entry exists for the
 *     task. Clears `task.session_id` so resume/spawn paths start clean.
 *   - `liveSession` null + `task.session_id` was already null: clean
 *     state, nothing to reconcile.
 *
 * Why this exists: every internal suspend path SHOULD pair `session.status =
 * 'suspended'` with `tasks.update({ session_id: null })`, but `requestSuspend`
 * (idle-timeout) historically didn't, and the auto-spawn placeholder safety
 * net at startup also doesn't. The heal-by-taskId fallback additionally
 * covers the project-switch round-trip race where `task.session_id` gets
 * cleared while the registry still holds a live PTY: without it the task
 * detail dialog paints "Resume session" even though the agent is alive.
 * Reconciling here means a single recovery point defends every present and
 * future drift between the DB pointer and the live registry.
 */
export function reconcileTaskSessionRef(
  context: IpcContext,
  projectId: string,
  taskId: string,
): { task: Task; liveSession: Session | null } {
  const { tasks } = getProjectRepos(context, projectId);
  const task = tasks.getById(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);

  // Read the registry entry pointed at by task.session_id once, up front.
  // Reused by both the primary path (live check) and the stale-clear log
  // line below, so we avoid a second registry lookup.
  const existing = task.session_id
    ? context.sessionManager.getSession(task.session_id)
    : undefined;

  // Primary path: DB pointer matches a live registry entry.
  if (existing && isLiveSession(existing)) {
    return { task, liveSession: existing };
  }

  // Fallback: registry may still hold a live PTY for this task even when
  // task.session_id is null or points at a now-suspended/exited entry.
  // Re-link so subsequent reads (including the renderer's session view)
  // are consistent. Grep `[SESSION_RECONCILE] Re-linked` to find hits.
  const liveByTaskId = context.sessionManager.findLiveSessionByTaskId(taskId);
  if (liveByTaskId) {
    if (task.session_id === liveByTaskId.id) {
      // Defensive: pointer already matches; nothing to write. Shouldn't
      // be reachable because the primary path would have returned this,
      // but handle it idempotently rather than rely on that invariant.
      return { task, liveSession: liveByTaskId };
    }
    const previous = task.session_id ? task.session_id.slice(0, 8) : 'null';
    console.log(
      `[SESSION_RECONCILE] Re-linked task.session_id for task ${taskId.slice(0, 8)}`
      + ` -> live session ${liveByTaskId.id.slice(0, 8)} (was: ${previous})`,
    );
    tasks.update({ id: taskId, session_id: liveByTaskId.id });
    const refreshed = tasks.getById(taskId);
    if (!refreshed) throw new Error(`Task ${taskId} not found`);
    return { task: refreshed, liveSession: liveByTaskId };
  }

  // No live session anywhere. Clear a stale DB pointer if one is still set.
  if (!task.session_id) return { task, liveSession: null };

  // This log firing means a suspend path mutated the registry without
  // clearing task.session_id (idle-timeout, auto-spawn placeholder safety
  // net, or future regression). Grep this prefix to find divergence sources.
  console.log(
    `[SESSION_RECONCILE] Cleared stale task.session_id for task ${taskId.slice(0, 8)}`
    + ` (registry status: ${existing?.status ?? 'missing'})`,
  );
  tasks.update({ id: taskId, session_id: null });
  // Re-read so the returned task reference matches what subsequent
  // tasks.getById(taskId) calls will return - keeps reference identity
  // consistent for downstream code that mutates the task in place
  // (e.g. ensureTaskWorktree's Object.assign).
  const refreshed = tasks.getById(taskId);
  if (!refreshed) throw new Error(`Task ${taskId} not found`);
  return { task: refreshed, liveSession: null };
}
