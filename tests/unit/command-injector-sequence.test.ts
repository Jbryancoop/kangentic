/**
 * Tests for `CommandInjector.scheduleSequence`, used by the task-move flow to
 * apply a column's `/model`, `/effort`, and `auto_command` in order when a
 * task moves between columns with differing settings. The plain `schedule()`
 * path cannot be called multiple times in a row because it cancels prior
 * pending entries; `scheduleSequence` is the canonical way to chain commands.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommandInjector } from '../../src/main/engine/command-injector';

type WriteCall = string;

class FakeSessionManager {
  public writes: WriteCall[] = [];
  private session = { id: 'sess-1', status: 'running' as const };

  getSession(_sessionId: string): { id: string; status: 'running' } | null {
    return this.session;
  }

  write(_sessionId: string, data: string): void {
    this.writes.push(data);
  }

  on(): void { /* unused for this code path */ }
  off(): void { /* unused for this code path */ }
}

function setup(): { injector: CommandInjector; manager: FakeSessionManager } {
  const manager = new FakeSessionManager();
  const injector = new CommandInjector(manager as unknown as ConstructorParameters<typeof CommandInjector>[0]);
  return { injector, manager };
}

beforeEach(() => {
  vi.useFakeTimers();
});

/**
 * Drain a few hundred ms by alternating advanceTimersByTime + flushing
 * microtasks. The worker is async (await wait()), so plain advanceTimersByTime
 * is not enough on its own; we have to yield to the event loop between
 * timer pulses for the awaited wait()s to resolve.
 */
async function drain(ms: number): Promise<void> {
  let elapsed = 0;
  while (elapsed < ms) {
    vi.advanceTimersByTime(50);
    elapsed += 50;
    await Promise.resolve();
    await Promise.resolve();
  }
}

describe('CommandInjector.scheduleSequence', () => {
  it('writes each command as separate Ink keypresses with inter-write delays', async () => {
    const { injector, manager } = setup();
    injector.scheduleSequence('task-1', 'sess-1', ['/model opus', '/effort high']);

    // Ctrl+C is sent synchronously at t=0.
    expect(manager.writes).toEqual(['\x03']);

    // Drain past the full burst: 200ms initial + per-command (100+100+100+500 = 800ms each).
    await drain(2500);

    // Each command lands as text + Escape + Enter, separated by waits so
    // Claude's Ink TUI processes them as discrete keypresses.
    expect(manager.writes).toEqual([
      '\x03',                  // Ctrl+C
      '/model opus',           // command 1 text
      '\x1b',                  // command 1 escape
      '\r',                    // command 1 enter
      '/effort high',          // command 2 text
      '\x1b',                  // command 2 escape
      '\r',                    // command 2 enter
    ]);
  });

  it('drops empty / whitespace-only commands without breaking the chain', async () => {
    const { injector, manager } = setup();
    injector.scheduleSequence('task-1', 'sess-1', ['/model opus', '   ', '/effort high']);
    await drain(2500);

    const textWrites = manager.writes.filter((w) => w !== '\x03' && w !== '\x1b' && w !== '\r');
    expect(textWrites).toEqual(['/model opus', '/effort high']);
  });

  it('does nothing when every command is empty', async () => {
    const { injector, manager } = setup();
    injector.scheduleSequence('task-1', 'sess-1', ['', '   ']);
    await drain(1000);
    expect(manager.writes).toEqual([]);
  });

  it('coalesces rapid re-schedules: in-flight burst completes, only the latest queued sequence runs after', async () => {
    const { injector, manager } = setup();

    // Burst A starts firing.
    injector.scheduleSequence('task-1', 'sess-1', ['/model haiku', '/effort medium']);
    expect(manager.writes).toEqual(['\x03']);

    // Mid-flight re-schedule with new commands. The new sequence does NOT
    // interrupt burst A; it is stashed as "next" and runs after A completes.
    await drain(300);
    injector.scheduleSequence('task-1', 'sess-1', ['/model opus', '/effort xhigh']);

    // Even more rapid re-schedule: the previous "next" is overwritten by
    // the latest one. Intermediate transitions are coalesced away.
    injector.scheduleSequence('task-1', 'sess-1', ['/model sonnet']);

    await drain(5000);

    // Burst A wrote /model haiku + /effort medium fully, then burst B (the
    // LATEST of the queued schedules - /model sonnet) wrote next. The
    // intermediate /model opus + /effort xhigh schedule was dropped.
    expect(manager.writes).toEqual([
      '\x03',
      '/model haiku', '\x1b', '\r',
      '/effort medium', '\x1b', '\r',
      '\x03',
      '/model sonnet', '\x1b', '\r',
    ]);
  });

  it('cancel() drops the queued "next" but does NOT interrupt the in-flight burst', async () => {
    const { injector, manager } = setup();
    injector.scheduleSequence('task-1', 'sess-1', ['/model haiku']);
    expect(manager.writes).toEqual(['\x03']);

    // Stash a "next" sequence that should NOT run.
    injector.scheduleSequence('task-1', 'sess-1', ['/effort high']);
    injector.cancel('task-1');

    await drain(3000);

    // Only the in-flight burst's commands land; the queued cancel-victim does not.
    expect(manager.writes).toEqual(['\x03', '/model haiku', '\x1b', '\r']);
  });

  it('with verifier: waits for confirmation before sending the next command', async () => {
    const { injector, manager } = setup();
    // Verifier resolves true on the first call (success) for both commands.
    const calls: Array<{ command: string; sentAt: number }> = [];
    const verifier = async (command: string, sentAt: number): Promise<boolean> => {
      calls.push({ command, sentAt });
      return true;
    };
    injector.scheduleSequence('task-1', 'sess-1', ['/model opus', '/effort high'], { verifier });

    await drain(3000);

    // Verifier called once per command, in order.
    expect(calls.map((c) => c.command)).toEqual(['/model opus', '/effort high']);
    // Both commands' keypresses were emitted.
    const textWrites = manager.writes.filter((w) => w !== '\x03' && w !== '\x1b' && w !== '\r');
    expect(textWrites).toEqual(['/model opus', '/effort high']);
  });

  it('with verifier: re-fires Enter when verification stays false past the retry interval', async () => {
    const { injector, manager } = setup();
    // Track when the second sentAt arrives - that signals a retry-Enter
    // happened (pollWithRetries advances sentAt on each retry).
    const observedSentAts: number[] = [];
    const verifier = async (command: string, sentAt: number): Promise<boolean> => {
      if (command !== '/model opus') return true;
      if (!observedSentAts.includes(sentAt)) observedSentAts.push(sentAt);
      // Confirm only after a retry has happened (more than one distinct sentAt).
      return observedSentAts.length >= 2;
    };
    injector.scheduleSequence('task-1', 'sess-1', ['/model opus', '/effort high'], { verifier });

    await drain(8000);

    // We saw at least 2 distinct sentAt values -> at least one retry-Enter fired.
    expect(observedSentAts.length).toBeGreaterThanOrEqual(2);
    // Enter writes: 1 initial + N retries + 1 for /effort. Always >= 3.
    const enterWrites = manager.writes.filter((w) => w === '\r');
    expect(enterWrites.length).toBeGreaterThanOrEqual(3);
    const textWrites = manager.writes.filter((w) => w !== '\x03' && w !== '\x1b' && w !== '\r');
    expect(textWrites).toEqual(['/model opus', '/effort high']);
  });

  it('with verifier: continues the sequence even if a command never confirms', async () => {
    const { injector, manager } = setup();
    const verifier = async (): Promise<boolean> => false;
    injector.scheduleSequence('task-1', 'sess-1', ['/model opus', '/effort high'], { verifier });

    await drain(15000);

    // Both commands attempted (with retries), so /effort still got typed.
    const textWrites = manager.writes.filter((w) => w !== '\x03' && w !== '\x1b' && w !== '\r');
    expect(textWrites).toEqual(['/model opus', '/effort high']);
  });

  it('verifiedPrefixLength: only verifies the leading commands, lets trailing ones fire-and-forget', async () => {
    // Regression guard: when an InjectionPlan carries `[/model X, /effort Y, /custom-auto-cmd]`
    // we MUST verify only the first two (deterministic adapter writes) and
    // let the trailing user command sail through with a time-settle. A
    // verifier that always returns false (failure) for ALL commands would,
    // without the prefix, exhaust retries on the auto_command and Ctrl+C
    // it away - dropping the user's intended command. The prefix split
    // prevents that.
    const { injector, manager } = setup();
    let verifierCalls = 0;
    const verifier = async (): Promise<boolean> => {
      verifierCalls += 1;
      return true; // Verified commands pass on the first poll.
    };
    injector.scheduleSequence(
      'task-1',
      'sess-1',
      ['/model opus', '/effort high', '/custom-auto'],
      { verifier, verifiedPrefixLength: 2 },
    );
    await drain(3000);

    // Verifier called exactly once per verified command (no retries needed,
    // returned true immediately) and NOT called for the trailing command.
    expect(verifierCalls).toBe(2);
    // All three text writes happened in order.
    const textWrites = manager.writes.filter((w) => w !== '\x03' && w !== '\x1b' && w !== '\r');
    expect(textWrites).toEqual(['/model opus', '/effort high', '/custom-auto']);
  });

  it('verifiedPrefixLength=0 with a verifier behaves like the unverified path', async () => {
    const { injector, manager } = setup();
    let verifierCalls = 0;
    const verifier = async (): Promise<boolean> => { verifierCalls += 1; return false; };
    injector.scheduleSequence('task-1', 'sess-1', ['/anything'], { verifier, verifiedPrefixLength: 0 });
    await drain(2000);

    expect(verifierCalls).toBe(0); // Never called - prefix is 0.
    // Text was still written.
    const textWrites = manager.writes.filter((w) => w !== '\x03' && w !== '\x1b' && w !== '\r');
    expect(textWrites).toEqual(['/anything']);
  });

  it('skips delivery when the session is missing', async () => {
    const manager = new FakeSessionManager();
    (manager as unknown as { getSession: () => null }).getSession = () => null;
    const injector = new CommandInjector(manager as unknown as ConstructorParameters<typeof CommandInjector>[0]);

    injector.scheduleSequence('task-1', 'sess-1', ['/model opus']);
    await drain(1000);
    expect(manager.writes).toEqual([]);
  });
});
