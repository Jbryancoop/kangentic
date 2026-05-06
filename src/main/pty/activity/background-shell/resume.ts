import { filterTopmostShellLikeDescendants, type ProcessTreeProbe } from './process-tree';
import type { ActivityEngine } from '../engine';
import type { BgShellWatcher } from './watcher';

/**
 * Resume-time reconciliation for orphan background shells.
 *
 * Kangentic's resume model spawns a fresh PTY (and therefore a fresh
 * Claude CLI) for each resume; bg shells from the prior Claude CLI
 * are orphaned by the OS at the moment the prior CLI dies. As such,
 * this helper today does no useful work in the common case - the
 * fresh Claude CLI's descendant tree is empty when we call it.
 *
 * The reconciler is wired in anyway at spawn time so:
 * (a) we have a clear injection point for the future feature where
 *     Kangentic persists bg shell PIDs across restarts (via DB) and
 *     the watcher adopts them by walking the WHOLE system process
 *     table, not just descendants of one root.
 * (b) edge cases where a fresh Claude CLI inherited shell-like
 *     descendants (e.g. corrupted spawn, MCP server with embedded
 *     shells) get tracked rather than ignored.
 *
 * This is best-effort: probe failure (no `ps`/`pwsh`) means we adopt
 * 0 shells, which degrades to "engine has fewer counters than reality
 * but the rest of activity tracking still works".
 */
export interface ResumeReconciliationArgs {
  sessionId: string;
  rootPid: number;
  probe: ProcessTreeProbe;
  engine: ActivityEngine;
  watcher: BgShellWatcher | null;
}

export interface ResumeReconciliationResult {
  adoptedShellCount: number;
  totalDescendantCount: number;
}

export async function reconcileBgShellsOnResume(
  args: ResumeReconciliationArgs,
): Promise<ResumeReconciliationResult> {
  const { sessionId, rootPid, probe, engine, watcher } = args;
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    return { adoptedShellCount: 0, totalDescendantCount: 0 };
  }
  if (!probe.isAlive(rootPid)) {
    return { adoptedShellCount: 0, totalDescendantCount: 0 };
  }
  const descendants = await probe.listDescendants(rootPid);
  const shellLike = filterTopmostShellLikeDescendants(descendants);
  if (shellLike.length === 0) {
    return { adoptedShellCount: 0, totalDescendantCount: descendants.length };
  }
  engine.adoptAnonymousBackgroundShells(sessionId, shellLike.length);
  if (watcher) {
    watcher.registerSession(sessionId);
    await watcher.anchorBaseline(sessionId);
  }
  return {
    adoptedShellCount: shellLike.length,
    totalDescendantCount: descendants.length,
  };
}
