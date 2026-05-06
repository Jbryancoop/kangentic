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
  /**
   * Called when the watcher detects K shell-like descendants the
   * engine doesn't know about. Happens when a tool the hook directives
   * don't catch (e.g. Claude Code's `MonitorBash`, `BashList`) spawns
   * background work. The engine should treat these as anonymous bg
   * shells so the predicate keeps the session in `thinking` until
   * those processes actually exit.
   *
   * Without this, agents that use new tooling go idle while their
   * background work is still in flight - the user-visible bug.
   */
  onUnhookedBackgroundShells(sessionId: string, adoptedCount: number): void;
  /** Tier A: a tracked shell PID is no longer alive. */
  onShellPidExited(sessionId: string, shellId: string): void;
  /** Called when the Claude CLI itself dies. Engine should forceIdle. */
  onRootProcessDied(sessionId: string): void;
  /**
   * Called once per successful poll cycle while the engine is tracking
   * one or more bg shells. The engine should refresh its
   * `lastSignalAt` so the 5-minute escape hatch doesn't fire while the
   * watcher is genuinely observing live bg work in the OS.
   *
   * Without this, a session that goes "agent-idle but bg-work-busy"
   * (e.g. agent fired `npm test` in background and stopped sending
   * hooks) would have its bg shells force-cleared by the hatch even
   * though the OS still shows them alive - the user-reported bug
   * "engine shows 0 but 1 shell is still running".
   */
  onShellsObservedAlive(sessionId: string): void;
  /**
   * Read accessors for the watcher to introspect engine state. The
   * watcher does not own counters - it observes them.
   */
  getRootPid(sessionId: string): number | undefined;
  getActiveShellCount(sessionId: string): number;
  /**
   * In-flight tool count from the engine. The watcher uses this to
   * suppress adoption while a foreground tool is executing - a
   * `Bash`, `BashList`, or `BashOutput` invocation spawns a
   * short-lived direct-child bash that should NOT be adopted as a
   * background shell. Once the tool ends and pendingToolCount drops
   * to zero, any persistent shell-like children represent real
   * unhooked bg work and adoption resumes.
   */
  getPendingToolCount(sessionId: string): number;
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
   * Last shellLikeCount we observed from a probe that we believed.
   * Used by the probe-failure heuristic: if a cycle reports 0
   * shell-like descendants while the engine has tracked shells AND we
   * previously observed > 0, the probe likely timed out (PowerShell
   * is slow on Windows under load) - skip the cycle rather than
   * false-fire natural-exits for shells that are still alive.
   *
   * The guard is unconditional (no cap on consecutive skips). A
   * permanently broken probe is handled by the engine's 60s
   * stuck-tracking hatch, not here - the watcher's job is to never
   * false-fire natural-exit while the probe is producing untrustworthy
   * results.
   */
  lastObservedShellLikeCount: number;
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;

export class BgShellWatcher {
  private readonly callbacks: BgShellWatcherCallbacks;
  private readonly probe: ProcessTreeProbe;
  private readonly pollIntervalMs: number;
  private readonly isShellLikeFn: (comm: string) => boolean;
  private readonly states = new Map<string, SessionWatchState>();
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private disposed = false;

  constructor(options: BgShellWatcherOptions) {
    this.callbacks = options.callbacks;
    this.probe = options.probe;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.isShellLikeFn = options.isShellLike ?? isShellLike;
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
      consecutiveDeficitCycles: 0,
      lastObservedShellLikeCount: 0,
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
   * Backwards-compatibility no-op. Older code paths called this on
   * every `BackgroundShellStart` event to re-snapshot the baseline.
   * The new model derives expected shells from engine state directly
   * each cycle, so explicit anchoring is no longer needed.
   *
   * Kept as a public no-op so external callers (e.g. session-telemetry
   * during a slow rollout, or test fixtures) do not break. Can be
   * removed in a follow-up once all call sites are gone.
   */
  async anchorBaseline(_sessionId: string): Promise<void> {
    return;
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

      for (const sessionId of sessionIds) {
        await this.cycleSession(sessionId, allProcesses);
      }
    } finally {
      this.polling = false;
    }
  }

  private async cycleSession(sessionId: string, allProcesses: ProcessInfo[]): Promise<void> {
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
    const shellLikeCount = filterTopmostShellLikeDescendants(descendants, this.isShellLikeFn).length;

    // PROBE-FAILURE GUARD: PowerShell on Windows can intermittently
    // exceed our 1.5s probe timeout under load. When it does, the
    // probe returns an empty descendant list - which would otherwise
    // be indistinguishable from "all shells truly exited at once."
    // If we previously observed shell-like descendants AND the engine
    // still has tracked shells, a sudden drop to 0 is almost certainly
    // a probe failure, not a real exit. Skip the cycle.
    //
    // The guard is unconditional (no skip cap). A permanently broken
    // probe is handled by the engine's 60s stuck-tracking hatch, NOT
    // here - the watcher's job is to never false-fire natural-exit
    // while the probe is producing untrustworthy results.
    //
    // We capture tracked HERE (before Tier A might fire) because the
    // guard decides whether to skip the entire cycle including Tier A.
    // The post-Tier-A `tracked` (used to compute `expected` below) is
    // captured fresh after Tier A's onShellPidExited callbacks may
    // have decremented engine state.
    const trackedAtCycle = this.callbacks.getActiveShellCount(sessionId);
    if (
      shellLikeCount === 0
      && state.lastObservedShellLikeCount > 0
      && trackedAtCycle > 0
    ) {
      // Don't update lastObservedShellLikeCount; we're treating this
      // observation as untrustworthy. Skip the cycle entirely.
      return;
    }
    state.lastObservedShellLikeCount = shellLikeCount;

    // First-cycle anchor: capture pre-existing direct shell-like
    // descendants (Claude's MCP servers, statusline workers, etc.) so
    // we don't adopt them as background work. Subtract any shells the
    // engine already tracks (resumed sessions can have non-zero
    // tracked count at register time) so they don't get double-attributed
    // to "pre-existing" AND "engine-tracked". `trackedAtCycle` was
    // captured above and the engine state hasn't mutated since.
    if (state.preExistingHelpers === null) {
      state.preExistingHelpers = Math.max(0, shellLikeCount - trackedAtCycle);
      return;
    }

    // ALIVE SIGNAL: every successful poll where the engine is tracking
    // bg shells AND we observed shell-like descendants in the OS counts
    // as a fresh "bg work is still in progress" signal. Refreshes the
    // engine's `lastSignalAt` so the 5-min bg-shell escape hatch
    // doesn't false-fire while the watcher is genuinely seeing the
    // shells alive (e.g. agent stopped sending hooks but `npm test`
    // is still running for 6 minutes).
    if (trackedAtCycle > 0 && shellLikeCount > 0) {
      this.callbacks.onShellsObservedAlive(sessionId);
    }

    // Tier A: check tracked shell PIDs. Each Tier A exit corresponds
    // to a shell-like descendant disappearing. Engine.tracked drops
    // accordingly when onShellPidExited fires (engine deletes the id),
    // so the next `expected` calculation reflects the change.
    if (state.trackedShellPids.size > 0) {
      const liveDescendantPids = new Set(descendants.map((d) => d.pid));
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

    if (shellLikeCount > expected) {
      const surplus = shellLikeCount - expected;
      const pendingTools = this.callbacks.getPendingToolCount(sessionId);
      if (pendingTools > 0) {
        // Foreground tool's transient bash. Don't adopt - it will exit
        // and rebalance against expected on its own. Crucially: do NOT
        // touch `preExistingHelpers` here, otherwise the foreground
        // bash gets baked into pre-existing and we lose the ability
        // to detect its exit naturally. Reset deficit counter since
        // we're in surplus territory now.
        state.consecutiveDeficitCycles = 0;
        return;
      }
      // Real unhooked bg work (e.g. Claude Code's MonitorBash, BashList,
      // or any future tool that spawns a persistent shell without
      // firing a background_shell_start hook). Adopt - the engine will
      // count these as anonymous bg shells, which raises `tracked` and
      // brings `expected` in sync with `shellLikeCount` on the next
      // cycle.
      state.consecutiveDeficitCycles = 0;
      this.callbacks.onUnhookedBackgroundShells(sessionId, surplus);
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
      const pendingTools = this.callbacks.getPendingToolCount(sessionId);
      if (pendingTools > 0) {
        return;
      }

      const delta = expected - shellLikeCount;
      if (tracked > 0) {
        const reported = Math.min(delta, tracked);
        if (reported > 0) {
          this.callbacks.onNaturalExit(sessionId, reported);
        }
      } else {
        // No engine-tracked shells to attribute the exit to. A
        // pre-existing helper (MCP server, statusline worker)
        // restarted or crashed. Adjust `preExistingHelpers` down so
        // future cycles don't keep firing this branch.
        state.preExistingHelpers = Math.max(0, state.preExistingHelpers - delta);
      }
      state.consecutiveDeficitCycles = 0;
    } else {
      // No deficit - reset the lag-tolerance counter.
      state.consecutiveDeficitCycles = 0;
    }
  }

}
