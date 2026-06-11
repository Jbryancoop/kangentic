import fs from 'node:fs';
import {
  filterTopmostShellLikeDescendants,
  isShellLike,
  walkDescendants,
  type ProcessInfo,
  type ProcessTreeProbe,
} from './process-tree';

/**
 * The watcher periodically enumerates the OS process tree rooted at
 * each session's Claude CLI PID and infers when a background shell
 * has exited naturally. Two tiers compose:
 *
 * **Tier A (PID-aware)**: When `registerShellPid(sessionId, shellId, pid)`
 * is called (from a hook directive that extracted a real OS PID from
 * `tool_response`), the watcher tracks `shellId -> pid` and probes
 * `isAlive(pid)` per cycle. When dead, fires `onShellPidExited`.
 * Precise per-shell. Currently dormant - Subsystem C will populate
 * this when empirical capture confirms the PID-bearing field.
 *
 * **Tier B (count-based heuristic, always-on)**: At every background-
 * shell lifecycle event (the engine reports a tracked-shell-count
 * change), the watcher snapshots the count of "shell-like"
 * descendants of the session's root PID. On each cycle, if the live
 * shell-like descendant count drops below the snapshot AND the engine
 * reports non-zero tracked shells, fires `onNaturalExit(delta)` for
 * the difference. Works without knowing PIDs.
 *
 * Failure modes:
 *   - Probe times out -> empty descendants -> no signal this cycle.
 *   - Claude CLI itself dies -> isAlive(rootPid) false -> watcher
 *     unregisters the session and forces idle via callbacks.
 *   - Shell-like filter misses (e.g. python test runner) -> Tier B
 *     under-counts -> falls back to the engine's escape hatch.
 *
 * Watcher is lazy: idle when no session has tracked shells. Polling
 * begins when the first session registers a non-zero count and stops
 * when all sessions drop to zero.
 */

export interface BgShellWatcherCallbacks {
  /**
   * Called when Tier B detects that K bg shells appear to have exited
   * naturally. The engine should drain `K` from its anonymous bg shell
   * counter (or, if PID-aware tracking is also active, from the
   * untracked surplus).
   */
  onNaturalExit(sessionId: string, exitedCount: number): void;
  /** Tier A: a tracked shell PID is no longer alive. */
  onShellPidExited(sessionId: string, shellId: string): void;
  /** Called when the Claude CLI itself dies. Engine should forceIdle. */
  onRootProcessDied(sessionId: string): void;
  /**
   * Tier B positive-liveness: every engine-tracked bg shell is present in
   * the OS tree this cycle (`shellLikeCount === preExistingHelpers + tracked`
   * with `tracked > 0`). The engine refreshes the bg-shell sole-holder grace
   * anchor so a genuinely-running long bg shell is not reclaimed at the 30s
   * grace. Fires ONLY on the in-sync branch - never on a deficit (possible
   * exit), a surplus (helper churn), a probe failure, or the first-cycle
   * anchor - so a phantom (which shows a deficit) is still reclaimed.
   */
  onShellsObservedAlive(sessionId: string): void;
  /**
   * Resolve the on-disk output file for a NAMED background shell, or null
   * when the agent has no such file or it cannot be located. The watcher
   * stats it each cycle; growth is ground-truth liveness for a named shell
   * with no captured OS PID (Incident B). Agent-specific path knowledge
   * stays behind this generic callback (agent-adapters-boundary).
   */
  resolveShellOutputFile(sessionId: string, shellId: string): string | null;
  /**
   * Read accessors for the watcher to introspect engine state. The
   * watcher does not own counters - it observes them.
   */
  getRootPid(sessionId: string): number | undefined;
  getActiveShellCount(sessionId: string): number;
  /**
   * The engine's currently-tracked NAMED background shell ids (from
   * `background_shell_start` hooks with a shell_id). The watcher derives the
   * anonymous count as `getActiveShellCount - getNamedShellIds().length` and
   * uses the named ids to drive Tier A PID liveness. The watcher does not own
   * these - it observes them.
   */
  getNamedShellIds(sessionId: string): string[];
  /**
   * In-flight tool count from the engine. The watcher uses this to
   * suppress baseline rebasing while a foreground tool is executing -
   * a `Bash`, `BashList`, or `BashOutput` invocation spawns a
   * short-lived direct-child bash that we don't want to fold into
   * `preExistingHelpers`. Once the tool ends and pendingToolCount
   * drops to zero, any persistent shell-like children are treated
   * as helpers and rebased up.
   */
  getPendingToolCount(sessionId: string): number;
}

/** A point-in-time sample of a background shell's output file. */
export interface OutputFileSample {
  sizeBytes: number;
  mtimeMs: number;
}

export interface BgShellWatcherOptions {
  callbacks: BgShellWatcherCallbacks;
  probe: ProcessTreeProbe;
  /** Polling cadence. Default 2000ms. */
  pollIntervalMs?: number;
  /**
   * Filter for "shell-like" descendants. Default uses the
   * `SHELL_LIKE_COMM_PATTERNS` allowlist. Override for tests.
   */
  isShellLike?: (comm: string) => boolean;
  /**
   * Stat a background shell's output file. Default wraps `fs.statSync` and
   * returns null on any error (missing file, permission, etc.). Override for
   * tests so the file-growth liveness path is exercised without real I/O.
   */
  statOutputFile?: (filePath: string) => OutputFileSample | null;
}

/** Default output-file stat: size + mtime, or null on any filesystem error. */
function defaultStatOutputFile(filePath: string): OutputFileSample | null {
  try {
    const stats = fs.statSync(filePath);
    return { sizeBytes: stats.size, mtimeMs: stats.mtimeMs };
  } catch {
    return null;
  }
}

interface SessionWatchState {
  /** Root PID (Claude CLI) for this session. */
  rootPid: number;
  /**
   * Count of pre-existing direct shell-like descendants captured on
   * the first cycle. These are background helpers the agent CLI itself
   * spawns (Claude's MCP servers, statusline workers, etc.) that pass
   * the shell-like allowlist but should NOT be tracked as bg work.
   *
   * `null` until the first cycle anchors against the live probe.
   *
   * Combined with `engine.getActiveShellCount()` to compute expected
   * shells each cycle: `expected = preExistingHelpers + engineTracked`.
   * Comparing `shellLikeCount` to `expected` (instead of a stored
   * baseline) keeps the watcher's view always derived from the
   * engine's current truth - foreground tool bashes never inflate the
   * baseline.
   */
  preExistingHelpers: number | null;
  /** Tier A: per-shellId tracked OS PIDs. */
  trackedShellPids: Map<string, number>;
  /**
   * Topmost shell-like descendant PIDs that are NOT background work: the
   * pre-existing helpers captured at the first-cycle anchor (agent CLI's
   * MCP servers, statusline workers) plus any helper that materializes
   * post-anchor on a `pendingTools === 0` surplus rebase. Used to exclude
   * helpers when diffing the tree to capture a new bg shell's PID (Tier A).
   * Pruned to live PIDs on healthy cycles (Windows reuses PIDs aggressively).
   * Over-inclusive at resume (resumed bg shells are anonymous and never
   * Tier-A capture candidates), which is acceptable.
   */
  helperPids: Set<number>;
  /**
   * Named bg shells (from `noteBackgroundShellStarted`) awaiting OS-PID
   * capture, mapped to remaining retry cycles. Resolved by tree-diff: when
   * exactly one topmost shell-like descendant is neither a helper nor
   * already tracked, it is that shell's PID. Cleared on capture, on giving
   * up (retries exhausted or persistently ambiguous), or when the engine
   * stops reporting the id.
   */
  pendingCaptures: Map<string, number>;
  /**
   * A single new topmost shell-like PID observed while a foreground tool was
   * running (`pendingTools > 0`). When that foreground tool auto-backgrounds
   * (Claude promotes a long `Bash`/`PowerShell` to a background shell), its
   * `background_shell_start` arrives via `noteBackgroundShellStarted` and we
   * adopt this memo as the shell's PID immediately - the empirical
   * auto-background path, where by promotion time app-under-test churn has
   * made a fresh tree-diff ambiguous. Null when zero or several new shells
   * are present (ambiguous), or after it is consumed.
   */
  candidateForegroundShellPid: number | null;
  /**
   * Number of consecutive cycles where we've observed
   * `shellLikeCount < expected`. Used to delay natural-exit firing
   * by one cycle - guards against the bash-spawn-lag race where a
   * `background_shell_start` hook fires (engine increments tracked)
   * but the OS bash takes 50-500ms to appear in the process tree.
   * Without this, a watcher cycle landing in the lag window would
   * see deficit and false-fire a natural exit.
   */
  consecutiveDeficitCycles: number;
  /**
   * Per-named-shell output-file samples. The resolved path is cached after the
   * first hit (the session-id segment is globbed, which is the costly part);
   * growth in size or mtime since the previous cycle is positive liveness for
   * a named shell whose OS PID was never captured (Incident B). Entries are
   * pruned when the engine stops tracking the shell, and dropped (to force a
   * re-resolve) if the file vanishes.
   */
  shellOutputFiles: Map<string, { filePath: string; sizeBytes: number; mtimeMs: number }>;
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;

/**
 * How many poll cycles a `noteBackgroundShellStarted` PID-capture attempt
 * survives before giving up. Covers the 50-500ms OS spawn lag (a couple of
 * 2s cycles). On give-up the shell is governed by the count heuristic plus
 * the engine's 5-min named-shell cap.
 */
const PID_CAPTURE_RETRY_CYCLES = 3;

export class BgShellWatcher {
  private readonly callbacks: BgShellWatcherCallbacks;
  private readonly probe: ProcessTreeProbe;
  private readonly pollIntervalMs: number;
  private readonly isShellLikeFn: (comm: string) => boolean;
  private readonly statOutputFileFn: (filePath: string) => OutputFileSample | null;
  private readonly states = new Map<string, SessionWatchState>();
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private disposed = false;

  constructor(options: BgShellWatcherOptions) {
    this.callbacks = options.callbacks;
    this.probe = options.probe;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.isShellLikeFn = options.isShellLike ?? isShellLike;
    this.statOutputFileFn = options.statOutputFile ?? defaultStatOutputFile;
  }

  /**
   * Register a session for watching. Idempotent. Captures the root
   * PID from callbacks once available and resets the baseline.
   */
  registerSession(sessionId: string): void {
    if (this.disposed) return;
    const rootPid = this.callbacks.getRootPid(sessionId);
    if (!rootPid || rootPid <= 0) return;
    if (this.states.has(sessionId)) {
      this.states.get(sessionId)!.rootPid = rootPid;
      return;
    }
    this.states.set(sessionId, {
      rootPid,
      // Anchored on the first cycle from the live probe.
      preExistingHelpers: null,
      trackedShellPids: new Map(),
      helperPids: new Set(),
      pendingCaptures: new Map(),
      candidateForegroundShellPid: null,
      consecutiveDeficitCycles: 0,
      shellOutputFiles: new Map(),
    });
    this.maybeStartPolling();
  }

  /** Remove a session from watching. */
  unregisterSession(sessionId: string): void {
    this.states.delete(sessionId);
    if (this.states.size === 0) this.stopPolling();
  }

  /**
   * Subsystem C entry point: a hook directive extracted a real OS PID
   * for a tracked shell. Adds to Tier A tracking.
   */
  registerShellPid(sessionId: string, shellId: string, pid: number): void {
    if (this.disposed) return;
    const state = this.states.get(sessionId);
    if (!state) return;
    if (!Number.isInteger(pid) || pid <= 0) return;
    state.trackedShellPids.set(shellId, pid);
  }

  /**
   * A `background_shell_start` hook with a shell_id arrived (wired from
   * `SessionTelemetry.ingestEvents`). Attempt to capture the shell's OS PID
   * for Tier A liveness:
   *   - If a foreground-tool shell PID was memoized this cycle window and is
   *     still alive, that IS this shell (the auto-background path) - adopt it.
   *   - Otherwise queue a tree-diff capture over the next few cycles.
   * Either way Tier A liveness (`onShellsObservedAlive` even when the count
   * heuristic is out of sync) only kicks in once the PID is captured; until
   * then the count heuristic and the 5-min named cap govern.
   */
  noteBackgroundShellStarted(sessionId: string, shellId: string): void {
    if (this.disposed) return;
    const state = this.states.get(sessionId);
    if (!state) return;
    if (state.trackedShellPids.has(shellId)) return;
    const memoPid = state.candidateForegroundShellPid;
    if (memoPid !== null && this.probe.isAlive(memoPid)) {
      state.trackedShellPids.set(shellId, memoPid);
      state.candidateForegroundShellPid = null;
      state.pendingCaptures.delete(shellId);
      return;
    }
    state.pendingCaptures.set(shellId, PID_CAPTURE_RETRY_CYCLES);
  }

  /** Force one cycle of polling. Used by tests. */
  async pollNow(): Promise<void> {
    await this.cycle();
  }

  /** Tear down. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopPolling();
    this.states.clear();
    // Release the probe's long-lived resources (Windows persistent
    // PowerShell child). Synchronous so it slots into the
    // before-quit shutdown contract.
    this.probe.dispose();
  }

  // ==== Internal ====

  private maybeStartPolling(): void {
    if (this.timer !== null) return;
    if (this.disposed) return;
    if (this.states.size === 0) return;
    this.timer = setInterval(() => {
      // Skip overlapping cycles - if last poll is still running, drop this tick.
      if (this.polling) return;
      this.cycle().catch(() => {
        // Probe failures are already handled inside cycle(); this catch
        // is just defense against unexpected throws.
      });
    }, this.pollIntervalMs);
    this.timer.unref();
  }

  private stopPolling(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async cycle(): Promise<void> {
    if (this.disposed) return;
    this.polling = true;
    try {
      // Snapshot session ids first - cycle is async and registrations
      // can change in flight.
      const sessionIds = Array.from(this.states.keys());
      if (sessionIds.length === 0) return;

      // Single OS query shared across all sessions in this cycle.
      // Without this, each session's cycleSession would call
      // `listDescendants` which spawns its own PowerShell on Windows.
      // For 10 sessions that's 10 PowerShell spawns × ~200ms = ~2s
      // per cycle, saturating one CPU core. With the shared snapshot,
      // it's one ~200ms spawn per cycle regardless of session count.
      const allProcesses = await this.probe.listAllProcesses();
      // Precompute pids once per cycle for the snapshot-health check
      // in cycleSession. Avoids an O(N) linear scan per session
      // (O(M*N) total) when the host has many processes.
      const allProcessPids = new Set(allProcesses.map((process) => process.pid));

      for (const sessionId of sessionIds) {
        await this.cycleSession(sessionId, allProcesses, allProcessPids);
      }
    } finally {
      this.polling = false;
    }
  }

  private async cycleSession(
    sessionId: string,
    allProcesses: ProcessInfo[],
    allProcessPids: Set<number>,
  ): Promise<void> {
    const state = this.states.get(sessionId);
    if (!state) return;

    // Detect Claude CLI death first.
    if (!this.probe.isAlive(state.rootPid)) {
      this.callbacks.onRootProcessDied(sessionId);
      this.unregisterSession(sessionId);
      return;
    }

    // Walk the per-session subtree from the shared cycle snapshot.
    // walkDescendants is in-memory only; sub-millisecond regardless
    // of process count.
    const descendants = walkDescendants(allProcesses, state.rootPid);
    const topmostShellLike = filterTopmostShellLikeDescendants(descendants, this.isShellLikeFn);
    const shellLikeCount = topmostShellLike.length;

    // PROBE-HEALTH GUARD: process-tree.ts:listAllProcesses returns []
    // on probe failure (PowerShell timeout, child crash, permission
    // error). A successful poll enumerates every process on the host,
    // which by definition includes rootPid (verified alive above).
    // When the snapshot is empty or doesn't contain rootPid the poll
    // is untrustworthy - skip the cycle so we don't false-fire
    // natural-exits for shells that may still be running.
    //
    // The previous guard tried to detect probe failure with a
    // count-shape heuristic (`shellLikeCount==0 && previously>0 &&
    // tracked>0`) which produced the same signature as a genuine
    // post-exit state, trapping leaked anonymous bg-shell counts in
    // an indefinite skip loop until the 5-min bg-shell-hatch fired.
    // Snapshot health is the actual, precise discriminator.
    if (allProcesses.length === 0 || !allProcessPids.has(state.rootPid)) {
      return;
    }

    // We capture tracked HERE (before Tier A might fire) because Tier
    // A's onShellPidExited callbacks decrement engine state - a fresh
    // read after Tier A is taken below to compute `expected`.
    const trackedAtCycle = this.callbacks.getActiveShellCount(sessionId);

    // First-cycle anchor: capture pre-existing direct shell-like
    // descendants (Claude's MCP servers, statusline workers, etc.) so
    // we don't adopt them as background work. Subtract any shells the
    // engine already tracks (resumed sessions can have non-zero
    // tracked count at register time) so they don't get double-attributed
    // to "pre-existing" AND "engine-tracked". `trackedAtCycle` was
    // captured above and the engine state hasn't mutated since.
    const liveDescendantPids = new Set(descendants.map((descendant) => descendant.pid));

    if (state.preExistingHelpers === null) {
      state.preExistingHelpers = Math.max(0, shellLikeCount - trackedAtCycle);
      // Anchor the helper-PID baseline: every topmost shell-like descendant
      // present before any bg work is, by definition, a pre-existing helper
      // (over-inclusive at resume - see the field doc). New bg shells appear
      // post-anchor and are diffed against this set for Tier A capture.
      state.helperPids = new Set(topmostShellLike.map((descendant) => descendant.pid));
      return;
    }

    // Prune helper PIDs to those still alive (Windows reuses PIDs eagerly, so
    // a dead helper's PID must not linger and shadow a future bg shell).
    if (state.helperPids.size > 0) {
      for (const pid of [...state.helperPids]) {
        if (!liveDescendantPids.has(pid)) state.helperPids.delete(pid);
      }
    }

    // Tier A: check tracked shell PIDs. Each Tier A exit corresponds
    // to a shell-like descendant disappearing. Engine.tracked drops
    // accordingly when onShellPidExited fires (engine deletes the id),
    // so the next `expected` calculation reflects the change.
    if (state.trackedShellPids.size > 0) {
      for (const [shellId, pid] of state.trackedShellPids.entries()) {
        if (!liveDescendantPids.has(pid)) {
          state.trackedShellPids.delete(shellId);
          this.callbacks.onShellPidExited(sessionId, shellId);
        }
      }
    }

    // Compute the expected direct shell-like count from engine state.
    // Re-read tracked: Tier A above may have called onShellPidExited
    // which decremented engine.tracked. Foreground tool bashes do NOT
    // contribute to this expectation - they are transient and
    // reconciled via the pending-tools guard.
    const tracked = this.callbacks.getActiveShellCount(sessionId);
    const expected = state.preExistingHelpers + tracked;
    const pendingToolsThisCycle = this.callbacks.getPendingToolCount(sessionId);
    const namedIds = this.callbacks.getNamedShellIds(sessionId);
    const anonCount = Math.max(0, tracked - namedIds.length);

    // The foreground-shell memo is only valid while a foreground tool runs.
    // Clear it once the window closes so a stale PID cannot be mis-adopted by
    // a later, unrelated auto-background.
    if (pendingToolsThisCycle === 0) {
      state.candidateForegroundShellPid = null;
    }

    // Tier A PID capture: resolve queued `noteBackgroundShellStarted` ids by
    // tree-diff. A candidate is a topmost shell-like descendant that is
    // neither a known helper nor already tracked. Only auto-assign when the
    // diff is unambiguous (exactly one pending id AND exactly one candidate);
    // otherwise decrement the retry budget and fall back to the count
    // heuristic + 5-min named cap. The foreground-tool memo (consumed in
    // `noteBackgroundShellStarted`) covers the ambiguous auto-background case.
    if (state.pendingCaptures.size > 0) {
      const trackedPids = new Set(state.trackedShellPids.values());
      const candidatePids = topmostShellLike
        .map((descendant) => descendant.pid)
        .filter((pid) => !state.helperPids.has(pid) && !trackedPids.has(pid));
      for (const [shellId, retriesLeft] of [...state.pendingCaptures.entries()]) {
        if (state.trackedShellPids.has(shellId)) {
          state.pendingCaptures.delete(shellId);
          continue;
        }
        if (state.pendingCaptures.size === 1 && candidatePids.length === 1) {
          state.trackedShellPids.set(shellId, candidatePids[0]);
          state.pendingCaptures.delete(shellId);
        } else if (retriesLeft <= 1) {
          state.pendingCaptures.delete(shellId);
        } else {
          state.pendingCaptures.set(shellId, retriesLeft - 1);
        }
      }
    }

    // Tier A liveness: when every tracked NAMED shell has a captured PID still
    // alive in the tree (and there are no anonymous shells muddying the
    // count), confirm liveness REGARDLESS of whether the count heuristic is in
    // sync. This is the churn-proof path: a backgrounded `npx playwright test`
    // that spawns/kills its own app-under-test shells makes the count oscillate
    // (surplus then permanent deficit), but the named shell's own PID is the
    // ground truth. Refreshing the grace anchor here keeps it active until it
    // actually exits (caught by the Tier A PID-exit drain above).
    let livenessConfirmed = false;
    if (namedIds.length > 0 && anonCount === 0) {
      const allNamedAlive = namedIds.every((shellId) => {
        const pid = state.trackedShellPids.get(shellId);
        return pid !== undefined && liveDescendantPids.has(pid);
      });
      if (allNamedAlive) {
        this.callbacks.onShellsObservedAlive(sessionId);
        livenessConfirmed = true;
      }
    }

    // Output-file liveness: ground truth for a NAMED shell with no captured OS
    // PID (Incident B: a backgrounded `npx playwright test --project=electron`
    // was alive but its app-under-test churn kept the count in permanent
    // deficit, so it false-idled at the 5-min cap while its output file kept
    // growing). Growth in size or mtime since the last cycle proves the shell
    // (or its children) is alive. Runs BEFORE the surplus/deficit branches
    // because that deficit is permanent and would otherwise conclude the cycle.
    // ANY growing shell suffices: the hold anchor is session-level and one
    // genuinely-running bg shell justifies ACTIVE; a phantom sibling is
    // reclaimed once the live shell ends (task-notification end or Tier A exit)
    // and stops refreshing. Growth-STOPPED is deliberately NOT an exit signal -
    // a quiet live shell is indistinguishable from a dead one, so the absence
    // of growth simply falls through to the existing heuristics and caps.
    if (!livenessConfirmed && namedIds.length > 0) {
      if (this.sampleNamedShellOutputGrowth(sessionId, state, namedIds)) {
        this.callbacks.onShellsObservedAlive(sessionId);
        livenessConfirmed = true;
      }
    } else if (namedIds.length === 0 && state.shellOutputFiles.size > 0) {
      // No named shells tracked anymore: release any cached output-file samples.
      state.shellOutputFiles.clear();
    }

    if (shellLikeCount > expected) {
      // Symmetric counterpart to the deficit-side rebase below: a
      // helper process appeared after the first-cycle anchor (MCP
      // server restart, statusline worker spawn, npm.cmd wrapper from
      // an MCP server tool, etc.). Rebase `preExistingHelpers` up so
      // future cycles treat it as part of the baseline.
      //
      // We deliberately do NOT track this as bg work. Real bg shells
      // fire `background_shell_start` hooks which the engine ingests
      // via `processEvent`; anything not on disk is by definition not
      // user/agent-initiated background work. Pre-fix the watcher
      // adopted these as anonymous bg shells and pinned the session in
      // `thinking` indefinitely (the empirical "phantom counter" bug).
      const surplus = shellLikeCount - expected;
      const trackedPids = new Set(state.trackedShellPids.values());
      const newPids = topmostShellLike
        .map((descendant) => descendant.pid)
        .filter((pid) => !state.helperPids.has(pid) && !trackedPids.has(pid));
      if (pendingToolsThisCycle > 0) {
        // Foreground tool's transient bash. Don't rebase yet - it
        // will exit and rebalance against expected on its own. Crucially:
        // do NOT touch `preExistingHelpers` here, otherwise the foreground
        // bash gets baked into pre-existing and we lose the ability
        // to detect its exit naturally.
        //
        // Memoize a SINGLE new foreground shell PID so that, if Claude
        // auto-backgrounds this tool, `noteBackgroundShellStarted` can adopt
        // it as the bg shell's PID for Tier A liveness (the empirical
        // auto-background path). Ambiguous (0 or >1 new) clears the memo.
        state.candidateForegroundShellPid = newPids.length === 1 ? newPids[0] : null;
        state.consecutiveDeficitCycles = 0;
        return;
      }
      // pendingTools === 0: a persistent helper materialized post-anchor.
      // Fold it into the baseline AND remember its PID so it is excluded from
      // future Tier A capture diffs.
      state.preExistingHelpers += surplus;
      for (const pid of newPids) state.helperPids.add(pid);
      state.consecutiveDeficitCycles = 0;
      return;
    }

    if (shellLikeCount < expected) {
      // GUARD 1 (lag tolerance): the OS bash takes 50-500ms to appear
      // after the synchronous hook (worse on Windows). Wait through 2
      // cycles (~4 seconds) before firing natural-exit. The probe-
      // failure guard upstream independently protects against probe
      // timeouts dropping shellLikeCount to 0, and the 5-min escape
      // hatch / 60s stuck-tracking hatch backstop any permanent
      // miscount.
      state.consecutiveDeficitCycles += 1;
      if (state.consecutiveDeficitCycles < 2) {
        return;
      }

      // GUARD 2 (foreground-tool conflation): a foreground `Bash` /
      // `BashOutput` / `BashList` invocation contributes a transient
      // direct-child bash to `shellLikeCount` until it ends. If a
      // genuine bg shell exits while the foreground bash is still
      // alive, `shellLikeCount` only drops once both have exited -
      // and at that moment we can't tell which exit was the bg shell
      // versus the foreground tool. Suppressing decrement while
      // pending tools exist defers the natural-exit attribution to a
      // cycle when no foreground noise is present.
      if (pendingToolsThisCycle > 0) {
        return;
      }

      const delta = expected - shellLikeCount;
      if (anonCount > 0) {
        // Drain ANONYMOUS shells only. A "bg shell exited without firing
        // BackgroundShellEnd" is common on Windows (lost end hook), and
        // anonymous shells have no PID identity for Tier A, so the count
        // heuristic is their only reclaim path. Named shells are deliberately
        // excluded: the engine's ambiguity guard refuses an anonymous
        // (count-based) decrement against a named shell anyway, and named
        // shells are governed by Tier A PID-exit + the 5-min named cap.
        const reported = Math.min(delta, anonCount);
        if (reported > 0) {
          this.callbacks.onNaturalExit(sessionId, reported);
        }
      } else if (namedIds.length > 0) {
        // Only named shells are tracked and none has a captured PID to
        // attribute this deficit to (helper churn under the bg shell, e.g.
        // the app-under-test shells of a backgrounded E2E exiting). Do NOT
        // rebase `preExistingHelpers` down and do NOT fire: the named shell
        // is governed by Tier A liveness (above) + the 5-min cap, and
        // shrinking the baseline here would corrupt the eventual re-sync once
        // the named shell clears.
      } else {
        // No engine-tracked shells to attribute the exit to. A
        // pre-existing helper (MCP server, statusline worker)
        // restarted or crashed. Adjust `preExistingHelpers` down so
        // future cycles don't keep firing this branch.
        state.preExistingHelpers = Math.max(0, state.preExistingHelpers - delta);
      }
      state.consecutiveDeficitCycles = 0;
    } else {
      // In sync (shellLikeCount === expected): every tracked bg shell is
      // present in the OS tree. Reset the lag-tolerance counter and, when the
      // engine has tracked bg shells, confirm liveness so the engine refreshes
      // the bg-shell sole-holder grace anchor for a long-running shell. Not
      // fired on the surplus branch above (ambiguous helper birth, returns
      // early) nor on a deficit (a possible exit must NOT refresh the grace).
      // Skipped when Tier A liveness already confirmed this cycle (above) so
      // the keep-alive is not double-fired.
      state.consecutiveDeficitCycles = 0;
      if (!livenessConfirmed && tracked > 0) {
        this.callbacks.onShellsObservedAlive(sessionId);
      }
    }
  }

  /**
   * Sample each named shell's output file and report whether any grew since the
   * previous cycle. The first sample for a shell is a BASELINE (records the
   * size/mtime, reports no growth) so a shell that is alive but quiet is not
   * mistaken for growth on its first observation. Returns true when at least
   * one tracked named shell's file advanced in size or mtime.
   */
  private sampleNamedShellOutputGrowth(
    sessionId: string,
    state: SessionWatchState,
    namedIds: string[],
  ): boolean {
    // Prune samples for shells the engine no longer tracks.
    if (state.shellOutputFiles.size > 0) {
      const trackedNamedShellIdSet = new Set(namedIds);
      for (const shellId of [...state.shellOutputFiles.keys()]) {
        if (!trackedNamedShellIdSet.has(shellId)) state.shellOutputFiles.delete(shellId);
      }
    }

    let grew = false;
    for (const shellId of namedIds) {
      const entry = state.shellOutputFiles.get(shellId);
      if (!entry) {
        const filePath = this.callbacks.resolveShellOutputFile(sessionId, shellId);
        if (!filePath) continue;
        const sample = this.statOutputFileFn(filePath);
        if (!sample) continue;
        // First observation is a baseline, not growth.
        state.shellOutputFiles.set(shellId, { filePath, sizeBytes: sample.sizeBytes, mtimeMs: sample.mtimeMs });
        continue;
      }
      const sample = this.statOutputFileFn(entry.filePath);
      if (!sample) {
        // File vanished: drop the entry so the next cycle re-resolves the path.
        state.shellOutputFiles.delete(shellId);
        continue;
      }
      if (sample.sizeBytes > entry.sizeBytes || sample.mtimeMs > entry.mtimeMs) {
        grew = true;
      }
      entry.sizeBytes = sample.sizeBytes;
      entry.mtimeMs = sample.mtimeMs;
    }
    return grew;
  }

}
