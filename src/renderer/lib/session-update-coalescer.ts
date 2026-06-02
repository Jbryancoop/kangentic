/**
 * Session-update coalescer.
 *
 * Single funnel for every session-store push mutation that can re-render a
 * board TaskCard (usage, activity-log events, spawn progress, session status,
 * activity state, first output, exit, idle-timeout). It does two jobs:
 *
 *   1. Coalesce. High-frequency usage/event pushes are batched into one
 *      microtask flush, so N pushes that arrive in the same event-loop turn
 *      cause one React render instead of N. (React 19 auto-batches the set()
 *      calls in flush.)
 *   2. Drag gate. While a board drag is active, ALL session pushes are held and
 *      flushed on drag end. An in-flight spawn (creating a worktree, streaming
 *      first output) therefore never re-renders a `useSortable` card mid-drag,
 *      which would otherwise force dnd-kit to re-measure on the same thread as
 *      the pointer-move pipeline and drop frames. Outside a drag the
 *      side-effect-bearing handlers run immediately (no behavior change), so
 *      only the high-frequency usage/event stream is coalesced when idle. The
 *      optimistic move/drop never routes through here (it lives in board-store),
 *      so drop responsiveness is unaffected.
 *
 * Usage and events keep their dedicated batch store actions (`batchUpdateUsage`
 * / `batchAddEvents`) for efficient last-write-wins / append semantics. The
 * other handlers carry side effects (auto-focus, notifications, auto-name) that
 * read the store AFTER their own write, so when held they are buffered as
 * whole-body thunks (and run unchanged when idle) to keep read-after-write
 * atomic. Held thunks flush in arrival order, which keeps lifecycle ordering
 * correct (`upsertSession` clears `spawnProgress[taskId]`, so a status thunk
 * after a spawn-progress thunk resolves to the right state).
 *
 * HMR: a board drag never survives a module reload (every `<DndContext>`
 * re-keys via `hmrGeneration`), and App.tsx's `vite:afterUpdate` handler
 * re-fetches authoritative state from the main process, which supersedes any
 * buffered renderer-side push. So on HMR we DISCARD buffers and reset the gate
 * rather than preserve or flush them - `resetCoalescerForHmr()` is called from
 * that handler. This mirrors the manual HMR discipline in `auto-name-scheduler.ts`.
 */
import type { SessionEvent, SessionUsage } from '../../shared/types';
import { useSessionStore } from '../stores/session-store';

// hmr-safe: transient in-flight buffer; discarded on HMR (the vite:afterUpdate
// resync re-fetches authoritative state, superseding any buffered push).
const pendingUsage = new Map<string, SessionUsage>();
// hmr-safe: transient in-flight buffer; see pendingUsage.
const pendingEvents: Array<{ sessionId: string; event: SessionEvent }> = [];
// hmr-safe: transient in-flight buffer; see pendingUsage.
const pendingThunks: Array<() => void> = [];

// hmr-safe: a board drag never survives a module reload - every <DndContext>
// re-keys via hmrGeneration, so dragActive correctly resets to false on reload.
let dragActive = false;
// hmr-safe: transient scheduler flag; a stale microtask from a replaced module
// no-ops because flush() reads live buffers and re-checks dragActive.
let flushScheduled = false;

function flush(): void {
  flushScheduled = false;
  // A microtask scheduled just before the drag began must not apply updates
  // mid-drag. endBoardDrag() clears dragActive and flushes directly.
  if (dragActive) return;

  const store = useSessionStore.getState();

  if (pendingUsage.size > 0) {
    const usageCopy = new Map(pendingUsage);
    pendingUsage.clear();
    store.batchUpdateUsage(usageCopy);
  }

  if (pendingEvents.length > 0) {
    const eventsCopy = [...pendingEvents];
    pendingEvents.length = 0;
    store.batchAddEvents(eventsCopy);
  }

  if (pendingThunks.length > 0) {
    const thunksCopy = [...pendingThunks];
    pendingThunks.length = 0;
    for (const thunk of thunksCopy) thunk();
  }
}

function schedule(): void {
  // Held while a board drag is active; flushed by endBoardDrag().
  if (dragActive || flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(flush);
}

/** Queue a usage update (last write wins per session). */
export function enqueueUsage(sessionId: string, data: SessionUsage): void {
  pendingUsage.set(sessionId, data);
  schedule();
}

/** Queue an activity-log event (appended in arrival order). */
export function enqueueEvent(sessionId: string, event: SessionEvent): void {
  pendingEvents.push({ sessionId, event });
  schedule();
}

/**
 * Run a side-effect-bearing session push. When no board drag is active it runs
 * immediately, preserving the pre-existing synchronous, in-order behavior (and
 * keeping intermediate states like spawn-progress phases visible). While a drag
 * is active it is held as a whole-body thunk and flushed, in arrival order, on
 * drag end - which keeps read-after-write (the handler reads getState() after
 * its own write) and lifecycle ordering correct.
 */
export function enqueueSessionUpdate(thunk: () => void): void {
  if (dragActive) {
    pendingThunks.push(thunk);
    return;
  }
  thunk();
}

/** Mark the start of a board drag. While active, all queued updates are held. */
export function beginBoardDrag(): void {
  dragActive = true;
}

/**
 * Mark the end of a board drag and flush everything that was held. Call this
 * synchronously at the top of handleDragEnd / handleDragCancel, before any
 * await, so the buffer stops growing while the async drop resolves.
 */
export function endBoardDrag(): void {
  dragActive = false;
  flush();
}

/**
 * Discard all buffered updates and reset the gate. Called from App.tsx's
 * `vite:afterUpdate` handler: the resync there re-fetches authoritative state
 * from the main process, so buffered renderer-side pushes are stale and must
 * not be applied.
 */
export function resetCoalescerForHmr(): void {
  pendingUsage.clear();
  pendingEvents.length = 0;
  pendingThunks.length = 0;
  dragActive = false;
  flushScheduled = false;
}
