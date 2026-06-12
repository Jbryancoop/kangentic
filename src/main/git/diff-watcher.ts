import fs from 'node:fs';
import path from 'node:path';
import { replacePathPrefix } from '../../shared/paths';

const DEBOUNCE_MS = 500;
const IGNORED_SEGMENTS = new Set(['.git', 'node_modules', '.kangentic']);

interface WatcherEntry {
  watcher: fs.FSWatcher;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Manages file system watchers for worktree directories.
 * Emits debounced change notifications when files are modified.
 */
export class DiffWatcher {
  private readonly watchers = new Map<string, WatcherEntry>();

  subscribe(worktreePath: string, callback: () => void): void {
    // Already watching this path
    if (this.watchers.has(worktreePath)) return;

    try {
      const watcher = fs.watch(worktreePath, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;

        // Ignore changes in .git/, node_modules/, .kangentic/
        const segments = filename.split(path.sep);
        if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) return;

        // Debounce: reset timer on each change
        const entry = this.watchers.get(worktreePath);
        if (!entry) return;

        if (entry.debounceTimer !== null) {
          clearTimeout(entry.debounceTimer);
        }
        entry.debounceTimer = setTimeout(() => {
          entry.debounceTimer = null;
          callback();
        }, DEBOUNCE_MS);
      });

      this.watchers.set(worktreePath, { watcher, debounceTimer: null });
    } catch {
      // fs.watch may fail on some platforms or if path doesn't exist
    }
  }

  unsubscribe(worktreePath: string): void {
    const entry = this.watchers.get(worktreePath);
    if (!entry) return;

    if (entry.debounceTimer !== null) {
      clearTimeout(entry.debounceTimer);
    }
    entry.watcher.close();
    this.watchers.delete(worktreePath);
  }

  /**
   * Close every watcher whose path is `pathPrefix` itself or nested under it.
   * Used by project relocation to release the recursive `fs.watch` handles
   * inside a project folder before the folder is moved on disk (Windows cannot
   * rename a directory while any process holds a handle inside it). Uses
   * `replacePathPrefix` so the match is `path.relative`-based and therefore
   * correct across Windows drive-letter case and separator differences.
   */
  releaseUnder(pathPrefix: string): void {
    for (const worktreePath of [...this.watchers.keys()]) {
      if (replacePathPrefix(worktreePath, pathPrefix, pathPrefix) !== null) {
        this.unsubscribe(worktreePath);
      }
    }
  }

  /** Clean up all watchers (e.g., on app shutdown). */
  closeAll(): void {
    for (const [worktreePath] of this.watchers) {
      this.unsubscribe(worktreePath);
    }
  }
}
