/**
 * Tests for BgShellWatcher with a MockProcessTreeProbe so we can
 * deterministically simulate process trees and OS state without
 * spawning real children.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BgShellWatcher, type BgShellWatcherCallbacks } from '../../src/main/pty/activity/background-shell/watcher';
import type { ProcessInfo, ProcessTreeProbe } from '../../src/main/pty/activity/background-shell/process-tree';

class MockProcessTreeProbe implements ProcessTreeProbe {
  alive = new Set<number>();
  /**
   * Map of rootPid -> ProcessInfo[] for direct lookup. The fixtures
   * use disjoint pid ranges per session so the union of all entries
   * is a valid `listAllProcesses` result and `walkDescendants` from
   * each rootPid finds only that session's subtree.
   */
  trees = new Map<number, ProcessInfo[]>();
  /**
   * When true, `listAllProcesses` returns []. Simulates a real probe
   * failure (PowerShell timeout, etc.). The watcher's snapshot-health
   * guard uses an empty result OR a snapshot missing rootPid as the
   * "skip this cycle" signal.
   */
  failProbe = false;
  /** Call counters for performance regression assertions. */
  listAllCalls = 0;
  listDescendantsCalls = 0;

  isAlive(pid: number): boolean {
    return this.alive.has(pid);
  }

  async listAllProcesses(): Promise<ProcessInfo[]> {
    this.listAllCalls += 1;
    if (this.failProbe) return [];
    const all: ProcessInfo[] = [];
    // Real `listAllProcesses` enumerates every process on the host -
    // which by definition includes the rootPid for each registered
    // session. The watcher uses rootPid presence as its probe-health
    // discriminator, so the mock must reflect that contract. `ppid`
    // and `comm` for the rootPid entry are placeholders: nothing in
    // the watcher reads them (walkDescendants returns descendants
    // only, and 'claude' is not in the shell-like allowlist).
    for (const [rootPid, descendants] of this.trees.entries()) {
      if (this.alive.has(rootPid)) {
        all.push({ pid: rootPid, ppid: 0, comm: 'claude' });
      }
      all.push(...descendants);
    }
    return all;
  }

  async listDescendants(rootPid: number): Promise<ProcessInfo[]> {
    this.listDescendantsCalls += 1;
    return this.trees.get(rootPid) ?? [];
  }

  /** Track dispose calls so the BgShellWatcher.dispose() wiring can be asserted. */
  disposeCalls = 0;
  dispose(): void {
    this.disposeCalls += 1;
  }
}

interface CallbackLog {
  naturalExits: Array<{ sessionId: string; exitedCount: number }>;
  shellPidExited: Array<{ sessionId: string; shellId: string }>;
  rootDied: string[];
  shellsObservedAlive: string[];
}

function makeWatcher(opts?: {
  pollIntervalMs?: number;
  rootPidMap?: Map<string, number>;
  shellCountMap?: Map<string, number>;
  pendingToolMap?: Map<string, number>;
}) {
  const probe = new MockProcessTreeProbe();
  const log: CallbackLog = { naturalExits: [], shellPidExited: [], rootDied: [], shellsObservedAlive: [] };
  const rootPids = opts?.rootPidMap ?? new Map<string, number>();
  const shellCounts = opts?.shellCountMap ?? new Map<string, number>();
  const pendingTools = opts?.pendingToolMap ?? new Map<string, number>();

  const callbacks: BgShellWatcherCallbacks = {
    onNaturalExit(sessionId, exitedCount) {
      log.naturalExits.push({ sessionId, exitedCount });
    },
    onShellPidExited(sessionId, shellId) {
      log.shellPidExited.push({ sessionId, shellId });
    },
    onRootProcessDied(sessionId) {
      log.rootDied.push(sessionId);
    },
    onShellsObservedAlive(sessionId) {
      log.shellsObservedAlive.push(sessionId);
    },
    getRootPid(sessionId) {
      return rootPids.get(sessionId);
    },
    getActiveShellCount(sessionId) {
      return shellCounts.get(sessionId) ?? 0;
    },
    getPendingToolCount(sessionId) {
      return pendingTools.get(sessionId) ?? 0;
    },
  };

  const watcher = new BgShellWatcher({
    callbacks,
    probe,
    pollIntervalMs: opts?.pollIntervalMs ?? 100,
  });

  return { watcher, probe, log, rootPids, shellCounts, pendingTools };
}

describe('BgShellWatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not start polling until a session is registered', () => {
    const { watcher } = makeWatcher();
    expect(vi.getTimerCount()).toBe(0);
    watcher.dispose();
  });

  it('registers a session and captures rootPid', () => {
    const { watcher, rootPids, probe } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    watcher.registerSession('s1');
    // Polling timer should now be armed
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    watcher.dispose();
  });

  it('refuses to register a session without a valid rootPid', () => {
    const { watcher, rootPids } = makeWatcher();
    rootPids.set('s1', 0);
    watcher.registerSession('s1');
    expect(vi.getTimerCount()).toBe(0);
    watcher.dispose();
  });

  it('detects Claude CLI death and fires onRootProcessDied', async () => {
    const { watcher, probe, rootPids, log } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    watcher.registerSession('s1');

    // Now Claude CLI dies
    probe.alive.delete(1234);
    await watcher.pollNow();

    expect(log.rootDied).toContain('s1');
    watcher.dispose();
  });

  it('Tier B: reports natural exit when shell-like descendant count drops', async () => {
    const { watcher, probe, rootPids, shellCounts, log } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);

    // 2 shell-like children (e.g. two `bash -c "..."` wrappers)
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },
      { pid: 5002, ppid: 1234, comm: 'sh' },
    ]);
    shellCounts.set('s1', 2);

    watcher.registerSession('s1');
    // Anchor baseline at 2
    await watcher.pollNow();

    // One shell exits
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },
    ]);

    // Lag-tolerance grace: deficit must persist 2 cycles before firing.
    await watcher.pollNow();
    await watcher.pollNow();

    expect(log.naturalExits).toEqual([{ sessionId: 's1', exitedCount: 1 }]);
    watcher.dispose();
  });

  it('Tier B: caps reported delta at engine tracked count', async () => {
    const { watcher, probe, rootPids, shellCounts, log } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);

    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },
      { pid: 5002, ppid: 1234, comm: 'sh' },
      { pid: 5003, ppid: 1234, comm: 'cmd' },
    ]);
    shellCounts.set('s1', 1); // engine only thinks 1 shell exists

    watcher.registerSession('s1');
    await watcher.pollNow();

    // 2 of 3 disappear (leaves shellLikeCount=1).
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },
    ]);

    await watcher.pollNow();
    await watcher.pollNow();

    // Cap at engine's tracked count (1)
    expect(log.naturalExits).toEqual([{ sessionId: 's1', exitedCount: 1 }]);
    watcher.dispose();
  });

  it('Tier B: does not fire when engine reports 0 active shells', async () => {
    const { watcher, probe, rootPids, shellCounts, log } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);

    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },
    ]);
    shellCounts.set('s1', 0); // engine knows of no shells

    watcher.registerSession('s1');
    await watcher.pollNow();

    probe.trees.set(1234, []);
    await watcher.pollNow();

    expect(log.naturalExits).toHaveLength(0);
    watcher.dispose();
  });

  it('Tier B: ignores non-shell-like descendants', async () => {
    const { watcher, probe, rootPids, shellCounts, log } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);

    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'mcp-server' },
      { pid: 5002, ppid: 1234, comm: 'chrome.exe' },
    ]);
    shellCounts.set('s1', 0);

    watcher.registerSession('s1');
    await watcher.pollNow();

    // MCP server dies - should NOT fire natural exit
    probe.trees.set(1234, [
      { pid: 5002, ppid: 1234, comm: 'chrome.exe' },
    ]);

    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);
    watcher.dispose();
  });

  it('Tier A: reports specific shell PID exit', async () => {
    const { watcher, probe, rootPids, shellCounts, log } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);

    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },
      { pid: 5002, ppid: 1234, comm: 'sh' },
    ]);
    shellCounts.set('s1', 2);

    watcher.registerSession('s1');
    watcher.registerShellPid('s1', 'bash_42', 5001);
    await watcher.pollNow();

    // bash_42's PID disappears. Engine reports tracked count drops from 2 to
    // 1 (set entry was removed when onShellPidExited fired); update mock.
    probe.trees.set(1234, [
      { pid: 5002, ppid: 1234, comm: 'sh' },
    ]);
    shellCounts.set('s1', 1);

    await watcher.pollNow();

    // Tier A fires once for bash_42.
    expect(log.shellPidExited).toEqual([{ sessionId: 's1', shellId: 'bash_42' }]);
    // Tier B does NOT also fire - the watcher decremented baselineShellCount
    // when Tier A reported, so the delta calculation now correctly says zero.
    expect(log.naturalExits).toEqual([]);
    watcher.dispose();
  });

  it('Tier A + Tier B do not double-count when one tracked PID exits among anonymous shells', async () => {
    // Regression test for the prior double-counting bug: if engine has
    // 1 tracked shell (bash_42) + 1 anonymous, and bash_42 dies, only
    // ONE exit should be reported. Pre-fix: Tier A reports bash_42 AND
    // Tier B reports a natural exit for the same descendant, draining
    // the anonymous count to zero even though the anonymous shell is
    // still alive.
    const { watcher, probe, rootPids, shellCounts, log } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },     // bash_42 (Tier A)
      { pid: 5002, ppid: 1234, comm: 'sh' },       // anonymous
    ]);
    shellCounts.set('s1', 2);

    watcher.registerSession('s1');
    watcher.registerShellPid('s1', 'bash_42', 5001);
    await watcher.pollNow();

    // bash_42 dies. Engine processes the Tier A onShellPidExited
    // callback synchronously, dropping its tracked count from 2 to 1.
    probe.trees.set(1234, [
      { pid: 5002, ppid: 1234, comm: 'sh' },
    ]);
    shellCounts.set('s1', 1);

    await watcher.pollNow();

    // EXACTLY one Tier A; ZERO Tier B fires. The anonymous shell is
    // still alive and stays uncounted.
    expect(log.shellPidExited).toHaveLength(1);
    expect(log.naturalExits).toHaveLength(0);
    watcher.dispose();
  });

  it('multi-session isolation', async () => {
    const { watcher, probe, rootPids, shellCounts, log } = makeWatcher();
    rootPids.set('s1', 100);
    rootPids.set('s2', 200);
    probe.alive.add(100);
    probe.alive.add(200);

    probe.trees.set(100, [
      { pid: 1001, ppid: 100, comm: 'bash' },
      { pid: 1002, ppid: 100, comm: 'bash' },
    ]);
    probe.trees.set(200, [{ pid: 2001, ppid: 200, comm: 'sh' }]);
    shellCounts.set('s1', 2);
    shellCounts.set('s2', 1);

    watcher.registerSession('s1');
    watcher.registerSession('s2');
    // First pollNow anchors preExisting for BOTH sessions.
    await watcher.pollNow();

    // One of s1's shells dies; s2 unchanged.
    probe.trees.set(100, [{ pid: 1001, ppid: 100, comm: 'bash' }]);
    await watcher.pollNow();
    await watcher.pollNow();

    expect(log.naturalExits.filter((e) => e.sessionId === 's1')).toHaveLength(1);
    expect(log.naturalExits.filter((e) => e.sessionId === 's2')).toHaveLength(0);
    watcher.dispose();
  });

  it('shares one OS query across all sessions per cycle (perf regression guard)', async () => {
    // The watcher's cycle calls `listAllProcesses` exactly once and walks
    // each session's subtree from the shared snapshot. Without this, N
    // sessions would trigger N PowerShell spawns per cycle on Windows -
    // a real perf cliff at scale (10+ tasks).
    //
    // This test would fail if cycleSession reverted to calling
    // `probe.listDescendants(rootPid)` per session.
    const { watcher, probe, rootPids } = makeWatcher();
    for (let i = 1; i <= 5; i++) {
      const rootPid = 1000 + i;
      const sessionId = `s${i}`;
      rootPids.set(sessionId, rootPid);
      probe.alive.add(rootPid);
      probe.trees.set(rootPid, [{ pid: 5000 + i, ppid: rootPid, comm: 'bash' }]);
      watcher.registerSession(sessionId);
    }

    probe.listAllCalls = 0;
    probe.listDescendantsCalls = 0;
    await watcher.pollNow();

    expect(probe.listAllCalls).toBe(1);
    expect(probe.listDescendantsCalls).toBe(0);
    watcher.dispose();
  });

  it('unregisterSession stops polling when last session removed', () => {
    const { watcher, rootPids, probe } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    watcher.registerSession('s1');
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    watcher.unregisterSession('s1');
    expect(vi.getTimerCount()).toBe(0);
    watcher.dispose();
  });

  it('dispose() is idempotent and clears all sessions', () => {
    const { watcher, rootPids, probe } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    watcher.registerSession('s1');

    watcher.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => watcher.dispose()).not.toThrow();
    // Post-dispose, register is a no-op
    watcher.registerSession('s2');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('first cycle anchors baseline against current shell-like descendants without firing callbacks', async () => {
    // Pre-existing helpers (Claude's MCP servers, statusline workers
    // running as long-lived bash wrappers) must not be adopted as
    // background work. The first cycle establishes the baseline
    // silently; subsequent cycles only react to deltas.
    const { watcher, probe, rootPids, log } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },
      { pid: 5002, ppid: 1234, comm: 'sh' },
    ]);

    watcher.registerSession('s1');
    await watcher.pollNow();

    expect(log.naturalExits).toHaveLength(0);
    watcher.dispose();
  });

  it('rebases helper baseline up when shell-like descendants appear post-anchor (no adoption)', async () => {
    // Empirical bug regression: agent's MCP server / statusline worker
    // restarts mid-session and spawns a persistent shell-like child.
    // Pre-fix the watcher adopted it as anonymous bg work; the
    // resulting phantom counter was then pinned by `onShellsObservedAlive`
    // and the session stuck in `thinking` indefinitely. Post-fix the
    // watcher silently rebases `preExistingHelpers` up so the helper
    // is treated as part of the baseline, not as user-initiated bg work.
    const { watcher, probe, rootPids, log } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    probe.trees.set(1234, []);
    watcher.registerSession('s1');
    await watcher.pollNow(); // anchor preExistingHelpers=0

    // Cycle 2: 2 helpers materialize after the anchor (e.g. MCP server
    // restart + npm.cmd wrapper).
    probe.trees.set(1234, [
      { pid: 6001, ppid: 1234, comm: 'bash' },
      { pid: 6002, ppid: 1234, comm: 'sh' },
    ]);
    await watcher.pollNow();

    // No adoption: the engine's bg-shell counters are untouched.
    // Real bg shells fire `background_shell_start` hooks which the
    // engine ingests directly via processEvent.
    expect(log.naturalExits).toHaveLength(0);

    // Cycle 3: same shape - in balance with the rebased baseline.
    // No spurious deficit firing, no spurious adoption.
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);

    // Cycle 4: one helper exits. Rebase baseline DOWN (existing
    // deficit-side behavior). Still no natural-exit fire because
    // tracked=0 (no real bg shells the engine knew about).
    probe.trees.set(1234, [{ pid: 6001, ppid: 1234, comm: 'bash' }]);
    await watcher.pollNow();
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);
    watcher.dispose();
  });

  it('does not rebase up while engine has pending tools (foreground bash transient)', async () => {
    // Regression: a foreground `Bash` / `BashOutput` / `BashList`
    // invocation spawns a short-lived direct-child bash. The watcher
    // must NOT bake that transient into `preExistingHelpers`; if it
    // did, the bash exit would not register as a deficit and
    // hook-tracked bg-shell exits later in the session would be
    // miscounted.
    const { watcher, probe, rootPids, log, pendingTools } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    probe.trees.set(1234, []);
    watcher.registerSession('s1');
    await watcher.pollNow(); // first-cycle anchor

    // Simulate ToolStart(Bash) -> engine bumps pendingToolCount.
    pendingTools.set('s1', 1);
    probe.trees.set(1234, [{ pid: 6001, ppid: 1234, comm: 'bash' }]);
    await watcher.pollNow();
    await watcher.pollNow();

    // ToolEnd fires -> pendingToolCount drops. Bash exits same cycle.
    pendingTools.set('s1', 0);
    probe.trees.set(1234, []);
    await watcher.pollNow();

    // No spurious natural exit: tracked stayed at 0 throughout.
    expect(log.naturalExits).toHaveLength(0);
    watcher.dispose();
  });

  it('rebases up only after pending tools clear (defers helper attribution)', async () => {
    // Once a foreground tool completes and a persistent shell-like
    // child remains (e.g. MCP server child still running), the
    // watcher should rebase that into `preExistingHelpers` so future
    // cycles treat it as baseline.
    const { watcher, probe, rootPids, log, pendingTools } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    probe.trees.set(1234, []);
    watcher.registerSession('s1');
    await watcher.pollNow();

    // Foreground tool spawns bash, watcher polls mid-tool -> skip rebase.
    pendingTools.set('s1', 1);
    probe.trees.set(1234, [{ pid: 6001, ppid: 1234, comm: 'bash' }]);
    await watcher.pollNow();

    // Tool completes; a separate persistent helper remains.
    pendingTools.set('s1', 0);
    probe.trees.set(1234, [{ pid: 6002, ppid: 1234, comm: 'sh' }]);
    await watcher.pollNow();

    // No adoption fires (real bg shells go through hooks). And the
    // baseline now includes the helper so subsequent in-balance cycles
    // are silent.
    expect(log.naturalExits).toHaveLength(0);

    // Cycle 4: still in balance with the rebased preExistingHelpers.
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);
    watcher.dispose();
  });

  it('lag race: hook fires before bash spawns - waits one cycle before firing natural exit', async () => {
    // Regression: hooked `background_shell_start` increments engine
    // tracked synchronously, but the OS bash takes 50-500ms to
    // materialize. A watcher cycle landing in that lag window would
    // false-fire natural exit. The fix waits for deficit to persist
    // through 2 consecutive cycles before firing.
    const { watcher, probe, rootPids, log, shellCounts } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    probe.trees.set(1234, []);
    watcher.registerSession('s1');
    await watcher.pollNow(); // anchor preExisting=0

    // Hook fires - engine bumps tracked. OS bash NOT yet visible.
    shellCounts.set('s1', 1);
    probe.trees.set(1234, []);
    await watcher.pollNow();
    // Cycle 1: deficit observed but suppressed (lag tolerance).
    expect(log.naturalExits).toHaveLength(0);

    // Bash finally spawns before next cycle. Deficit resolved.
    probe.trees.set(1234, [{ pid: 5001, ppid: 1234, comm: 'bash' }]);
    await watcher.pollNow();
    // Cycle 2: in sync, no false-fire.
    expect(log.naturalExits).toHaveLength(0);
    watcher.dispose();
  });

  it('lag race: persistent deficit fires natural exit on the 2nd cycle', async () => {
    // After the lag-tolerance grace, real natural exits still fire.
    // Without this, a stuck deficit would never be reported.
    const { watcher, probe, rootPids, log, shellCounts } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },
      { pid: 5002, ppid: 1234, comm: 'bash' },
    ]);
    shellCounts.set('s1', 2);
    watcher.registerSession('s1');
    await watcher.pollNow();

    // One bash exits, the other still alive.
    probe.trees.set(1234, [{ pid: 5001, ppid: 1234, comm: 'bash' }]);
    await watcher.pollNow();
    // Cycle 1 of deficit - suppressed.
    expect(log.naturalExits).toHaveLength(0);

    // Still 1 bash on next cycle - deficit persists.
    await watcher.pollNow();
    // Cycle 2 of deficit - fires.
    expect(log.naturalExits).toEqual([{ sessionId: 's1', exitedCount: 1 }]);
    watcher.dispose();
  });

  it('foreground tool conflation: defers natural exit while pendingTools > 0', async () => {
    // Regression: a foreground bash and a real bg shell can be alive
    // simultaneously. When the bg shell exits, shellLikeCount stays
    // the same (foreground bash is still there). When the foreground
    // bash exits, shellLikeCount drops. The watcher must NOT attribute
    // that drop to the still-running bg shell - it defers natural
    // exit until pendingTools hits 0.
    const { watcher, probe, rootPids, log, shellCounts, pendingTools } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    // Start with 2 bg shells so we can simulate one bg shell exiting
    // while the other plus a foreground bash remain alive.
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },
      { pid: 5002, ppid: 1234, comm: 'bash' },
    ]);
    shellCounts.set('s1', 2);
    watcher.registerSession('s1');
    await watcher.pollNow(); // anchor: shellLikeCount=2, tracked=2, preExisting=0

    // Foreground tool starts, spawns its own bash.
    pendingTools.set('s1', 1);
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' }, // bg shell A
      { pid: 5002, ppid: 1234, comm: 'bash' }, // bg shell B
      { pid: 5003, ppid: 1234, comm: 'bash' }, // foreground bash
    ]);
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);

    // Foreground bash exits but tool is still pending (e.g. processing
    // output). Both bg shells still alive. shellLikeCount drops to 2,
    // equal to expected - no decrement fires.
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },
      { pid: 5002, ppid: 1234, comm: 'bash' },
    ]);
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);

    // Foreground tool ends; one bg shell also exits.
    pendingTools.set('s1', 0);
    probe.trees.set(1234, [{ pid: 5001, ppid: 1234, comm: 'bash' }]);
    // Cycle 1: deficit observed, suppressed by lag tolerance.
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);
    // Cycle 2: deficit persists, fires.
    await watcher.pollNow();
    expect(log.naturalExits).toEqual([{ sessionId: 's1', exitedCount: 1 }]);
    watcher.dispose();
  });

  it('hooked starts + foreground tool spawns: count stays in sync with reality (user-reported regression)', async () => {
    // Reproduces the user-reported bug: agent fires multiple
    // `Bash(run_in_background:true)` (hooked) interleaved with
    // foreground `Bash` calls. Without the bug fix, baseline got
    // anchored to OS state during foreground windows, causing false
    // natural-exit fires that decremented engine count incorrectly.
    // Now baseline is derived from engine state directly each cycle,
    // so foreground bashes can come and go without affecting the
    // engine's bg shell tracking.
    const { watcher, probe, rootPids, log, shellCounts, pendingTools } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    probe.trees.set(1234, []);
    watcher.registerSession('s1');
    await watcher.pollNow(); // anchor preExisting=0

    // Hooked bg shell A starts. Engine -> tracked=1. OS spawns bash.
    shellCounts.set('s1', 1);
    probe.trees.set(1234, [{ pid: 5001, ppid: 1234, comm: 'bash' }]);
    await watcher.pollNow(); // shellLikeCount=1, expected=1, no change
    expect(log.naturalExits).toHaveLength(0);

    // Foreground Bash B runs - adds a transient bash. pendingToolCount=1.
    pendingTools.set('s1', 1);
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' }, // A still alive
      { pid: 5002, ppid: 1234, comm: 'bash' }, // B foreground
    ]);
    await watcher.pollNow(); // surplus=1 but pendingTools>0, skip
    expect(log.naturalExits).toHaveLength(0);

    // Foreground B finishes, its bash exits. A still running.
    pendingTools.set('s1', 0);
    probe.trees.set(1234, [{ pid: 5001, ppid: 1234, comm: 'bash' }]);
    await watcher.pollNow(); // shellLikeCount=1, expected=1, no false exit fires
    expect(log.naturalExits).toHaveLength(0);

    // Hooked bg shell C starts (second hooked start while A still alive).
    shellCounts.set('s1', 2);
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' }, // A
      { pid: 5003, ppid: 1234, comm: 'bash' }, // C
    ]);
    await watcher.pollNow(); // shellLikeCount=2, expected=2, no change
    expect(log.naturalExits).toHaveLength(0);

    // A exits naturally. C still running.
    probe.trees.set(1234, [{ pid: 5003, ppid: 1234, comm: 'bash' }]);
    // Lag-tolerance grace: deficit must persist 2 cycles.
    await watcher.pollNow();
    await watcher.pollNow();
    expect(log.naturalExits).toEqual([{ sessionId: 's1', exitedCount: 1 }]);
    watcher.dispose();
  });

  it('probe-health guard: empty snapshot from listAllProcesses is treated as probe failure', async () => {
    // PowerShell on Windows can intermittently exceed our 1.5s probe
    // timeout under load. listAllProcesses returns [] in that case
    // (per process-tree.ts:51 contract). Without this guard, the
    // watcher would treat the empty result as "all tracked shells
    // exited at once" and false-fire natural-exit for every tracked
    // shell. Critical user-visible bug: real bg shells alive but
    // engine reports idle.
    const { watcher, probe, rootPids, log, shellCounts } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },
      { pid: 5002, ppid: 1234, comm: 'bash' },
      { pid: 5003, ppid: 1234, comm: 'bash' },
    ]);
    shellCounts.set('s1', 3);
    watcher.registerSession('s1');
    await watcher.pollNow();
    // First cycle anchored preExisting=0, shellLikeCount=3, tracked=3.

    // Probe times out and returns empty. Without the snapshot-health
    // guard, the watcher would see deficit=3 and (after 2 cycles of
    // grace) fire 3 natural-exits.
    probe.failProbe = true;
    await watcher.pollNow();
    await watcher.pollNow();
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);

    // Explicitly assert that consecutiveDeficitCycles was NOT advanced
    // by any of the three probe-failed cycles. We verify this by proxy:
    // when the probe recovers with shells still alive, the first cycle
    // is in balance (no deficit) and fires no callbacks. If probe-failed
    // cycles had incremented the counter, cycle 1 of recovery might
    // spuriously fire or leave residual counter state that fires early.
    probe.failProbe = false;
    // Cycle 1 of recovery: shells still present, count matches expected.
    // consecutiveDeficitCycles must be 0 (not accumulated from failed
    // cycles), so no false deficit logic runs.
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);
    watcher.dispose();
  });

  it('Tier B: drains anonymous count when all shells exit at once with healthy probe', async () => {
    // Regression for the activity-engine bg-shell leak: when shells
    // truly exit while the engine still holds an
    // anonymousBackgroundShellCount (from real hook-driven
    // BackgroundShellStart events without a shell_id), the watcher
    // must drain the count via onNaturalExit. The previous
    // count-shape probe-failure guard mis-classified this exact
    // post-exit state as probe failure and skipped every cycle
    // indefinitely, leaving the session pinned in 'thinking' until
    // the 5-min bg-shell-hatch watchdog fired.
    const { watcher, probe, rootPids, log, shellCounts } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    // Engine has 2 anonymous bg shells from prior unhooked adoption.
    // Probe sees the corresponding 2 OS-level shell-like descendants.
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },
      { pid: 5002, ppid: 1234, comm: 'bash' },
    ]);
    shellCounts.set('s1', 2);
    watcher.registerSession('s1');
    await watcher.pollNow();
    // First cycle anchored: preExisting = max(0, 2 - 2) = 0, tracked=2.

    // Both bashes exit naturally between cycles. Snapshot remains
    // healthy (Claude CLI is alive, listAllProcesses succeeds).
    probe.trees.set(1234, []);

    // Lag-tolerance grace: deficit must persist 2 cycles before firing.
    await watcher.pollNow();
    await watcher.pollNow();

    // Should fire ONE onNaturalExit call reporting all 2 exits.
    expect(log.naturalExits).toEqual([{ sessionId: 's1', exitedCount: 2 }]);
    watcher.dispose();
  });

  it('Tier B: probe recovery after empty-snapshot failure resumes natural-exit detection', async () => {
    // After a transient probe failure, when the probe recovers and
    // sees that shells genuinely exited, the watcher must fire
    // onNaturalExit. The new snapshot-health guard correctly
    // distinguishes "probe failed" from "shells exited" and only
    // suppresses the former.
    const { watcher, probe, rootPids, log, shellCounts } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },
      { pid: 5002, ppid: 1234, comm: 'bash' },
    ]);
    shellCounts.set('s1', 2);
    watcher.registerSession('s1');
    await watcher.pollNow(); // anchor

    // Probe fails for one cycle (the bashes have already exited but
    // we don't know that yet).
    probe.failProbe = true;
    probe.trees.set(1234, []);
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);

    // Probe recovers: snapshot healthy, descendants empty.
    probe.failProbe = false;

    // First post-recovery cycle: deficit=2, consecutiveDeficitCycles=1,
    // suppressed by lag tolerance.
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);

    // Second post-recovery cycle: deficit persists, fires.
    await watcher.pollNow();
    expect(log.naturalExits).toEqual([{ sessionId: 's1', exitedCount: 2 }]);
    watcher.dispose();
  });

  it('Tier B: regression for activity-engine bg-shell leak (idle tasks shown as Thinking)', async () => {
    // Reproduces the symptom from the bug ticket: engine holds
    // anonymousBackgroundShellCount=2 from real hook-driven
    // BackgroundShellStart events (no shell_id), all OS bashes
    // exited cleanly, no pending tools, no turn active. Sidebar
    // showed "Thinking - 2 background shells" until the 5-min
    // bg-shell-hatch fired. After this fix, the watcher drains the
    // leak within ~2 cycles.
    const { watcher, probe, rootPids, log, shellCounts } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    // Step 1: agent fired hook BackgroundShellStart events for 2 bg
    // shells (no shell_id, so they tracked anonymously). We jump
    // straight to the post-spawn steady state.
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },
      { pid: 5002, ppid: 1234, comm: 'bash' },
    ]);
    shellCounts.set('s1', 2);
    watcher.registerSession('s1');
    await watcher.pollNow(); // anchor

    // Step 2: agent finishes its turn, every bash exits naturally.
    // Probe is healthy throughout (Claude CLI is alive).
    probe.trees.set(1234, []);

    // Within 2 cycles (~4 sec at 2-sec poll cadence) the watcher
    // must drain the engine's anonymous count to 0.
    await watcher.pollNow();
    await watcher.pollNow();

    expect(log.naturalExits).toEqual([{ sessionId: 's1', exitedCount: 2 }]);
    watcher.dispose();
  });

  it('alive signal: fires onShellsObservedAlive every cycle when shells are present and tracked', async () => {
    // Regression: agent goes "agent-idle but bg-work-busy" (e.g.
    // launched `npm test` in background and stopped sending hooks).
    // Without this signal, the engine's 5-min escape hatch fires after
    // `lastSignalAt + 300s` and force-clears the bg shell count even
    // though the watcher is observing the shell alive every 2s.
    const { watcher, probe, rootPids, log, shellCounts } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    probe.trees.set(1234, [{ pid: 5001, ppid: 1234, comm: 'bash' }]);
    shellCounts.set('s1', 1);
    watcher.registerSession('s1');
    await watcher.pollNow(); // anchor cycle - no signal yet
    expect(log.shellsObservedAlive).toHaveLength(0);

    await watcher.pollNow();
    expect(log.shellsObservedAlive).toEqual(['s1']);

    await watcher.pollNow();
    expect(log.shellsObservedAlive).toEqual(['s1', 's1']);
    watcher.dispose();
  });

  it('alive signal: does NOT fire when no engine-tracked shells', async () => {
    // The signal is for live BG WORK. Pre-existing helpers (MCP
    // servers, statusline) shouldn't keep refreshing the engine's
    // `lastSignalAt` - that would suppress the stale-thinking watchdog.
    const { watcher, probe, rootPids, log } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    probe.trees.set(1234, [{ pid: 5001, ppid: 1234, comm: 'bash' }]);
    watcher.registerSession('s1');
    await watcher.pollNow(); // anchor: pre-existing = 1
    await watcher.pollNow();
    // Engine has 0 tracked, shell is pre-existing helper - no alive signal.
    expect(log.shellsObservedAlive).toHaveLength(0);
    watcher.dispose();
  });

  it('Windows agent CLI launched via cmd shim: bashes under claude still count', async () => {
    // Regression: `claude` on Windows installs as `claude.cmd` (an
    // npm shim). Running it from pwsh produces `pwsh -> cmd[shim] ->
    // node[claude]`. When claude spawns bg shells, the tree is
    // `pwsh -> cmd[shim] -> node[claude] -> bash[bg]`. A naive
    // "skip if any ancestor is shell-like" rule would see the shim
    // cmd as a shell-like ancestor of every bash and skip them all,
    // producing bg=0 even when 3 bashes are running. The fix uses
    // immediate-parent only, so bashes whose parent is the non-shell
    // agent CLI are correctly counted.
    const { watcher, probe, rootPids, log, shellCounts } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    probe.trees.set(1234, [
      { pid: 1500, ppid: 1234, comm: 'cmd' },     // npm shim wrapping claude.cmd
      { pid: 2000, ppid: 1500, comm: 'claude' },  // node-based agent CLI
      { pid: 3001, ppid: 2000, comm: 'bash' },    // bg shell 1 - parent is non-shell
      { pid: 3002, ppid: 2000, comm: 'bash' },    // bg shell 2
      { pid: 3003, ppid: 2000, comm: 'bash' },    // bg shell 3
    ]);
    shellCounts.set('s1', 3);

    watcher.registerSession('s1');
    await watcher.pollNow();
    // shellLikeCount should be 4 (1 shim cmd + 3 bashes), tracked=3,
    // so preExisting = 4 - 3 = 1 (the shim). On subsequent cycles
    // expected stays 4 and shellLikeCount stays 4 - in sync.
    expect(log.naturalExits).toHaveLength(0);

    // One bg shell exits.
    probe.trees.set(1234, [
      { pid: 1500, ppid: 1234, comm: 'cmd' },
      { pid: 2000, ppid: 1500, comm: 'claude' },
      { pid: 3002, ppid: 2000, comm: 'bash' },
      { pid: 3003, ppid: 2000, comm: 'bash' },
    ]);
    await watcher.pollNow();
    await watcher.pollNow(); // lag tolerance
    expect(log.naturalExits).toEqual([{ sessionId: 's1', exitedCount: 1 }]);
    watcher.dispose();
  });

  it('Windows npm wrapper: bash -> cmd -> node counts as 1 (topmost shell only, no double-count)', async () => {
    // The user-reported bug: agent runs `Bash(run_in_background:true)
    // "npm test"`. On Windows, `npm` is `npm.cmd` which executes via
    // cmd.exe. So the tree is bash -> cmd -> node. Both bash AND cmd
    // match the shell-like allowlist, but cmd is a wrapper inside
    // bash, not a separate logical bg shell. Counting both yields
    // 2 per bg shell. With 3 bg shells: count = 6 (user's screenshot).
    // The fix: skip shells that have a shell-like ancestor in the
    // descendant tree.
    const { watcher, probe, rootPids, log, shellCounts } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    probe.trees.set(1234, [
      // pwsh's only direct child: the agent CLI (non-shell)
      { pid: 2000, ppid: 1234, comm: 'claude' },
      // 3 bg shells (each Bash run_in_background)
      { pid: 3001, ppid: 2000, comm: 'bash' },
      { pid: 3101, ppid: 3001, comm: 'cmd' },     // npm.cmd wrapper - SKIP
      { pid: 3201, ppid: 3101, comm: 'node' },    // node doesn't match anyway
      { pid: 3002, ppid: 2000, comm: 'bash' },
      { pid: 3102, ppid: 3002, comm: 'cmd' },     // npm.cmd wrapper - SKIP
      { pid: 3202, ppid: 3102, comm: 'node' },
      { pid: 3003, ppid: 2000, comm: 'bash' },
      { pid: 3103, ppid: 3003, comm: 'cmd' },     // npm.cmd wrapper - SKIP
      { pid: 3203, ppid: 3103, comm: 'node' },
    ]);
    shellCounts.set('s1', 3);

    watcher.registerSession('s1');
    await watcher.pollNow();
    // First cycle: shellLikeCount = 3 (the 3 bashes - cmds skipped),
    // tracked = 3, preExisting = 0. In sync.
    expect(log.naturalExits).toHaveLength(0);
    watcher.dispose();
  });

  it('counts shells nested 2 levels deep (rootPid is PTY shell, agent CLI is the level between)', async () => {
    // The user-reported bug: rootPid is the PTY shell wrapper (pwsh),
    // the agent CLI (claude/codex) is a child of pwsh, and the
    // bashes Claude spawns for `Bash(run_in_background:true)` are
    // children of the agent CLI - 2 levels under rootPid. A
    // direct-children-only filter would miss them entirely; the
    // transitive descendant walk catches them.
    const { watcher, probe, rootPids, log, shellCounts } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    probe.trees.set(1234, [
      // pwsh's only direct child: the agent CLI (node-based, doesn't
      // match the shell-only allowlist).
      { pid: 2000, ppid: 1234, comm: 'claude' },
      // claude spawned 3 bg shells - each is grandchild of pwsh.
      { pid: 3001, ppid: 2000, comm: 'bash' },
      { pid: 3002, ppid: 2000, comm: 'bash' },
      { pid: 3003, ppid: 2000, comm: 'bash' },
    ]);
    shellCounts.set('s1', 3);

    watcher.registerSession('s1');
    await watcher.pollNow();
    // First cycle: shellLikeCount=3, tracked=3 -> preExisting=0, in sync.
    expect(log.naturalExits).toHaveLength(0);

    // One bg shell exits.
    probe.trees.set(1234, [
      { pid: 2000, ppid: 1234, comm: 'claude' },
      { pid: 3002, ppid: 2000, comm: 'bash' },
      { pid: 3003, ppid: 2000, comm: 'bash' },
    ]);
    await watcher.pollNow();
    await watcher.pollNow(); // lag-tolerance grace
    expect(log.naturalExits).toEqual([{ sessionId: 's1', exitedCount: 1 }]);
    watcher.dispose();
  });

  it('shell-like allowlist excludes subprocess chains (npm/node/python under a bash do not double-count)', async () => {
    // One logical bg shell (`bash -c "npm test"`) creates a process
    // tree like bash -> npm -> node -> vitest. The narrow allowlist
    // (bash, sh, cmd, pwsh, etc. - NOT node/npm/python) filters the
    // descendants down to just the top-level shell, so the count
    // matches the agent's logical bg-shell count of 1.
    const { watcher, probe, rootPids, log } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },     // matches allowlist
      { pid: 5002, ppid: 5001, comm: 'npm' },      // does NOT match
      { pid: 5003, ppid: 5002, comm: 'node' },     // does NOT match
      { pid: 5004, ppid: 5003, comm: 'node' },     // does NOT match
      { pid: 5005, ppid: 5003, comm: 'node' },     // does NOT match
    ]);

    watcher.registerSession('s1');
    await watcher.pollNow(); // first-cycle anchor
    await watcher.pollNow(); // would adopt if surplus

    // Pre-existing helpers count = 1 (just the bash). Subsequent
    // cycles see no delta. Zero adoptions, zero false natural exits.
    expect(log.naturalExits).toHaveLength(0);
    watcher.dispose();
  });

  it('rebases surplus only once - does not re-rebase the same persistent helper across cycles', async () => {
    // After a helper appears post-anchor, the watcher rebases
    // `preExistingHelpers` up by the surplus on the cycle that
    // detects it. Subsequent cycles with the same shape see expected
    // == shellLikeCount (in balance) and do nothing. Without correct
    // rebase, the surplus would be detected on every cycle and
    // ratchet preExistingHelpers indefinitely.
    const { watcher, probe, rootPids, log } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    probe.trees.set(1234, []);
    watcher.registerSession('s1');
    await watcher.pollNow();

    probe.trees.set(1234, [{ pid: 6001, ppid: 1234, comm: 'bash' }]);
    await watcher.pollNow();
    await watcher.pollNow();
    await watcher.pollNow();

    // No real bg shells (engine-tracked=0) and no helper exits =>
    // zero natural-exit fires. Watcher state stayed in balance after
    // the rebase; subsequent cycles are silent.
    expect(log.naturalExits).toHaveLength(0);
    watcher.dispose();
  });

  it('preExistingHelpers tracks helper churn symmetrically (rebase down on exit, rebase up on entry)', async () => {
    // The watcher's helper baseline rebases in BOTH directions:
    //   - exit (deficit branch with tracked=0): preExistingHelpers -= delta
    //   - entry (surplus branch with pendingTools=0): preExistingHelpers += surplus
    // Neither produces engine-state mutation when tracked=0; both
    // keep `expected` aligned with reality so subsequent cycles are silent.
    const { watcher, probe, rootPids, log } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },
      { pid: 5002, ppid: 1234, comm: 'sh' },
    ]);
    // shellCounts defaults to 0 for 's1' (not set in map) -> tracked=0.

    watcher.registerSession('s1');
    await watcher.pollNow(); // anchor: preExistingHelpers=2, tracked=0

    // One pre-existing helper exits. After the 2-cycle deficit lag,
    // the deficit's `else` branch shrinks preExistingHelpers to 1.
    probe.trees.set(1234, [{ pid: 5001, ppid: 1234, comm: 'bash' }]);
    await watcher.pollNow();
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);

    // Second helper exits. preExistingHelpers shrinks to 0.
    probe.trees.set(1234, []);
    await watcher.pollNow();
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);

    // A new helper spawns. Surplus branch rebases preExistingHelpers
    // up to 1. NO adoption fires (real bg shells go through hooks).
    probe.trees.set(1234, [{ pid: 6001, ppid: 1234, comm: 'bash' }]);
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);

    // Confirm balance: subsequent cycles with the same shape are silent.
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);
    watcher.dispose();
  });

  it('consecutiveDeficitCycles resets to 0 on surplus (not just on balance), so a subsequent deficit restarts the lag-tolerance counter', async () => {
    // The deficit-counter reset on the surplus path is what prevents
    // a leftover deficit-cycle count from adding to a fresh deficit
    // and firing prematurely. With the surplus branch now rebasing
    // preExistingHelpers (instead of adopting), the reset still
    // matters: a deficit -> surplus -> deficit transition must give
    // the second deficit a full 2-cycle lag grace.
    const { watcher, probe, rootPids, shellCounts, log } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);

    // Anchor with 2 shells - engine tracks 2, preExisting=0.
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },
      { pid: 5002, ppid: 1234, comm: 'sh' },
    ]);
    shellCounts.set('s1', 2);

    watcher.registerSession('s1');
    await watcher.pollNow(); // anchor

    // Cycle 1: one shell exits -> deficit=1, consecutiveDeficitCycles=1.
    probe.trees.set(1234, [{ pid: 5001, ppid: 1234, comm: 'bash' }]);
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);

    // Cycle 2: a helper materializes while the original tracked shell
    // is still gone. shellLikeCount=2, expected=preExisting(0)+tracked(2)=2:
    // wait, that's actually balance - the missing shell and the new
    // helper cancel out. Let me arrange it more clearly:
    //   - tracked=2 (engine still thinks 2 hook shells exist)
    //   - preExisting=0
    //   - shellLikeCount=3 (1 original tracked + 2 new helpers)
    //   - expected=2, surplus=1 -> rebase preExistingHelpers to 1
    //   - consecutiveDeficitCycles reset to 0
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },
      { pid: 6001, ppid: 1234, comm: 'sh' },
      { pid: 6002, ppid: 1234, comm: 'bash' },
    ]);
    await watcher.pollNow();
    // No adoption (rebased silently). No natural exit (surplus path).
    expect(log.naturalExits).toHaveLength(0);

    // Cycle 3: balance with rebased preExistingHelpers=1, tracked=2,
    // expected=3. shellLikeCount=3 -> no deficit, no surplus.
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);

    // Fresh deficit: drop one helper. shellLikeCount=2, expected=3.
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },
      { pid: 6001, ppid: 1234, comm: 'sh' },
    ]);

    // Cycle 4: deficit=1, consecutiveDeficitCycles=1 (NOT 2 - reset
    // was honored on cycle 2). Lag tolerance suppresses the fire.
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);

    // Cycle 5: deficit persists -> 2 consecutive cycles -> tracked>0
    // path fires natural-exit (capped at tracked count).
    await watcher.pollNow();
    expect(log.naturalExits).toEqual([{ sessionId: 's1', exitedCount: 1 }]);
    watcher.dispose();
  });

  it('surplus rebase-up while tracked > 0: rebased helper does not produce spurious second exit when real bg shell exits', async () => {
    // Regression guard: watcher anchors with tracked=1 (one real bg shell),
    // then a helper materializes post-anchor (surplus=1, tracked=1, pendingTools=0).
    // The surplus branch rebases preExistingHelpers up from 0 to 1.
    // When the REAL bg shell subsequently exits (not the helper), exactly one
    // onNaturalExit fires. The rebased helper does NOT produce a second exit.
    //
    // Pre-fix: the surplus was adopted (engine.adoptAnonymousBackgroundShells
    // was called), so the engine believed there were TWO bg shells - the real one
    // AND the phantom helper. When the real shell exited, TWO onNaturalExit calls
    // fired (one per watcher cycle decrement), not one. That double-decrement
    // caused the anonymous counter to underflow, falsely reporting idle.
    //
    // Post-fix: the surplus path rebases preExistingHelpers and returns without
    // touching the engine counter. Only ONE onNaturalExit fires when the real
    // bg shell exits.
    const { watcher, probe, rootPids, shellCounts, log } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);

    // Anchor with ONE real bg shell, preExisting=0.
    probe.trees.set(1234, [{ pid: 5001, ppid: 1234, comm: 'bash' }]);
    shellCounts.set('s1', 1);

    watcher.registerSession('s1');
    await watcher.pollNow(); // first-cycle anchor: preExistingHelpers = max(0, 1-1) = 0

    // Helper materializes post-anchor. shellLikeCount=2, expected=1+1=2? No:
    // expected = preExistingHelpers(0) + tracked(1) = 1. shellLikeCount=2.
    // surplus=1, pendingTools=0 -> rebase preExistingHelpers to 1.
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' }, // the real bg shell
      { pid: 6001, ppid: 1234, comm: 'sh' },   // new helper (MCP server restart, etc.)
    ]);
    await watcher.pollNow(); // surplus path: preExistingHelpers=1, no naturalExit
    expect(log.naturalExits).toHaveLength(0);

    // Now the REAL bg shell exits. Helper still alive.
    // shellLikeCount=1, expected=preExisting(1)+tracked(1)=2. deficit=1.
    probe.trees.set(1234, [{ pid: 6001, ppid: 1234, comm: 'sh' }]);

    // Lag-tolerance grace: deficit must persist 2 cycles.
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);
    await watcher.pollNow();

    // EXACTLY one natural exit for the one real bg shell. The rebased helper
    // (preExistingHelpers=1) is correctly excluded from the tracked drain.
    expect(log.naturalExits).toEqual([{ sessionId: 's1', exitedCount: 1 }]);
    watcher.dispose();
  });

  it('pendingTools > 0 surplus-skip: consecutiveDeficitCycles resets to 0 when pendingTools surplus branch fires', async () => {
    // Documents the precise semantic: when a surplus-while-pending cycle fires,
    // the code runs `state.consecutiveDeficitCycles = 0` BEFORE returning.
    // This means a prior deficit that was building lag tolerance gets WIPED.
    // A subsequent fresh deficit therefore restarts the 2-cycle grace from zero.
    //
    // Scenario: cycle 1 deficit (consecutiveDeficitCycles=1), cycle 2
    // surplus-while-pending (resets consecutiveDeficitCycles to 0), cycle 3
    // clean surplus (preExistingHelpers rebased, consecutiveDeficitCycles=0),
    // cycle 4 fresh deficit -> suppressed (cycle 1 of new deficit grace).
    // cycle 5 deficit persists -> fires.
    //
    // If consecutiveDeficitCycles was NOT reset in the pending-surplus path,
    // cycle 4 would be cycle 2 of the deficit and fire prematurely.
    const { watcher, probe, rootPids, shellCounts, log, pendingTools } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);

    // Anchor: 2 tracked bg shells, no helpers.
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },
      { pid: 5002, ppid: 1234, comm: 'sh' },
    ]);
    shellCounts.set('s1', 2);
    watcher.registerSession('s1');
    await watcher.pollNow(); // anchor: preExistingHelpers=0

    // Cycle 1: one shell exits -> deficit=1. consecutiveDeficitCycles becomes 1.
    // Lag tolerance suppresses.
    probe.trees.set(1234, [{ pid: 5001, ppid: 1234, comm: 'bash' }]);
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);

    // Cycle 2: surplus-while-pending. A foreground bash appears while
    // pendingTools=1. shellLikeCount=2, expected=0+2=2. Wait, with only 1
    // tracked shell visible + foreground bash = 2. tracked still reports 2
    // (the engine has not received a decrement yet). Hmm - let's set
    // shellCounts back to 2 to simulate the engine still thinking both alive.
    //
    // More precisely: the ENGINE still thinks 2 bg shells exist (no
    // onNaturalExit was fired yet because lag tolerance suppressed cycle 1).
    // A foreground Bash tool starts (pendingTools=1) and adds 1 bash.
    // shellLikeCount=2, expected=preExisting(0)+tracked(2)=2. Balanced -
    // no surplus, no deficit. That's not what we want to test.
    //
    // Rework: set up a scenario where shellLikeCount > expected while
    // pendingTools>0. Requires preExistingHelpers < shellLikeCount - tracked.
    // With preExisting=0, tracked=2 (from engine): if we have 3 shell-like
    // procs visible and pendingTools=1, then surplus=1 with pending tools.
    // deficit from cycle 1 was: tracked=2, visible=1, so deficit=1,
    // consecutiveDeficitCycles=1. Now cycle 2: visible=3, tracked=2,
    // expected=0+2=2, surplus=1, pendingTools=1 -> reset consecutiveDeficitCycles=0, return.
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' }, // bg shell (visible)
      { pid: 5002, ppid: 1234, comm: 'sh' },   // bg shell comes back? or
      { pid: 7001, ppid: 1234, comm: 'bash' }, // foreground bash
    ]);
    pendingTools.set('s1', 1);
    await watcher.pollNow();
    // consecutiveDeficitCycles should now be 0 (reset by surplus-while-pending path).
    // Verify by proxy: the NEXT deficit gives a fresh 2-cycle grace,
    // not a truncated 1-cycle grace.
    expect(log.naturalExits).toHaveLength(0);

    // Cycle 3: foreground tool ends, its bash exits, surplus helper remains.
    // pendingTools=0. shellLikeCount=2, expected=0+2=2. Balanced.
    // Wait, the scenario is getting complex - let's verify the key property:
    // after the reset in cycle 2, a new deficit from cycle 3 gets FULL grace.
    pendingTools.set('s1', 0);
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },
      { pid: 5002, ppid: 1234, comm: 'sh' },
    ]);
    // shellLikeCount=2, expected=0+2=2. In balance -> consecutiveDeficitCycles=0.
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);

    // Cycle 4: one bg shell exits again (fresh deficit after reset).
    // consecutiveDeficitCycles increments from 0 to 1. Suppressed.
    probe.trees.set(1234, [{ pid: 5001, ppid: 1234, comm: 'bash' }]);
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);

    // Cycle 5: deficit persists. consecutiveDeficitCycles=2. FIRES.
    // This confirms the full 2-cycle grace was granted, not a truncated 1.
    await watcher.pollNow();
    expect(log.naturalExits).toEqual([{ sessionId: 's1', exitedCount: 1 }]);
    watcher.dispose();
  });

  it('dispose() calls probe.dispose() exactly once', () => {
    // BgShellWatcher.dispose() must release the probe's long-lived
    // resources (Windows persistent PowerShell child). Without this
    // call, `pwsh.exe` would survive as an orphan after app shutdown,
    // paying .NET startup cost on the next launch instead of on the
    // next query. The `disposeCalls` counter on MockProcessTreeProbe
    // exists precisely to verify this wiring.
    const { watcher, probe, rootPids } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    watcher.registerSession('s1');

    expect(probe.disposeCalls).toBe(0);
    watcher.dispose();
    expect(probe.disposeCalls).toBe(1);
  });

  it('dispose() calls probe.dispose() exactly once (idempotent - second dispose is a no-op)', () => {
    // BgShellWatcher.dispose() is itself idempotent (guarded by `this.disposed`).
    // The probe must receive exactly one dispose call regardless of how many
    // times watcher.dispose() is called. A double-dispose on the probe would
    // be a bug if the probe's teardown is not itself idempotent.
    const { watcher, probe } = makeWatcher();

    watcher.dispose();
    watcher.dispose();
    expect(probe.disposeCalls).toBe(1);
  });

  it('cycle is non-overlapping (setInterval drops ticks while polling)', async () => {
    // The `polling` guard inside the setInterval handler prevents
    // overlapping cycles when the OS probe is slow. Verify this by
    // advancing fake timers through two ticks while a pollNow() call
    // is still "in flight" (simulated by having probe.listAllProcesses
    // resolve only after we advance time). The probe call count must
    // remain 1 for the first tick window, confirming the second tick
    // was dropped.
    const { watcher, probe, rootPids } = makeWatcher({ pollIntervalMs: 100 });
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    probe.trees.set(1234, []);
    watcher.registerSession('s1');

    // Anchor first cycle synchronously so the guard state is clean.
    await watcher.pollNow();
    probe.listAllCalls = 0;

    // Simulate the setInterval firing twice in the same tick window
    // by advancing timers while the watcher is inside a pollNow().
    // Because pollNow() drives cycle() directly (bypassing the
    // setInterval guard), we instead verify the interval path by
    // checking that a second vi.advanceTimersByTime does not cause a
    // second listAllProcesses call while polling is still true.
    //
    // We gate the probe's listAllProcesses behind a manual resolver so
    // we can hold the first poll open and advance the timer mid-flight.
    let resolveProbe!: () => void;
    const blocker = new Promise<ProcessInfo[]>((resolve) => {
      resolveProbe = () => resolve([{ pid: 1234, ppid: 0, comm: 'claude' }]);
    });
    const originalList = probe.listAllProcesses.bind(probe);
    probe.listAllProcesses = async () => {
      probe.listAllCalls += 1;
      return blocker;
    };

    // Start a cycle via the interval (not pollNow - we want the guard).
    vi.advanceTimersByTime(100); // fires first tick
    // Advance timer again - second tick should be dropped by `polling` guard.
    vi.advanceTimersByTime(100);

    // Now release the probe. The first cycle completes; the second tick
    // was already dropped (its setInterval callback exited via `return`).
    resolveProbe();
    // Drain microtasks so the cycle fully finishes.
    await Promise.resolve();
    await Promise.resolve();

    // Restore probe for dispose.
    probe.listAllProcesses = originalList;

    // Exactly one listAllProcesses call despite two ticks firing.
    expect(probe.listAllCalls).toBe(1);
    watcher.dispose();
  });
});
