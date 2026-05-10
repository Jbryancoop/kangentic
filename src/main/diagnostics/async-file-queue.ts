import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Buffered async append helper for diagnostic writers.
 *
 * Replaces per-call `fs.appendFileSync` + `fs.mkdirSync` (both synchronous,
 * blocking the main event loop) with a per-path FIFO queue flushed via
 * `fs.promises.appendFile`. Multiple entries enqueued before a flush
 * starts get coalesced into one disk write.
 *
 * Cost on Windows: a single `appendFileSync` to `<projectRoot>/.kangentic/logs/`
 * runs 5-50 ms (cold + AV scan). At ~50 calls/s in steady state (every IPC
 * call + every renderer console.* + every main warn) that produces 250-2500 ms
 * of blocked main loop per second, manifesting as terminal-typing stutter and
 * the 5-second-perceived freeze. This helper moves the work off the critical
 * path: the producer call returns synchronously after queueing; disk IO
 * happens on the next `setImmediate` tick.
 *
 * Order is preserved per file: only one flush task runs per filePath at a
 * time. Entries enqueued during a flush are drained by the same task before
 * it resolves. Errors from the underlying FS calls are swallowed so a
 * best-effort diagnostic feature can never crash the agent.
 */

const queues = new Map<string, string[]>();
const pendingFlush = new Map<string, Promise<void>>();
const dirReady = new Set<string>();

/**
 * Append `line` (caller is responsible for the trailing newline) to
 * `filePath`. Non-blocking: returns immediately. The actual disk write
 * happens on the next `setImmediate` turn.
 */
export function queueAppend(filePath: string, line: string): void {
  let queue = queues.get(filePath);
  if (!queue) {
    queue = [];
    queues.set(filePath, queue);
  }
  queue.push(line);
  if (pendingFlush.has(filePath)) return;
  const flushPromise = (async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      await flush(filePath);
    } finally {
      pendingFlush.delete(filePath);
    }
  })();
  pendingFlush.set(filePath, flushPromise);
}

async function flush(filePath: string): Promise<void> {
  while (true) {
    const queue = queues.get(filePath);
    if (!queue || queue.length === 0) return;
    const batch = queue.splice(0, queue.length).join('');
    try {
      const directory = path.dirname(filePath);
      if (!dirReady.has(directory)) {
        await fs.promises.mkdir(directory, { recursive: true });
        dirReady.add(directory);
      }
      await fs.promises.appendFile(filePath, batch, 'utf-8');
    } catch {
      // Best-effort: drop this batch. Disk full / permissions / locked
      // file are non-fatal for diagnostic writers. Continue draining the
      // queue in case a subsequent batch targets a different code path.
    }
  }
}

/**
 * Test helper: await all pending flushes. Diagnostic writers fire on
 * setImmediate, so tests that read from the log file synchronously
 * after triggering a write must call this first.
 */
export async function flushAllForTest(): Promise<void> {
  while (pendingFlush.size > 0) {
    const inFlight = Array.from(pendingFlush.values());
    await Promise.allSettled(inFlight);
  }
}

/** Test helper: clear all in-memory state. Tests should call this in beforeEach. */
export function resetForTest(): void {
  queues.clear();
  pendingFlush.clear();
  dirReady.clear();
}
