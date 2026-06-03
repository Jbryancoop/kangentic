import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Ambient per-project log-tag context.
 *
 * Carries the human-readable project name through an async region so the
 * log-mirror chokepoint (`log-mirror.ts`) can prefix `[projectName]` after the
 * timestamp on every `console.*` emitted inside that region - e.g.
 * `[13:46:49.123] [kangentic] ...`.
 *
 * Why AsyncLocalStorage rather than the IPC context's `currentProjectPath`:
 * the IPC context only holds the single *focused* project, but the lines we
 * most want to disambiguate are emitted during concurrent multi-project work
 * (the startup-recovery flurry across all projects, fired via
 * `Promise.allSettled`). The focused project is NOT the project those lines
 * are about, so a focused-project prefix would mislabel exactly the lines that
 * matter. ALS gives each concurrent per-project run its own context, and the
 * context propagates across `await` boundaries and into every function called
 * inside the run - so wrapping at the outer boundary (where the `Project`
 * object is in scope) tags the inner work with no signature changes.
 *
 * An empty store (global logs: updater, shutdown, bootstrap, and the
 * log-mirror's own infra output) naturally falls back to no prefix.
 *
 * Caveat for future call sites: ALS context is inherited by async resources
 * created inside a run, including later-firing PTY data listeners and
 * `fs.watch` callbacks (desirable - those lines really are about that
 * project). The one hazard is a long-lived timer (`setInterval`) created
 * inside a run, whose every future tick would inherit the run's project. Do
 * NOT wrap a region that schedules a recurring timer; wrap per-tick instead.
 */
interface ProjectLogContext {
  projectName: string;
}

const storage = new AsyncLocalStorage<ProjectLogContext>();

/**
 * Run `fn` with `projectName` as the ambient log-tag context. Nested calls
 * shadow the outer name (ALS is re-entrant). Callers that cannot resolve a
 * name should NOT call this - they should call `fn()` directly so any ambient
 * context set by an outer boundary is preserved rather than clobbered.
 */
export function runWithProjectLogContext<T>(projectName: string, fn: () => T): T {
  return storage.run({ projectName }, fn);
}

/** The current ambient project name, or null when outside any run. */
export function getCurrentProjectLogName(): string | null {
  return storage.getStore()?.projectName ?? null;
}
