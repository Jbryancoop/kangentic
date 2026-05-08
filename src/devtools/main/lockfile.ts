import * as fs from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';
import { resetShotsDir } from './screenshot';
import type { PreviewLockfile } from '../shared/types';

/**
 * Per-worktree lockfile that announces a running `/preview` instance to
 * external observers. Path: `<projectRoot>/.kangentic/preview.lock` where
 * `projectRoot` is the worktree's own root (each worktree is an
 * independent project root from kangentic's perspective).
 *
 * Lockfile lifecycle:
 *   - Written by the inspection bridge after the HTTP server binds.
 *   - Removed synchronously in `app.before-quit` so the next launch
 *     doesn't see a stale entry.
 *   - Stale lockfiles (PID dead, file leftover from a force-kill) are
 *     detected by `readLockfile` via `isAlive(pid)` from the existing
 *     process-tree probe.
 *
 * The functions here are dev-only and are tree-shaken out of production
 * builds along with the rest of `src/devtools/`.
 */

const LOCKFILE_NAME = 'preview.lock';

export interface WriteLockfileOptions {
  projectRoot: string;
  port: number;
  worktreePath: string;
  projectId: string;
}

export function writeLockfile(options: WriteLockfileOptions): void {
  const directory = path.join(options.projectRoot, '.kangentic');
  try {
    fs.mkdirSync(directory, { recursive: true });
  } catch {
    return;
  }
  // Wipe any leftover devtools-shots from a previous run before this one
  // starts producing fresh ones. Keeps the directory bounded across
  // restarts even if the previous shutdown didn't fire (force-kill,
  // crash, etc.).
  resetShotsDir(options.projectRoot);
  const record: PreviewLockfile = {
    pid: process.pid,
    port: options.port,
    worktreePath: options.worktreePath,
    projectRoot: options.projectRoot,
    projectId: options.projectId,
    startedAt: new Date().toISOString(),
    kangenticVersion: app.getVersion(),
  };
  try {
    fs.writeFileSync(
      path.join(directory, LOCKFILE_NAME),
      JSON.stringify(record, null, 2),
      'utf-8',
    );
  } catch {
    // Best-effort. The bridge itself still works; only discovery is
    // affected.
  }
}

export function removeLockfile(projectRoot: string): void {
  try {
    fs.unlinkSync(path.join(projectRoot, '.kangentic', LOCKFILE_NAME));
  } catch {
    // Best-effort.
  }
  // Also drop any devtools-shots produced during this run. The path is
  // already gitignored, but leaving stale binary blobs around looks
  // confusing in `ls .kangentic/`.
  resetShotsDir(projectRoot);
}

/** Read + validate. Returns null when the file is missing or malformed. */
export function readLockfile(projectRoot: string): PreviewLockfile | null {
  const file = path.join(projectRoot, '.kangentic', LOCKFILE_NAME);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PreviewLockfile>;
    if (
      typeof parsed.pid === 'number' &&
      typeof parsed.port === 'number' &&
      typeof parsed.worktreePath === 'string' &&
      typeof parsed.projectRoot === 'string' &&
      typeof parsed.projectId === 'string' &&
      typeof parsed.startedAt === 'string' &&
      typeof parsed.kangenticVersion === 'string'
    ) {
      return parsed as PreviewLockfile;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Returns true when the lockfile's PID is still alive. A dead PID with
 * the file present means a previous run was force-killed and the next
 * dev startup should overwrite the file.
 *
 * Uses POSIX signal-0 semantics, which Node.js implements on Windows
 * too (via OpenProcess). EPERM is treated as alive because the process
 * exists; we just don't have permission to signal it.
 */
export function isLockfilePidAlive(record: PreviewLockfile): boolean {
  if (!Number.isInteger(record.pid) || record.pid <= 0) return false;
  try {
    process.kill(record.pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
