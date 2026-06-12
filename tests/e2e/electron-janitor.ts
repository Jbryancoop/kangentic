/**
 * E2E leak janitor: sweeps app-under-test Electron processes that a Playwright
 * run leaked.
 *
 * A `_electron.launch()`ed app instance leaks permanently when its worker
 * process dies without running teardown (e.g. a worker crash bypasses every
 * per-fixture afterAll). The leaked main plus its GPU and network-utility
 * children keep running with a dead parent, pinning the worktree's
 * node_modules and stalling the per-project git queue. Wired into Playwright
 * globalSetup (kill stale leaks from previous runs) and globalTeardown (kill
 * this run's leaks), this janitor is the only run-level owner that survives a
 * worker crash.
 *
 * Safety contract (a process is swept only when ALL hold):
 *   1. Path match, conservative and never a bare main-checkout
 *      node_modules/electron hit:
 *        (a) commandLine references the repo's `.kangentic/worktrees/` AND an
 *            electron module path  -> reason 'worktree-instance', or
 *        (b) commandLine references the main checkout's `.vite/build/index.js`
 *            -> reason 'e2e-build-entry'. The dogfooding `npm start` argv is
 *            `electron.exe <projectDir> --cwd=<dir>` (a bare directory, never
 *            the build entry), so this never matches the dogfooding app.
 *   2. Orphan gate: the parent is dead (ppid <= 4 or absent from the scan).
 *      This protects the dogfooding window, /preview instances, and concurrent
 *      Playwright runs in OTHER worktrees, whose electron mains all have a live
 *      worker/node parent. The design therefore does not assume workers=1.
 *   3. Self-skip: the janitor's own PID and walked parent chain are never
 *      touched.
 *
 * Closure pass (cross-platform parity): a leaked main's GPU/utility children
 * have a live parent (the main itself), so the orphan gate excludes them from
 * pass 1. On Windows `taskkill /T` already reaps them when the main dies, so on
 * win32 the closure list is belt-and-braces (and is deliberately NOT re-killed
 * directly - see the kill loop). On POSIX `process.kill` does not tree-kill, so
 * pass 2 is load-bearing there: to behave identically on both per
 * `.claude/rules/cross-platform-parity.md`, it adds any row whose parent is
 * already condemned AND whose commandLine carries an electron module path under
 * the repo, as reason 'child-of-leak'. The electron-path guard keeps a leaked
 * main's PTY/shell children out of the predicate (they are tree-killed by the
 * win32 `/T` but left to self-exit on POSIX, which is acceptable - they are not
 * pinning node_modules). Pass 2's bare main-checkout-electron branch is allowed
 * only when the condemned root is an 'e2e-build-entry' main, never a worktree
 * one, so PID reuse of a dead dogfooding parent can never drag an orphaned
 * dogfooding main into the closure.
 *
 * Caveat: the underlying Windows scan only enumerates electron.exe and node.exe,
 * so a supervising parent of some other image name (a human's pwsh/cmd that
 * launched the worktree electron by hand, say) reads as dead and its child can
 * match pass 1. In practice the process still needs our exact worktree or build
 * path in its argv to match at all, which only this tooling (or that manual
 * re-run of it) produces.
 *
 * Do NOT add a test that deliberately orphans an app-under-test process (e.g.
 * `app.relaunch()`): the relaunched instance carries the worktree argv with a
 * dead parent and a concurrent run's setup sweep in another worktree of the same
 * repo would kill it mid-test. If such a test is ever needed, register its pid
 * into a skip mechanism first.
 *
 * Residual gap (acceptable, documented): a main-checkout-run child whose main
 * already exited and whose argv carries only the bare main node_modules/electron
 * path is intentionally unmatched (dogfooding untouchability is absolute). Such
 * strays are covered by Chromium children self-exiting when their browser
 * process dies, and by the dev-boot reaper's 'main-checkout-orphan' rule at the
 * next `npm start`.
 *
 * This file runs in the Playwright Node process, not the Electron main, so it
 * imports the UNCACHED `scanProcesses` (the reaper's 5s scan cache is in a
 * different process and would be wrong here anyway - setup and teardown are
 * minutes apart and each needs a fresh table).
 */

import path from 'node:path';
import {
  scanProcesses,
  buildSelfSkipSet,
  killProcess,
  normalizePath,
  hasLiveParent,
  type ProcessRow,
} from '../../src/main/git/zombie-reaper';

/** Generous scan cap: post-suite machines are loaded; the boot reaper's
 *  1500ms is too tight when killing a whole run's worth of leaks. */
const SWEEP_SCAN_TIMEOUT_MS = 5000;

export interface LeakedInstance {
  pid: number;
  commandLine: string;
  reason: 'worktree-instance' | 'e2e-build-entry' | 'child-of-leak';
}

/**
 * Resolve the main checkout root from a Playwright config-dir path. When the
 * config lives inside a worktree (`<root>/.kangentic/worktrees/<slug>`), strip
 * back to the main checkout so the sweep targets every worktree's leaks, not
 * just its own. The marker is located on a normalized copy but sliced from the
 * original string so the returned path keeps real casing for logs.
 */
export function deriveMainRepoRoot(checkoutRoot: string): string {
  const marker = '/.kangentic/worktrees/';
  const normalized = normalizePath(checkoutRoot);
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex === -1) return checkoutRoot;
  return checkoutRoot.slice(0, markerIndex);
}

/**
 * Pure predicate. Given a process table, the main repo root, and a self-skip
 * set, return the leaked test instances per the safety contract above. No I/O,
 * no throwing; unit-tested in tests/unit/e2e-janitor.test.ts.
 */
export function findLeakedTestInstances(
  rows: ProcessRow[],
  mainRepoRoot: string,
  skipPids: Set<number>,
): LeakedInstance[] {
  const root = normalizePath(mainRepoRoot).replace(/\/+$/, '');
  const worktreeNeedle = `${root}/.kangentic/worktrees/`;
  const buildEntryNeedle = `${root}/.vite/build/index.js`;
  const repoElectronNeedle = `${root}/node_modules/electron/`;
  const genericElectronNeedle = '/node_modules/electron/';
  const livePids = new Set(rows.map((row) => row.pid));

  const matched = new Map<number, LeakedInstance>();
  // Root flavor of each condemned pid's ancestry: 'worktree' (rooted at a
  // worktree-instance main) or 'build-entry' (rooted at an e2e-build-entry
  // main). Children inherit it. Pass 2 gates the bare main-checkout-electron
  // branch on this so a worktree-rooted closure can never reach a bare-repo
  // electron path - only a build-entry-rooted one can.
  const rootFlavor = new Map<number, 'worktree' | 'build-entry'>();

  // Pass 1: orphan-gated direct matches.
  for (const row of rows) {
    if (skipPids.has(row.pid)) continue;
    const haystack = normalizePath(row.commandLine);
    if (!haystack) continue;

    if (hasLiveParent(row, livePids)) continue;

    if (haystack.includes(worktreeNeedle) && haystack.includes(genericElectronNeedle)) {
      matched.set(row.pid, {
        pid: row.pid,
        commandLine: row.commandLine,
        reason: 'worktree-instance',
      });
      rootFlavor.set(row.pid, 'worktree');
      continue;
    }
    if (haystack.includes(buildEntryNeedle)) {
      matched.set(row.pid, {
        pid: row.pid,
        commandLine: row.commandLine,
        reason: 'e2e-build-entry',
      });
      rootFlavor.set(row.pid, 'build-entry');
    }
  }

  // Pass 2: closure to a fixpoint. A row joins when its parent is already
  // condemned and it carries an electron module path under the repo. NOT
  // orphan-gated: the parent being condemned is the whole point. A worktree
  // child always carries the worktree needle; a bare main-checkout electron
  // child is admitted ONLY under a build-entry root, so PID reuse of a dead
  // dogfooding parent cannot pull an orphaned dogfooding main into the closure.
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (matched.has(row.pid)) continue;
      if (skipPids.has(row.pid)) continue;
      if (!matched.has(row.ppid)) continue;
      const haystack = normalizePath(row.commandLine);
      if (!haystack) continue;
      if (!haystack.includes(genericElectronNeedle)) continue;

      const underWorktree = haystack.includes(worktreeNeedle);
      const underBareRepo = haystack.includes(repoElectronNeedle)
        && rootFlavor.get(row.ppid) === 'build-entry';
      if (!underWorktree && !underBareRepo) continue;

      matched.set(row.pid, {
        pid: row.pid,
        commandLine: row.commandLine,
        reason: 'child-of-leak',
      });
      // Inherit the condemned parent's root flavor (the parent is matched, so
      // its flavor is always set) rather than re-deriving from this row's own
      // command line. This keeps a build-entry-rooted chain from ever flipping
      // to 'worktree' on an intermediate child whose argv happens to carry the
      // worktree needle, which would then wrongly admit bare-repo grandchildren.
      rootFlavor.set(row.pid, rootFlavor.get(row.ppid) ?? (underWorktree ? 'worktree' : 'build-entry'));
      changed = true;
    }
  }

  return [...matched.values()];
}

/**
 * Orchestrate one sweep: scan, build the self-skip set, find leaks, kill each.
 * Wrapped so a janitor failure can never fail a test run; logs every kill with
 * pid, reason, and a commandLine excerpt so a mistaken match is auditable.
 */
export async function sweepLeakedElectronInstances(label: 'setup' | 'teardown'): Promise<void> {
  try {
    const mainRepoRoot = deriveMainRepoRoot(path.resolve(__dirname, '..', '..'));
    const rows = await _internals.scanProcesses(SWEEP_SCAN_TIMEOUT_MS);
    if (rows.length === 0) {
      console.log(`[E2E-JANITOR] ${label}: scanned 0 processes, found 0 leaked instance(s)`);
      return;
    }
    const skipPids = _internals.buildSelfSkipSet(rows, process.pid);
    const leaks = _internals.findLeakedTestInstances(rows, mainRepoRoot, skipPids);
    console.log(
      `[E2E-JANITOR] ${label}: scanned ${rows.length} processes, found ${leaks.length} leaked instance(s)`,
    );
    for (const leak of leaks) {
      // On win32, killing a condemned main with `taskkill /T` already destroyed
      // its tree, so a direct kill of each child-of-leak targets a dead PID -
      // and if Windows reused that PID before we got here, `taskkill /T /F`
      // would force-kill an arbitrary innocent tree with no path match at kill
      // time. Skip them; the parent's tree-kill covers them. POSIX has no tree
      // kill, so there the closure-pass children MUST be killed directly.
      if (process.platform === 'win32' && leak.reason === 'child-of-leak') {
        console.log(
          `[E2E-JANITOR] ${label}: pid=${leak.pid} reason=child-of-leak covered by parent taskkill /T (win32, not re-killed)`,
        );
        continue;
      }
      try {
        await _internals.killProcess(leak.pid);
        console.log(
          `[E2E-JANITOR] ${label}: killed pid=${leak.pid} reason=${leak.reason} cmd=${leak.commandLine.slice(0, 200)}`,
        );
      } catch (error) {
        console.warn(`[E2E-JANITOR] ${label}: kill failed for pid=${leak.pid}:`, error);
      }
    }
  } catch (error) {
    console.warn(`[E2E-JANITOR] ${label}: sweep failed:`, error);
  }
}

// ---------------------------------------------------------------------------
// Internals (exposed for unit-test replacement via vi.spyOn)
// ---------------------------------------------------------------------------

export const _internals = {
  scanProcesses,
  buildSelfSkipSet,
  findLeakedTestInstances,
  killProcess,
};
