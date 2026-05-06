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
  /** Call counters for performance regression assertions. */
  listAllCalls = 0;
  listDescendantsCalls = 0;

  isAlive(pid: number): boolean {
    return this.alive.has(pid);
  }

  async listAllProcesses(): Promise<ProcessInfo[]> {
    this.listAllCalls += 1;
    const all: ProcessInfo[] = [];
    for (const descendants of this.trees.values()) {
      all.push(...descendants);
    }
    return all;
  }

  async listDescendants(rootPid: number): Promise<ProcessInfo[]> {
    this.listDescendantsCalls += 1;
    return this.trees.get(rootPid) ?? [];
  }
}

interface CallbackLog {
  naturalExits: Array<{ sessionId: string; exitedCount: number }>;
  unhookedAdoptions: Array<{ sessionId: string; adoptedCount: number }>;
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
  const log: CallbackLog = { naturalExits: [], unhookedAdoptions: [], shellPidExited: [], rootDied: [], shellsObservedAlive: [] };
  const rootPids = opts?.rootPidMap ?? new Map<string, number>();
  const shellCounts = opts?.shellCountMap ?? new Map<string, number>();
  const pendingTools = opts?.pendingToolMap ?? new Map<string, number>();

  const callbacks: BgShellWatcherCallbacks = {
    onNaturalExit(sessionId, exitedCount) {
      log.naturalExits.push({ sessionId, exitedCount });
    },
    onUnhookedBackgroundShells(sessionId, adoptedCount) {
      log.unhookedAdoptions.push({ sessionId, adoptedCount });
      // Mimic the engine: track the new shells so subsequent decrements
      // can be capped at the engine's tracked count.
      shellCounts.set(sessionId, (shellCounts.get(sessionId) ?? 0) + adoptedCount);
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

    // 2 of 3 disappear (leaves shellLikeCount=1, avoids the
    // probe-failure guard which suppresses suspicious drops to 0).
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

    // One of s1's shells dies; s2 unchanged. (Drop to 1, not 0, so the
    // probe-failure guard doesn't suppress.)
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

    expect(log.unhookedAdoptions).toHaveLength(0);
    expect(log.naturalExits).toHaveLength(0);
    watcher.dispose();
  });

  it('Tier B increment: adopts new shell-like descendants the engine does not know about', async () => {
    // The user-visible bug: agent runs MonitorBash / BashList / some
    // tool the hook directives do not catch. Engine never sees
    // background_shell_start. Watcher polls, sees more shell-like
    // descendants than baseline, adopts them as anonymous so the
    // session stays in `thinking` until they exit.
    const { watcher, probe, rootPids, log } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    // Cycle 1: nothing yet, baseline anchors at 0.
    probe.trees.set(1234, []);
    watcher.registerSession('s1');
    await watcher.pollNow();
    expect(log.unhookedAdoptions).toHaveLength(0);

    // Cycle 2: agent spawned 2 monitors via an unhooked tool.
    probe.trees.set(1234, [
      { pid: 6001, ppid: 1234, comm: 'bash' },
      { pid: 6002, ppid: 1234, comm: 'sh' },
    ]);
    await watcher.pollNow();

    expect(log.unhookedAdoptions).toEqual([{ sessionId: 's1', adoptedCount: 2 }]);
    watcher.dispose();
  });

  it('Tier B increment: subsequent natural exit decrements the previously-adopted count', async () => {
    // End-to-end round trip: adopt unhooked shells on cycle 2, then
    // observe their natural exit on cycle 3.
    const { watcher, probe, rootPids, log } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    probe.trees.set(1234, []);
    watcher.registerSession('s1');
    await watcher.pollNow(); // anchor at 0

    probe.trees.set(1234, [
      { pid: 6001, ppid: 1234, comm: 'bash' },
      { pid: 6002, ppid: 1234, comm: 'sh' },
    ]);
    await watcher.pollNow(); // adopt 2

    expect(log.unhookedAdoptions).toEqual([{ sessionId: 's1', adoptedCount: 2 }]);

    // One exits, one remains alive. (Probe-failure guard suppresses
    // drops to 0 when tracked > 0; drop to 1 so the test can observe
    // the natural-exit firing.)
    probe.trees.set(1234, [{ pid: 6001, ppid: 1234, comm: 'bash' }]);
    // Lag-tolerance grace: 2 cycles before natural exit fires.
    await watcher.pollNow();
    await watcher.pollNow();

    expect(log.naturalExits).toEqual([{ sessionId: 's1', exitedCount: 1 }]);
    watcher.dispose();
  });

  it('Tier B increment: skips adoption while engine has pending tools (foreground bash spawns)', async () => {
    // Regression: a foreground `Bash` / `BashOutput` / `BashList`
    // invocation spawns a short-lived direct-child bash. The engine
    // already counts it via pendingToolCount; the watcher must NOT
    // also adopt it as a bg shell or we double-count and inflate the
    // user-visible bg count for the duration of the foreground tool.
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

    // Pending tool: NO adoption fires. Baseline silently re-anchors so
    // when the bash exits, the decrement branch sees no surplus.
    expect(log.unhookedAdoptions).toHaveLength(0);

    // ToolEnd fires -> pendingToolCount drops. Bash exits same cycle.
    pendingTools.set('s1', 0);
    probe.trees.set(1234, []);
    await watcher.pollNow();

    // No spurious natural exit (we never adopted, so engine has nothing
    // to decrement; tracked count stayed at 0 throughout).
    expect(log.naturalExits).toHaveLength(0);
    watcher.dispose();
  });

  it('Tier B increment: adopts persistent surplus once pending tools clear', async () => {
    // Once the foreground tool completes (pendingToolCount drops to 0)
    // and a shell-like child remains, that's a real bg shell and gets
    // adopted on the next cycle.
    const { watcher, probe, rootPids, log, pendingTools } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    probe.trees.set(1234, []);
    watcher.registerSession('s1');
    await watcher.pollNow();

    // Foreground tool spawns bash, watcher polls mid-tool -> skip.
    pendingTools.set('s1', 1);
    probe.trees.set(1234, [{ pid: 6001, ppid: 1234, comm: 'bash' }]);
    await watcher.pollNow();
    expect(log.unhookedAdoptions).toHaveLength(0);

    // Tool completes and its transient bash exits. A separate
    // unhooked tool (e.g. MonitorBash) spawned a persistent shell.
    // After pendingToolCount drops, the watcher's next cycle adopts
    // the persistent shell as anonymous bg work.
    pendingTools.set('s1', 0);
    probe.trees.set(1234, [
      { pid: 6002, ppid: 1234, comm: 'sh' },
    ]);
    await watcher.pollNow();

    expect(log.unhookedAdoptions).toEqual([{ sessionId: 's1', adoptedCount: 1 }]);
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
    // Without this, a stuck deficit would never be reported. Use 2
    // shells dropping to 1 (instead of 1 dropping to 0) so the
    // probe-failure guard doesn't suppress.
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
    // Start with 2 bg shells so we can drop to 1 without hitting the
    // probe-failure guard.
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
    expect(log.unhookedAdoptions).toHaveLength(0); // pendingTools > 0, no adoption

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
    expect(log.unhookedAdoptions).toHaveLength(0);

    // Foreground Bash B runs - adds a transient bash. pendingToolCount=1.
    pendingTools.set('s1', 1);
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' }, // A still alive
      { pid: 5002, ppid: 1234, comm: 'bash' }, // B foreground
    ]);
    await watcher.pollNow(); // surplus=1 but pendingTools>0, skip
    expect(log.naturalExits).toHaveLength(0);
    expect(log.unhookedAdoptions).toHaveLength(0);

    // Foreground B finishes, its bash exits. A still running.
    pendingTools.set('s1', 0);
    probe.trees.set(1234, [{ pid: 5001, ppid: 1234, comm: 'bash' }]);
    await watcher.pollNow(); // shellLikeCount=1, expected=1, no false exit fires
    expect(log.naturalExits).toHaveLength(0);
    expect(log.unhookedAdoptions).toHaveLength(0);

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

  it('probe-failure guard: suspicious drop from N>0 to 0 with tracked>0 is treated as probe failure', async () => {
    // PowerShell on Windows can intermittently exceed our 1.5s probe
    // timeout under load. listDescendants returns [] in that case.
    // Without this guard, the watcher would treat the empty result as
    // "all tracked shells exited at once" and false-fire natural-exit
    // for every tracked shell. Critical user-visible bug: real bg
    // shells alive but engine reports idle.
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

    // Probe times out and returns empty. Without guard, watcher would
    // see deficit=3 and (after 2 cycles of grace) fire 3 natural-exits.
    probe.trees.set(1234, []);
    await watcher.pollNow();
    await watcher.pollNow();
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);

    // Probe recovers - shells were never gone.
    probe.trees.set(1234, [
      { pid: 5001, ppid: 1234, comm: 'bash' },
      { pid: 5002, ppid: 1234, comm: 'bash' },
      { pid: 5003, ppid: 1234, comm: 'bash' },
    ]);
    await watcher.pollNow();
    expect(log.naturalExits).toHaveLength(0);
    expect(log.unhookedAdoptions).toHaveLength(0);
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
    expect(log.unhookedAdoptions).toHaveLength(0);
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
    expect(log.unhookedAdoptions).toHaveLength(0);
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
    expect(log.unhookedAdoptions).toHaveLength(0);
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
    expect(log.unhookedAdoptions).toHaveLength(0);
    expect(log.naturalExits).toHaveLength(0);
    watcher.dispose();
  });

  it('Tier B increment: only adopts the delta on each cycle (does not re-adopt the same shells)', async () => {
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

    // Only ONE adoption fires across three cycles with the same shell.
    expect(log.unhookedAdoptions).toEqual([{ sessionId: 's1', adoptedCount: 1 }]);
    watcher.dispose();
  });

  it('cycle is non-overlapping (drops ticks while polling)', async () => {
    const { watcher, probe, rootPids, shellCounts } = makeWatcher();
    rootPids.set('s1', 1234);
    probe.alive.add(1234);
    shellCounts.set('s1', 0);
    watcher.registerSession('s1');

    // Drive multiple polls in fast succession
    const polls = await Promise.all([
      watcher.pollNow(),
      watcher.pollNow(),
      watcher.pollNow(),
    ]);
    // No assertion on the polls themselves - just that nothing throws
    // and dispose is clean.
    expect(polls).toHaveLength(3);
    watcher.dispose();
  });
});
