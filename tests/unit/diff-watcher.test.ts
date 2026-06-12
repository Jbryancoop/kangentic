/**
 * Unit tests for DiffWatcher - file system watcher with debounce for live diff updates.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────

/** Per-path close spies so tests can assert exactly which watchers were closed. */
const mockCloseFns = new Map<string, ReturnType<typeof vi.fn>>();
let watchCallback: ((eventType: string, filename: string | null) => void) | null = null;

vi.mock('node:fs', () => ({
  default: {
    watch: vi.fn((watchPath: string, _options: unknown, callback: (eventType: string, filename: string | null) => void) => {
      watchCallback = callback;
      const closeFn = vi.fn();
      mockCloseFns.set(watchPath, closeFn);
      return { close: closeFn };
    }),
  },
}));

// Extend the real path module: pin sep to '/' for cross-platform consistency
// (DiffWatcher splits filenames by path.sep; on CI Linux sep is already '/'),
// but keep the real `relative`, `isAbsolute`, and `join` so that
// `replacePathPrefix` (imported by releaseUnder) works correctly.
vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof import('node:path')>('node:path');
  return {
    default: {
      ...actual,
      sep: '/',
    },
  };
});

import { DiffWatcher } from '../../src/main/git/diff-watcher';

// ── Tests ──────────────────────────────────────────────────────────────────

describe('DiffWatcher', () => {
  let watcher: DiffWatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockCloseFns.clear();
    watchCallback = null;
    watcher = new DiffWatcher();
  });

  afterEach(() => {
    watcher.closeAll();
    vi.useRealTimers();
  });

  it('subscribes and creates a file watcher', () => {
    const callback = vi.fn();
    watcher.subscribe('/project', callback);

    expect(watchCallback).not.toBeNull();
  });

  it('does not create duplicate watchers for the same path', () => {
    const callback = vi.fn();

    watcher.subscribe('/project', callback);

    const secondCallback = vi.fn();
    watcher.subscribe('/project', secondCallback);

    // Trigger a change - only the first callback should be wired
    watchCallback!('change', 'src/file.ts');
    vi.advanceTimersByTime(500);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(secondCallback).not.toHaveBeenCalled();
  });

  it('fires callback after debounce period', () => {
    const callback = vi.fn();
    watcher.subscribe('/project', callback);

    // Simulate a file change
    watchCallback!('change', 'src/index.ts');

    // Not fired yet (within debounce)
    expect(callback).not.toHaveBeenCalled();

    // Advance past debounce (2000ms)
    vi.advanceTimersByTime(500);

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('debounces rapid changes into a single callback', () => {
    const callback = vi.fn();
    watcher.subscribe('/project', callback);

    // Rapid file changes within the debounce window
    watchCallback!('change', 'src/a.ts');
    vi.advanceTimersByTime(200);
    watchCallback!('change', 'src/b.ts');
    vi.advanceTimersByTime(200);
    watchCallback!('change', 'src/c.ts');

    // Not fired yet
    expect(callback).not.toHaveBeenCalled();

    // Advance past debounce from last change
    vi.advanceTimersByTime(500);

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('ignores changes in .git directories', () => {
    const callback = vi.fn();
    watcher.subscribe('/project', callback);

    watchCallback!('change', '.git/refs/heads/main');
    vi.advanceTimersByTime(500);

    expect(callback).not.toHaveBeenCalled();
  });

  it('ignores changes in node_modules', () => {
    const callback = vi.fn();
    watcher.subscribe('/project', callback);

    watchCallback!('change', 'node_modules/some-package/index.js');
    vi.advanceTimersByTime(500);

    expect(callback).not.toHaveBeenCalled();
  });

  it('ignores changes in .kangentic directory', () => {
    const callback = vi.fn();
    watcher.subscribe('/project', callback);

    watchCallback!('change', '.kangentic/worktrees/task/file.ts');
    vi.advanceTimersByTime(500);

    expect(callback).not.toHaveBeenCalled();
  });

  it('ignores null filename events', () => {
    const callback = vi.fn();
    watcher.subscribe('/project', callback);

    watchCallback!('change', null);
    vi.advanceTimersByTime(500);

    expect(callback).not.toHaveBeenCalled();
  });

  it('unsubscribes and closes the watcher', () => {
    const callback = vi.fn();
    watcher.subscribe('/project', callback);

    watcher.unsubscribe('/project');

    expect(mockCloseFns.get('/project')).toHaveBeenCalledTimes(1);
  });

  it('clears pending debounce timer on unsubscribe', () => {
    const callback = vi.fn();
    watcher.subscribe('/project', callback);

    // Trigger a change (starts debounce timer)
    watchCallback!('change', 'src/file.ts');

    // Unsubscribe before debounce fires
    watcher.unsubscribe('/project');

    // Advance past debounce
    vi.advanceTimersByTime(500);

    // Callback should NOT have fired
    expect(callback).not.toHaveBeenCalled();
  });

  it('unsubscribe is a no-op for unknown paths', () => {
    // Should not throw
    watcher.unsubscribe('/nonexistent');
  });

  it('closeAll cleans up all watchers', () => {
    const callbackA = vi.fn();
    const callbackB = vi.fn();

    watcher.subscribe('/project-a', callbackA);
    watcher.subscribe('/project-b', callbackB);

    watcher.closeAll();

    expect(mockCloseFns.get('/project-a')).toHaveBeenCalledTimes(1);
    expect(mockCloseFns.get('/project-b')).toHaveBeenCalledTimes(1);
  });

  // ── releaseUnder ──────────────────────────────────────────────────────────
  //
  // releaseUnder uses replacePathPrefix (path.relative-based) to match the
  // prefix exactly, so tests use platform-resolved paths to ensure correct
  // path.relative behaviour on both Windows and Linux CI.

  describe('releaseUnder', () => {
    it('closes a watcher whose path IS exactly the prefix', () => {
      // Use an absolute path so path.relative gives '' (exact match).
      const prefix = '/projects/app';
      watcher.subscribe(prefix, vi.fn());

      watcher.releaseUnder(prefix);

      expect(mockCloseFns.get(prefix)).toHaveBeenCalledTimes(1);
    });

    it('closes a watcher nested under the prefix', () => {
      const prefix = '/projects/app';
      const nestedPath = '/projects/app/.kangentic/worktrees/feat-x';
      watcher.subscribe(nestedPath, vi.fn());

      watcher.releaseUnder(prefix);

      expect(mockCloseFns.get(nestedPath)).toHaveBeenCalledTimes(1);
    });

    it('does NOT close a sibling that shares a string prefix but is a different directory', () => {
      // '/projects/app2' starts with the string '/projects/app' but is a sibling,
      // not a child. replacePathPrefix uses path.relative which returns '..'
      // for siblings, so the match must be null.
      const prefix = '/projects/app';
      const siblingPath = '/projects/app2';
      watcher.subscribe(siblingPath, vi.fn());

      watcher.releaseUnder(prefix);

      expect(mockCloseFns.get(siblingPath)).not.toHaveBeenCalled();
    });

    it('does NOT close an unrelated path', () => {
      const prefix = '/projects/app';
      const unrelatedPath = '/somewhere/else';
      watcher.subscribe(unrelatedPath, vi.fn());

      watcher.releaseUnder(prefix);

      expect(mockCloseFns.get(unrelatedPath)).not.toHaveBeenCalled();
    });

    it('closes inside-prefix watchers and leaves outside-prefix ones alive', () => {
      const prefix = '/projects/app';
      const insidePath = '/projects/app/.kangentic/worktrees/feat-a';
      const outsidePath = '/other/project';
      const siblingPath = '/projects/app-fork';

      watcher.subscribe(insidePath, vi.fn());
      watcher.subscribe(outsidePath, vi.fn());
      watcher.subscribe(siblingPath, vi.fn());

      watcher.releaseUnder(prefix);

      expect(mockCloseFns.get(insidePath)).toHaveBeenCalledTimes(1);
      expect(mockCloseFns.get(outsidePath)).not.toHaveBeenCalled();
      expect(mockCloseFns.get(siblingPath)).not.toHaveBeenCalled();
    });
  });
});
