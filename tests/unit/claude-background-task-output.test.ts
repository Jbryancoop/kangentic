/**
 * Unit tests for the Claude background-task output-file resolver. Verifies the
 * tasks-dir cwd munge (distinct from claudeProjectSlug) and the session-id glob
 * that locates <tmp>/claude/<munged-cwd>/<session-id>/tasks/<shellId>.output,
 * which the bg-shell watcher stats for liveness (Incident B).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  claudeTasksCwdSlug,
  resolveBackgroundTaskOutputFile,
} from '../../src/main/agent/adapters/claude/background-task-output';

describe('claudeTasksCwdSlug', () => {
  it('replaces each of \\ / : . with a dash, leaving other chars intact', () => {
    // The verified empirical shape: a Windows worktree path. Hyphens and the
    // alphanumeric hash survive; only \ : . map to -. (Personal username
    // replaced with a generic dev home per no-personal-info.)
    const cwd = 'C:\\Users\\dev\\Documents\\GitHub\\kangentic\\.kangentic\\worktrees\\done-confirm-dialog-8c86459b';
    expect(claudeTasksCwdSlug(cwd)).toBe(
      'C--Users-dev-Documents-GitHub-kangentic--kangentic-worktrees-done-confirm-dialog-8c86459b',
    );
  });

  it('preserves underscores (unlike claudeProjectSlug, which strips them)', () => {
    expect(claudeTasksCwdSlug('/home/dev/my_project')).toBe('-home-dev-my_project');
  });

  it('maps forward slashes (POSIX paths) to dashes', () => {
    expect(claudeTasksCwdSlug('/Users/dev/repo')).toBe('-Users-dev-repo');
  });
});

describe('resolveBackgroundTaskOutputFile', () => {
  let baseTmpDir: string;
  const cwd = 'C:\\Users\\dev\\repo';
  const slug = claudeTasksCwdSlug(cwd);

  beforeEach(() => {
    baseTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-bgtask-'));
  });

  afterEach(() => {
    fs.rmSync(baseTmpDir, { recursive: true, force: true });
  });

  function writeOutput(sessionId: string, shellId: string, content: string): string {
    const dir = path.join(baseTmpDir, 'claude', slug, sessionId, 'tasks');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${shellId}.output`);
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it('resolves the output file under the munged-cwd / session / tasks layout', () => {
    const expected = writeOutput('8a6c1edb-604c-49d0-b6fd-2af49fde101c', 'b9wh3dhov', 'test output');
    const resolved = resolveBackgroundTaskOutputFile({ cwd, shellId: 'b9wh3dhov' }, baseTmpDir);
    expect(resolved).toBe(expected);
  });

  it('globs the session-id segment (live id can differ from the stored id)', () => {
    // Resume forks the Claude session id, so the segment is not the Kangentic
    // session id. The resolver finds the file regardless of which session dir
    // holds it.
    const expected = writeOutput('forked-9999-aaaa-bbbb-cccc-dddddddddddd', 'bikrml4pf', 'e2e output');
    const resolved = resolveBackgroundTaskOutputFile({ cwd, shellId: 'bikrml4pf' }, baseTmpDir);
    expect(resolved).toBe(expected);
  });

  it('returns the newest-mtime match when multiple session dirs hold the shell id', () => {
    const older = writeOutput('session-old', 'bdup', 'old');
    const newer = writeOutput('session-new', 'bdup', 'new');
    // Force a deterministic mtime ordering independent of write timing.
    fs.utimesSync(older, new Date(1000), new Date(1000));
    fs.utimesSync(newer, new Date(2000), new Date(2000));
    const resolved = resolveBackgroundTaskOutputFile({ cwd, shellId: 'bdup' }, baseTmpDir);
    expect(resolved).toBe(newer);
  });

  it('returns null when the project directory does not exist', () => {
    const resolved = resolveBackgroundTaskOutputFile({ cwd, shellId: 'bnone' }, baseTmpDir);
    expect(resolved).toBeNull();
  });

  it('returns null when no session dir holds the shell id', () => {
    writeOutput('session-1', 'bother', 'unrelated');
    const resolved = resolveBackgroundTaskOutputFile({ cwd, shellId: 'bmissing' }, baseTmpDir);
    expect(resolved).toBeNull();
  });

  it('rejects a shell id that is not a safe slug (path-traversal guard)', () => {
    expect(resolveBackgroundTaskOutputFile({ cwd, shellId: '../escape' }, baseTmpDir)).toBeNull();
    expect(resolveBackgroundTaskOutputFile({ cwd, shellId: 'has space' }, baseTmpDir)).toBeNull();
    expect(resolveBackgroundTaskOutputFile({ cwd, shellId: '' }, baseTmpDir)).toBeNull();
  });
});
