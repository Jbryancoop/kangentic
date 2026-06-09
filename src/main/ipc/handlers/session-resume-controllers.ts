/**
 * Per-task AbortController registry for in-flight session resumes.
 *
 * Lives in its own dependency-light module (no electron, no PTY imports) so
 * that handlers outside sessions.ts (e.g. project relocation) can cancel an
 * in-flight resume without pulling in the full session-handler import cone.
 *
 * Contract: abort BEFORE acquiring `withTaskLock(taskId)`, never inside it.
 * An in-flight resume may hold the lock while stuck in unlocked git I/O;
 * aborting from inside the lock would deadlock waiting for that holder.
 */
const sessionResumeControllers = new Map<string, AbortController>();

/** Cancel any in-flight resume for a task. Safe no-op when none is running. */
export function abortInFlightResume(taskId: string): void {
  sessionResumeControllers.get(taskId)?.abort();
}

/** Register a fresh controller for a resume that is about to start. */
export function registerResumeController(taskId: string, controller: AbortController): void {
  sessionResumeControllers.set(taskId, controller);
}

/** Remove the controller when its resume settles, unless a newer one replaced it. */
export function releaseResumeController(taskId: string, controller: AbortController): void {
  if (sessionResumeControllers.get(taskId) === controller) {
    sessionResumeControllers.delete(taskId);
  }
}
