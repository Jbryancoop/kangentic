/**
 * Unit tests for src/main/engine/command-injector.ts.
 *
 * After the PasteEngine migration, CommandInjector is a thin scheduler
 * that:
 *  - listens for 'thinking' / 'session-changed' / 'exit' events for
 *    deferred (freshly-spawned / queued) sessions
 *  - delegates the actual byte delivery to PasteEngine.pasteAndSubmit
 *  - sends the optional Ctrl+C as a separate write with a 150ms settle
 *    before invoking the engine (Ctrl+C in the same atomic write would
 *    cancel the text we're trying to type - verified via paste-harness)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { CommandInjector } from '../../src/main/engine/command-injector';
import { agentRegistry } from '../../src/main/agent/agent-registry';

class MockSessionManager extends EventEmitter {
  writes: Array<{ id: string; data: string }> = [];
  drainResolvers: Array<() => void> = [];
  registry = new Map<string, { status: string }>();

  getSession(id: string): { status: string } | undefined {
    return this.registry.get(id);
  }

  /** Per-adapter submission evidence wiring: CommandInjector looks up
   *  the adapter name to resolve `submissionEvidence`. Most tests leave
   *  this returning undefined to exercise the `{ minBytes: 50 }` fallback;
   *  set `agentNameOverride` to route to a real registered adapter. */
  agentNameOverride: string | undefined = undefined;

  getSessionAgentName(_id: string): string | undefined {
    return this.agentNameOverride;
  }

  drain(_id: string): Promise<void> {
    return new Promise((resolve) => this.drainResolvers.push(resolve));
  }

  flushDrain(): void {
    const pending = this.drainResolvers.splice(0, this.drainResolvers.length);
    for (const resolve of pending) resolve();
  }

  write(id: string, data: string): void {
    this.writes.push({ id, data });
  }

  writeRaw(id: string, data: string): void {
    this.writes.push({ id, data });
  }

  emitActivity(id: string, state: string): void {
    this.emit('activity', id, state);
  }

  emitSessionChanged(id: string, session: { status: string }): void {
    this.emit('session-changed', id, session);
  }

  emitExit(id: string): void {
    this.emit('exit', id);
  }
}

class MockPasteEngine {
  calls: Array<{
    sessionId: string;
    text: string;
    bracketed?: boolean;
    source?: string;
    aborted?: boolean;
    verifier?: unknown;
  }> = [];
  resolveNext: (() => void) | null = null;
  rejectNext: ((error: unknown) => void) | null = null;

  pasteAndSubmit(
    sessionId: string,
    text: string,
    options: { bracketed?: boolean; signal?: AbortSignal; source?: string; verifier?: unknown } = {},
  ): Promise<void> {
    const call = {
      sessionId,
      text,
      bracketed: options.bracketed,
      source: options.source,
      verifier: options.verifier,
      aborted: false,
    };
    this.calls.push(call);
    return new Promise<void>((resolve, reject) => {
      this.resolveNext = resolve;
      this.rejectNext = reject;
      if (options.signal) {
        if (options.signal.aborted) {
          call.aborted = true;
          reject(new Error('aborted'));
          return;
        }
        options.signal.addEventListener('abort', () => {
          call.aborted = true;
          reject(new Error('aborted'));
        });
      }
    });
  }
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('CommandInjector', () => {
  let sessionManager: MockSessionManager;
  let pasteEngine: MockPasteEngine;
  let injector: CommandInjector;

  beforeEach(() => {
    vi.useFakeTimers();
    sessionManager = new MockSessionManager();
    pasteEngine = new MockPasteEngine();
    injector = new CommandInjector(sessionManager as never, pasteEngine as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    sessionManager.removeAllListeners();
  });

  it('existing session: writes Ctrl+C, drains, waits 150ms, then calls pasteEngine', async () => {
    sessionManager.registry.set('s1', { status: 'running' });

    injector.schedule('task-1', 's1', '/test');

    // Let the deliver promise start
    await tick();

    // Ctrl+C should have been written
    expect(sessionManager.writes).toHaveLength(1);
    expect(sessionManager.writes[0].data).toBe('\x03');

    // Drain the Ctrl+C write
    sessionManager.flushDrain();
    await tick();

    // Engine should NOT have been called yet (in the 150ms settle)
    expect(pasteEngine.calls).toHaveLength(0);

    vi.advanceTimersByTime(150);
    await tick();

    // Now the engine is invoked
    expect(pasteEngine.calls).toHaveLength(1);
    expect(pasteEngine.calls[0]).toMatchObject({
      sessionId: 's1',
      text: '/test',
      bracketed: false,
      source: 'auto_command:task-1',
    });
  });

  it('freshlySpawned: waits for thinking event, then calls pasteEngine without Ctrl+C', async () => {
    sessionManager.registry.set('s1', { status: 'running' });

    injector.schedule('task-1', 's1', '/test', { freshlySpawned: true });

    await tick();

    // No writes yet - waiting for thinking event
    expect(sessionManager.writes).toHaveLength(0);
    expect(pasteEngine.calls).toHaveLength(0);

    // Activity event signals CLI is alive
    sessionManager.emitActivity('s1', 'thinking');
    await tick();

    // Engine called immediately, NO Ctrl+C
    expect(sessionManager.writes).toHaveLength(0);
    expect(pasteEngine.calls).toHaveLength(1);
    expect(pasteEngine.calls[0]).toMatchObject({
      sessionId: 's1',
      text: '/test',
      bracketed: false,
    });
  });

  it('queued session: waits for status:running -> thinking -> calls engine', async () => {
    sessionManager.registry.set('s1', { status: 'queued' });

    injector.schedule('task-1', 's1', '/test', { freshlySpawned: true });

    await tick();

    // 'thinking' before 'running' is ignored
    sessionManager.emitActivity('s1', 'thinking');
    await tick();
    expect(pasteEngine.calls).toHaveLength(0);

    // status -> running, then thinking
    sessionManager.emitSessionChanged('s1', { status: 'running' });
    sessionManager.emitActivity('s1', 'thinking');
    await tick();

    expect(pasteEngine.calls).toHaveLength(1);
  });

  it('30s fallback: delivers anyway when thinking never fires', async () => {
    sessionManager.registry.set('s1', { status: 'running' });

    injector.schedule('task-1', 's1', '/test', { freshlySpawned: true });
    await tick();

    vi.advanceTimersByTime(30_000);
    await tick();

    expect(pasteEngine.calls).toHaveLength(1);
  });

  it('cancel(): aborts the engine promise mid-flight', async () => {
    sessionManager.registry.set('s1', { status: 'running' });
    injector.schedule('task-1', 's1', '/test');

    await tick();
    sessionManager.flushDrain();
    await tick();
    vi.advanceTimersByTime(150);
    await tick();

    expect(pasteEngine.calls).toHaveLength(1);
    expect(pasteEngine.calls[0].aborted).toBe(false);

    injector.cancel('task-1');
    await tick();

    expect(pasteEngine.calls[0].aborted).toBe(true);
  });

  it('exit event during deferred wait cancels the injection', async () => {
    sessionManager.registry.set('s1', { status: 'running' });
    injector.schedule('task-1', 's1', '/test', { freshlySpawned: true });
    await tick();

    sessionManager.emitExit('s1');
    await tick();

    // No engine call because we cancelled before delivering
    expect(pasteEngine.calls).toHaveLength(0);
  });

  it('rapid re-schedule cancels the previous injection', async () => {
    sessionManager.registry.set('s1', { status: 'running' });
    injector.schedule('task-1', 's1', '/first', { freshlySpawned: true });
    await tick();

    // Re-schedule same task before delivery
    injector.schedule('task-1', 's1', '/second', { freshlySpawned: true });
    await tick();

    sessionManager.emitActivity('s1', 'thinking');
    await tick();

    // Only the second command was delivered
    expect(pasteEngine.calls).toHaveLength(1);
    expect(pasteEngine.calls[0].text).toBe('/second');
  });

  it('cancelAll() aborts every pending injection', async () => {
    sessionManager.registry.set('s1', { status: 'running' });
    sessionManager.registry.set('s2', { status: 'running' });

    injector.schedule('task-a', 's1', '/a', { freshlySpawned: true });
    injector.schedule('task-b', 's2', '/b', { freshlySpawned: true });
    await tick();

    injector.cancelAll();
    await tick();

    sessionManager.emitActivity('s1', 'thinking');
    sessionManager.emitActivity('s2', 'thinking');
    await tick();

    // Neither delivered
    expect(pasteEngine.calls).toHaveLength(0);
  });

  it('skips when session does not exist', () => {
    // No registry entry for 's1'
    injector.schedule('task-1', 's1', '/test');
    expect(pasteEngine.calls).toHaveLength(0);
    expect(sessionManager.writes).toHaveLength(0);
  });

  it('sanitize strips newlines from command text before delivery', async () => {
    sessionManager.registry.set('s1', { status: 'running' });
    injector.schedule('task-1', 's1', 'line one\nline two\rline three');

    await tick();
    sessionManager.flushDrain();
    await tick();
    vi.advanceTimersByTime(150);
    await tick();

    // sanitizeForPty collapses CR/LF/Tab to single spaces and trims.
    expect(pasteEngine.calls[0].text).toBe('line one line two line three');
  });

  it('looks up the Claude adapter by name and forwards its paste verifier (null today)', async () => {
    // Concrete regression guard: prove `agentRegistry.get('claude').getSubmissionVerifier('paste')`
    // is actually consulted, not bypassed. Claude returns null for paste context today, which the
    // caller coalesces to undefined via `?? undefined` - that exact value lands in pasteEngine.calls[0].
    sessionManager.registry.set('s1', { status: 'running' });
    sessionManager.agentNameOverride = 'claude';

    const claudeAdapter = agentRegistry.get('claude');
    if (!claudeAdapter?.getSubmissionVerifier) throw new Error('Claude adapter must implement getSubmissionVerifier');
    const verifierSpy = vi.spyOn(claudeAdapter, 'getSubmissionVerifier');

    try {
      injector.schedule('task-1', 's1', '/review');

      await tick();
      sessionManager.flushDrain();
      await tick();
      vi.advanceTimersByTime(150);
      await tick();

      expect(pasteEngine.calls).toHaveLength(1);
      expect(verifierSpy).toHaveBeenCalledWith('paste');
      // Adapter returned null; the `?? undefined` in command-injector coalesces that to undefined.
      expect(pasteEngine.calls[0].verifier).toBeUndefined();
    } finally {
      verifierSpy.mockRestore();
    }
  });

  it('looks up the Codex adapter by name and forwards its paste verifier (null today)', async () => {
    sessionManager.registry.set('s1', { status: 'running' });
    sessionManager.agentNameOverride = 'codex';

    const codexAdapter = agentRegistry.get('codex');
    if (!codexAdapter?.getSubmissionVerifier) throw new Error('Codex adapter must implement getSubmissionVerifier');
    const verifierSpy = vi.spyOn(codexAdapter, 'getSubmissionVerifier');

    try {
      injector.schedule('task-1', 's1', '/review');

      await tick();
      sessionManager.flushDrain();
      await tick();
      vi.advanceTimersByTime(150);
      await tick();

      expect(pasteEngine.calls).toHaveLength(1);
      expect(verifierSpy).toHaveBeenCalledWith('paste');
      expect(pasteEngine.calls[0].verifier).toBeUndefined();
    } finally {
      verifierSpy.mockRestore();
    }
  });

  it('skips adapter lookup entirely when getSessionAgentName returns undefined', async () => {
    // Regression guard for the `agentName ? agentRegistry.get(agentName) : undefined` short-circuit.
    // When no agent name is captured, the code MUST NOT consult the registry - otherwise an
    // accidental `agentRegistry.get(undefined)` would hit registry-internal handling.
    sessionManager.registry.set('s1', { status: 'running' });
    // agentNameOverride stays undefined (default)

    const registrySpy = vi.spyOn(agentRegistry, 'get');

    try {
      injector.schedule('task-1', 's1', '/review');

      await tick();
      sessionManager.flushDrain();
      await tick();
      vi.advanceTimersByTime(150);
      await tick();

      expect(pasteEngine.calls).toHaveLength(1);
      expect(registrySpy).not.toHaveBeenCalled();
      expect(pasteEngine.calls[0].verifier).toBeUndefined();
    } finally {
      registrySpy.mockRestore();
    }
  });

  it('passes the verifier through verbatim when the adapter returns a function', async () => {
    // When a future adapter starts returning a real verifier for paste context, that function
    // must reach pasteAndSubmit unchanged. Stub Claude's adapter to verify the wiring.
    sessionManager.registry.set('s1', { status: 'running' });
    sessionManager.agentNameOverride = 'claude';

    const claudeAdapter = agentRegistry.get('claude');
    if (!claudeAdapter?.getSubmissionVerifier) throw new Error('Claude adapter must implement getSubmissionVerifier');
    const stubVerifier = async (): Promise<boolean> => true;
    const verifierSpy = vi
      .spyOn(claudeAdapter, 'getSubmissionVerifier')
      .mockReturnValue(stubVerifier);

    try {
      injector.schedule('task-1', 's1', '/review');

      await tick();
      sessionManager.flushDrain();
      await tick();
      vi.advanceTimersByTime(150);
      await tick();

      expect(verifierSpy).toHaveBeenCalledWith('paste');
      expect(pasteEngine.calls[0].verifier).toBe(stubVerifier);
    } finally {
      verifierSpy.mockRestore();
    }
  });
});
