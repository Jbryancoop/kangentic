/**
 * Tests for resume-time bg-shell reconciliation. Uses a mock probe
 * to simulate the OS process tree at the moment of Kangentic restart.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { reconcileBgShellsOnResume } from '../../src/main/pty/activity/background-shell/resume';
import { ActivityEngine } from '../../src/main/pty/activity/engine';
import { BgShellWatcher } from '../../src/main/pty/activity/background-shell/watcher';
import type { ProcessInfo, ProcessTreeProbe } from '../../src/main/pty/activity/background-shell/process-tree';

class MockProbe implements ProcessTreeProbe {
  alive = new Set<number>();
  trees = new Map<number, ProcessInfo[]>();
  isAlive(pid: number): boolean {
    return this.alive.has(pid);
  }
  async listAllProcesses(): Promise<ProcessInfo[]> {
    const all: ProcessInfo[] = [];
    for (const descendants of this.trees.values()) {
      all.push(...descendants);
    }
    return all;
  }
  async listDescendants(rootPid: number): Promise<ProcessInfo[]> {
    return this.trees.get(rootPid) ?? [];
  }
}

const SESSION_ID = 'resume-session';
const ROOT_PID = 5000;

describe('reconcileBgShellsOnResume', () => {
  let engine: ActivityEngine;
  let probe: MockProbe;

  beforeEach(() => {
    vi.useFakeTimers();
    engine = new ActivityEngine(
      { onActivityChange() { /* no-op */ } },
      { idleStabilityWindowMs: 0 },
    );
    probe = new MockProbe();
  });

  afterEach(() => {
    engine.dispose();
    vi.useRealTimers();
  });

  it('adopts shell-like descendants as anonymous bg shells', async () => {
    probe.alive.add(ROOT_PID);
    probe.trees.set(ROOT_PID, [
      { pid: 5001, ppid: ROOT_PID, comm: 'bash' },
      { pid: 5002, ppid: ROOT_PID, comm: 'sh' },
      { pid: 5003, ppid: ROOT_PID, comm: 'cmd' },
      { pid: 5004, ppid: ROOT_PID, comm: 'mcp-server' },  // not shell-like
      { pid: 5005, ppid: ROOT_PID, comm: 'chrome' },       // not shell-like
    ]);
    engine.initSession(SESSION_ID);

    const result = await reconcileBgShellsOnResume({
      sessionId: SESSION_ID,
      rootPid: ROOT_PID,
      probe,
      engine,
      watcher: null,
    });

    expect(result.adoptedShellCount).toBe(3);
    expect(result.totalDescendantCount).toBe(5);
    const state = engine.getState(SESSION_ID)!;
    expect(state.anonymousBackgroundShellCount).toBe(3);
    expect(state.activity).toBe('thinking');
  });

  it('returns 0 when no descendants', async () => {
    probe.alive.add(ROOT_PID);
    engine.initSession(SESSION_ID);

    const result = await reconcileBgShellsOnResume({
      sessionId: SESSION_ID,
      rootPid: ROOT_PID,
      probe,
      engine,
      watcher: null,
    });

    expect(result.adoptedShellCount).toBe(0);
    expect(engine.getState(SESSION_ID)!.anonymousBackgroundShellCount).toBe(0);
  });

  it('returns 0 when rootPid is dead', async () => {
    // probe.alive does NOT contain ROOT_PID
    probe.trees.set(ROOT_PID, [
      { pid: 5001, ppid: ROOT_PID, comm: 'bash' },
    ]);
    engine.initSession(SESSION_ID);

    const result = await reconcileBgShellsOnResume({
      sessionId: SESSION_ID,
      rootPid: ROOT_PID,
      probe,
      engine,
      watcher: null,
    });

    expect(result.adoptedShellCount).toBe(0);
  });

  it('returns 0 for invalid pid', async () => {
    engine.initSession(SESSION_ID);
    const result = await reconcileBgShellsOnResume({
      sessionId: SESSION_ID,
      rootPid: 0,
      probe,
      engine,
      watcher: null,
    });
    expect(result.adoptedShellCount).toBe(0);
  });

  it('registers + anchors watcher when one is provided', async () => {
    probe.alive.add(ROOT_PID);
    probe.trees.set(ROOT_PID, [{ pid: 5001, ppid: ROOT_PID, comm: 'bash' }]);
    engine.initSession(SESSION_ID);

    const watcher = new BgShellWatcher({
      probe,
      callbacks: {
        onNaturalExit() { /* no-op */ },
        onShellPidExited() { /* no-op */ },
        onRootProcessDied() { /* no-op */ },
        getRootPid: () => ROOT_PID,
        getActiveShellCount: () => 1,
      },
    });

    const result = await reconcileBgShellsOnResume({
      sessionId: SESSION_ID,
      rootPid: ROOT_PID,
      probe,
      engine,
      watcher,
    });

    expect(result.adoptedShellCount).toBe(1);
    // The watcher's polling timer should now be armed
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    watcher.dispose();
  });
});
