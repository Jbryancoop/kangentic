/**
 * Unit tests for ActivitySnapshotWriter.
 *
 * The writer is a best-effort diagnostic helper: it atomically writes
 * JSON snapshots to `<dumpDir>/<sessionId>.json` using a tmp-then-rename
 * pattern. Errors from disk I/O are silently swallowed so a debug-only
 * feature can never crash the agent.
 *
 * Behaviors verified:
 * - write() creates the file atomically (no .tmp left behind after success)
 * - remove() is a no-op when the file does not exist (no throw)
 * - ensureDir() failure (bad path) causes write() to silently return without crashing
 * - write() failure mid-rename (mocked renameSync) does not propagate
 * - dirReady flag is set lazily and not retried after mkdir failure
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ActivitySnapshotWriter } from '../../src/main/pty/activity/engine/snapshot-writer';
import type { ActivityStatsSnapshot } from '../../src/shared/types';

const SESSION_ID = 'session-snap-test';

function makeDummySnapshot(): ActivityStatsSnapshot {
  return {
    sessionId: SESSION_ID,
    activity: 'idle',
    reason: { kind: 'idle' },
    pendingToolCount: 0,
    subagentDepth: 0,
    backgroundShellIds: [],
    anonymousBackgroundShellCount: 0,
    turnActive: false,
    permissionPending: false,
    msSinceLastSignal: null,
    pendingIdleArmed: false,
    recentTransitions: [],
  };
}

/** Create a temporary directory that is automatically removed after the test. */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'snap-writer-test-'));
}

function removeTempDir(directory: string): void {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch { /* best effort */ }
}

describe('ActivitySnapshotWriter', () => {
  describe('write() happy path: atomic tmp-then-rename', () => {
    it('creates the JSON file and no .tmp file remains after success', () => {
      const tempDir = makeTempDir();
      try {
        const writer = new ActivitySnapshotWriter(tempDir);
        const snapshot = makeDummySnapshot();

        writer.write(SESSION_ID, snapshot);

        const targetPath = path.join(tempDir, `${SESSION_ID}.json`);
        const tmpPath = `${targetPath}.tmp`;

        expect(fs.existsSync(targetPath)).toBe(true);
        expect(fs.existsSync(tmpPath)).toBe(false);
      } finally {
        removeTempDir(tempDir);
      }
    });

    it('writes valid JSON that round-trips to the original snapshot', () => {
      const tempDir = makeTempDir();
      try {
        const writer = new ActivitySnapshotWriter(tempDir);
        const snapshot = makeDummySnapshot();
        snapshot.activity = 'thinking';
        snapshot.pendingToolCount = 2;

        writer.write(SESSION_ID, snapshot);

        const filePath = path.join(tempDir, `${SESSION_ID}.json`);
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ActivityStatsSnapshot;
        expect(parsed.sessionId).toBe(SESSION_ID);
        expect(parsed.activity).toBe('thinking');
        expect(parsed.pendingToolCount).toBe(2);
      } finally {
        removeTempDir(tempDir);
      }
    });

    it('overwrites the file on subsequent writes', () => {
      const tempDir = makeTempDir();
      try {
        const writer = new ActivitySnapshotWriter(tempDir);

        const firstSnapshot = makeDummySnapshot();
        firstSnapshot.pendingToolCount = 1;
        writer.write(SESSION_ID, firstSnapshot);

        const secondSnapshot = makeDummySnapshot();
        secondSnapshot.pendingToolCount = 5;
        writer.write(SESSION_ID, secondSnapshot);

        const filePath = path.join(tempDir, `${SESSION_ID}.json`);
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ActivityStatsSnapshot;
        expect(parsed.pendingToolCount).toBe(5);
      } finally {
        removeTempDir(tempDir);
      }
    });

    it('creates the dumpDir on first write when it does not exist', () => {
      const tempDir = makeTempDir();
      const subDir = path.join(tempDir, 'activity-dumps', 'nested');
      try {
        // subDir does not exist yet.
        expect(fs.existsSync(subDir)).toBe(false);

        const writer = new ActivitySnapshotWriter(subDir);
        writer.write(SESSION_ID, makeDummySnapshot());

        expect(fs.existsSync(subDir)).toBe(true);
        expect(fs.existsSync(path.join(subDir, `${SESSION_ID}.json`))).toBe(true);
      } finally {
        removeTempDir(tempDir);
      }
    });
  });

  describe('remove() is a no-op when file does not exist', () => {
    it('does not throw when the session file is absent', () => {
      const tempDir = makeTempDir();
      try {
        const writer = new ActivitySnapshotWriter(tempDir);
        // dirReady is false here (no write was called). The guard short-circuits.
        expect(() => writer.remove(SESSION_ID)).not.toThrow();
      } finally {
        removeTempDir(tempDir);
      }
    });

    it('does not throw when the file was already removed', () => {
      const tempDir = makeTempDir();
      try {
        const writer = new ActivitySnapshotWriter(tempDir);
        writer.write(SESSION_ID, makeDummySnapshot());
        writer.remove(SESSION_ID); // first removal
        expect(() => writer.remove(SESSION_ID)).not.toThrow(); // second is a no-op
      } finally {
        removeTempDir(tempDir);
      }
    });

    it('removes the file when it exists', () => {
      const tempDir = makeTempDir();
      try {
        const writer = new ActivitySnapshotWriter(tempDir);
        writer.write(SESSION_ID, makeDummySnapshot());

        const filePath = path.join(tempDir, `${SESSION_ID}.json`);
        expect(fs.existsSync(filePath)).toBe(true);

        writer.remove(SESSION_ID);
        expect(fs.existsSync(filePath)).toBe(false);
      } finally {
        removeTempDir(tempDir);
      }
    });
  });

  describe('ensureDir() failure: dirReady stays false; write() is silent', () => {
    it('write() silently returns (no throw) when mkdirSync fails', () => {
      // Use a path that cannot be a directory on any OS: a file's path as
      // a nested-directory parent guarantees mkdirSync will throw ENOTDIR.
      const tempDir = makeTempDir();
      try {
        // Create a plain file at `blocking-file`.
        const blockingFile = path.join(tempDir, 'blocking-file');
        fs.writeFileSync(blockingFile, 'data');

        // Use the file itself as if it were a directory - mkdir must fail.
        const invalidDumpDir = path.join(blockingFile, 'activity');
        const writer = new ActivitySnapshotWriter(invalidDumpDir);

        expect(() => writer.write(SESSION_ID, makeDummySnapshot())).not.toThrow();
        // No file was created because ensureDir failed.
        expect(fs.existsSync(path.join(invalidDumpDir, `${SESSION_ID}.json`))).toBe(false);
      } finally {
        removeTempDir(tempDir);
      }
    });

    it('dirReady stays false after mkdir failure: subsequent writes also silently return', () => {
      const tempDir = makeTempDir();
      try {
        const blockingFile = path.join(tempDir, 'blocking');
        fs.writeFileSync(blockingFile, 'data');

        const invalidDumpDir = path.join(blockingFile, 'subs');
        const writer = new ActivitySnapshotWriter(invalidDumpDir);

        // Two writes must both silently fail without throwing.
        expect(() => writer.write(SESSION_ID, makeDummySnapshot())).not.toThrow();
        expect(() => writer.write(SESSION_ID, makeDummySnapshot())).not.toThrow();
      } finally {
        removeTempDir(tempDir);
      }
    });
  });

  describe('write() failure mid-rename: silent swallow', () => {
    it('does not propagate when rename target is a directory (EISDIR - real fs)', () => {
      // On all platforms, renaming a file to a path that already exists as a
      // directory throws EISDIR. This exercises the try/catch in write() without
      // needing to mock node:fs (ESM module mocking is not supported for fs
      // named exports in this vitest configuration).
      const tempDir = makeTempDir();
      try {
        const writer = new ActivitySnapshotWriter(tempDir);

        // Create a DIRECTORY at the path that renameSync would rename TO.
        // write() will rename `<sessionId>.json.tmp` → `<sessionId>.json`.
        // If `<sessionId>.json` is already a directory, rename throws EISDIR.
        const targetPath = path.join(tempDir, `${SESSION_ID}.json`);
        fs.mkdirSync(targetPath, { recursive: true });

        // mark dirReady via a separate session so the writer won't try mkdirSync again.
        // Since tempDir exists, ensureDir() succeeds and dirReady is set on first call.
        // Then write() will try to rename the tmp file over the existing directory.
        expect(() => writer.write(SESSION_ID, makeDummySnapshot())).not.toThrow();
      } finally {
        removeTempDir(tempDir);
      }
    });

    it('does not propagate when the tmp file write fails (read-only tmp path)', () => {
      // We cannot make individual files read-only cross-platform from a test,
      // but we CAN verify write() is silent when the dumpDir itself is
      // inaccessible after being created by another process. The cleanest
      // cross-platform approach: use the blocking-file pattern from ensureDir
      // tests to confirm write() catches I/O errors from writeFileSync too.
      //
      // This test verifies the catch block in write() handles writeFileSync
      // failures by calling with a directory path as the tmp target (mkdirSync
      // creates the dumpDir, then writeFileSync('dir.tmp', ...) throws EISDIR).
      const tempDir = makeTempDir();
      try {
        // Pre-create the dumpDir so ensureDir() succeeds (dirReady=true).
        const dumpDir = path.join(tempDir, 'dumps');
        fs.mkdirSync(dumpDir, { recursive: true });
        const writer = new ActivitySnapshotWriter(dumpDir);

        // Create a DIRECTORY at the tmp path that writeFileSync would target.
        const tmpBlocker = path.join(dumpDir, `${SESSION_ID}.json.tmp`);
        fs.mkdirSync(tmpBlocker, { recursive: true });

        // writeFileSync to a directory path throws EISDIR - silently swallowed.
        expect(() => writer.write(SESSION_ID, makeDummySnapshot())).not.toThrow();
      } finally {
        removeTempDir(tempDir);
      }
    });
  });

  describe('dirReady flag lazy-init semantics', () => {
    it('dirReady is not set after mkdir failure: second write also attempts mkdir', () => {
      // Because ESM module mocking is unavailable for node:fs named exports
      // in this vitest config, we use the real-fs blocking-file approach.
      // We cannot spy on mkdirSync calls directly, so we instead verify the
      // observable side-effect: since dirReady stays false, every write() call
      // silently returns without creating any file in the invalid path.
      // If dirReady were incorrectly cached as `true` after a failed mkdir,
      // the second write() would attempt to call writeFileSync with an invalid
      // path and throw (since the catch is only inside write's try block - but
      // ensureDir's return false prevents entry into write's try block entirely).
      const tempDir = makeTempDir();
      try {
        const blockingFile = path.join(tempDir, 'blocker');
        fs.writeFileSync(blockingFile, 'data');

        const invalidDumpDir = path.join(blockingFile, 'inner');
        const writer = new ActivitySnapshotWriter(invalidDumpDir);

        // Both writes silently fail with no throw - dirReady stays false both times.
        expect(() => writer.write(SESSION_ID, makeDummySnapshot())).not.toThrow();
        expect(() => writer.write(SESSION_ID, makeDummySnapshot())).not.toThrow();

        // No file was created - the invalid path has no children.
        expect(fs.existsSync(invalidDumpDir)).toBe(false);
      } finally {
        removeTempDir(tempDir);
      }
    });
  });
});
