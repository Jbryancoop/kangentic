import type { CrashRecord, LogEntry } from '../../shared/types';

/**
 * Resolves bundled-chunk URLs in stack traces back to original source
 * `file:line:column` via Vite's `.map` files.
 *
 * V1: pass-through. In dev mode (where most diagnostic use happens) Vite
 * already serves modules with native source-map URLs, so renderer error
 * stacks point to original sources. In production builds the stacks point
 * to bundled chunks and would need the `source-map` package + an async fs
 * read per frame to resolve.
 *
 * The functions here exist so the wiring is in place; replacing the body
 * with a real resolver is a follow-up that does not require any caller
 * changes (log-mirror and crash-capture already route through these).
 *
 * TODO: integrate `source-map-js` (smaller dep than `source-map`) with a
 * per-build LRU cache keyed on the source-map URL.
 */

export function resolveStack(stack: string | null): string | null {
  return stack;
}

export function resolveLogEntry(entry: LogEntry): LogEntry {
  return entry;
}

export function resolveCrashRecord(record: CrashRecord): CrashRecord {
  if (record.stack === null) return record;
  return { ...record, stack: resolveStack(record.stack) };
}
