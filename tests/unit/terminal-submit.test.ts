/**
 * Unit tests for src/main/pty/terminal-submit.ts.
 *
 * `TerminalSubmit` exposes two methods:
 *
 *  - `submitContent(sessionId, text, opts)` — bracketed-paste delivery for
 *    free-form content (browser-pane Send). Thin wrapper around the
 *    `PasteEngine.pasteAndSubmit` instance passed in the constructor; tests
 *    here just confirm the forwarding contract (paste-engine internals are
 *    covered by `paste-engine.test.ts`).
 *
 *  - `submitKeystrokes(sessionId, commands[], opts)` — manual `Ctrl+C? →
 *    text → Esc → Enter` keystroke sequence for slash commands. Tests pin
 *    the byte-level contract: ESCAPE is always between text and Enter so
 *    Enter resolves to "submit" (not "select picker item"); commands are
 *    sanitized; aborts stop the next write/wait; verifier integration
 *    works for chained sequences.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { TerminalSubmit, type CommandVerifier } from '../../src/main/pty/terminal-submit';
import type { PasteEngine, PasteOptions } from '../../src/main/pty/paste-engine';

class MockSessionManager extends EventEmitter {
  writes: Array<{ id: string; data: string }> = [];

  write(id: string, data: string): void {
    this.writes.push({ id, data });
  }

  writeRaw(id: string, data: string): void {
    this.writes.push({ id, data });
  }

  drain(_id: string): Promise<void> {
    return Promise.resolve();
  }
}

class MockPasteEngine implements PasteEngine {
  calls: Array<{ sessionId: string; text: string; options?: PasteOptions }> = [];

  pasteAndSubmit(sessionId: string, text: string, options?: PasteOptions): Promise<void> {
    this.calls.push({ sessionId, text, options });
    return Promise.resolve();
  }
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** Drive the timer chain in submitKeystrokes: each wait() in the sequence
 *  resolves at a different timer boundary, and each needs a microtask flush
 *  before the next-loop wait gets registered. Use small step sizes so every
 *  intervening setTimeout (40ms keypress delays, 100ms Ctrl+C settle,
 *  500ms COMMAND_SETTLE) lands inside a flush window rather than getting
 *  jumped over in a single big advance. */
async function advanceAndTick(ms: number, iterations = 30): Promise<void> {
  const stepSize = Math.max(1, Math.ceil(ms / iterations));
  for (let i = 0; i < iterations; i++) {
    vi.advanceTimersByTime(stepSize);
    await tick();
  }
}

describe('TerminalSubmit', () => {
  let sessionManager: MockSessionManager;
  let pasteEngine: MockPasteEngine;
  let submit: TerminalSubmit;

  beforeEach(() => {
    vi.useFakeTimers();
    sessionManager = new MockSessionManager();
    pasteEngine = new MockPasteEngine();
    submit = new TerminalSubmit(sessionManager as never, pasteEngine);
  });

  afterEach(() => {
    vi.useRealTimers();
    sessionManager.removeAllListeners();
  });

  describe('submitContent', () => {
    it('forwards to PasteEngine.pasteAndSubmit byte-for-byte', async () => {
      await submit.submitContent('s1', 'hello world', { bracketed: true, source: 'test' });

      expect(pasteEngine.calls).toHaveLength(1);
      expect(pasteEngine.calls[0].sessionId).toBe('s1');
      expect(pasteEngine.calls[0].text).toBe('hello world');
      expect(pasteEngine.calls[0].options).toEqual({ bracketed: true, source: 'test' });
    });

    it('passes through verifier and signal options', async () => {
      const stubVerifier = vi.fn().mockResolvedValue(true);
      const controller = new AbortController();

      await submit.submitContent('s1', 'payload', {
        verifier: stubVerifier,
        signal: controller.signal,
        source: 'browser-capture',
      });

      expect(pasteEngine.calls[0].options?.verifier).toBe(stubVerifier);
      expect(pasteEngine.calls[0].options?.signal).toBe(controller.signal);
      expect(pasteEngine.calls[0].options?.source).toBe('browser-capture');
    });
  });

  describe('submitKeystrokes', () => {
    it('writes Ctrl+C → text → Esc → Enter for a single command', async () => {
      const promise = submit.submitKeystrokes('s1', ['/test']);
      await advanceAndTick(1000);
      await promise;

      const datas = sessionManager.writes.map((w) => w.data);
      expect(datas).toEqual(['\x03', '/test', '\x1b', '\r']);
    });

    it('skips the leading Ctrl+C when sendCtrlC is false', async () => {
      const promise = submit.submitKeystrokes('s1', ['/test'], { sendCtrlC: false });
      await advanceAndTick(1000);
      await promise;

      const datas = sessionManager.writes.map((w) => w.data);
      expect(datas).toEqual(['/test', '\x1b', '\r']);
    });

    it('regression: Escape is always positioned between text and Enter', async () => {
      // The class of bug we shipped a fix for: bracketed-paste delivery left
      // the slash-command picker open and Enter selected/swallowed the
      // command. Manual Esc dismisses the picker so Enter submits.
      const promise = submit.submitKeystrokes('s1', ['/test']);
      await advanceAndTick(1000);
      await promise;

      const datas = sessionManager.writes.map((w) => w.data);
      const textIndex = datas.indexOf('/test');
      expect(textIndex).toBeGreaterThan(-1);
      expect(datas[textIndex + 1]).toBe('\x1b');
      expect(datas[textIndex + 2]).toBe('\r');
    });

    it('writes each command in a chained sequence with Esc between', async () => {
      const promise = submit.submitKeystrokes('s1', ['/model opus', '/effort high']);
      await advanceAndTick(2000);
      await promise;

      const datas = sessionManager.writes.map((w) => w.data);
      // Ctrl+C → cmd1 → Esc → \r → cmd2 → Esc → \r
      expect(datas).toEqual([
        '\x03',
        '/model opus', '\x1b', '\r',
        '/effort high', '\x1b', '\r',
      ]);
    });

    it('sanitizes commands: collapses CR/LF/Tab to spaces', async () => {
      const promise = submit.submitKeystrokes('s1', ['line\none\rtwo\tthree']);
      await advanceAndTick(1000);
      await promise;

      const datas = sessionManager.writes.map((w) => w.data);
      expect(datas).toContain('line one two three');
    });

    it('drops empty commands silently', async () => {
      const promise = submit.submitKeystrokes('s1', ['', '   ', '\n\t']);
      await advanceAndTick(1000);
      await promise;

      // No writes - all commands sanitized to empty.
      expect(sessionManager.writes).toHaveLength(0);
    });

    it('aborts in-flight via AbortSignal between writes', async () => {
      const controller = new AbortController();
      const promise = submit.submitKeystrokes('s1', ['/test'], { signal: controller.signal });

      // Advance through Ctrl+C settle so we are between commands.
      vi.advanceTimersByTime(100);
      await tick();
      const writesBeforeCancel = sessionManager.writes.length;

      controller.abort();
      await advanceAndTick(1000);
      await promise; // resolves cleanly on abort (logged, not thrown)

      // No additional writes after cancel.
      expect(sessionManager.writes.length).toBe(writesBeforeCancel);
    });

    it('verifier confirms via JSONL match within the first poll window', async () => {
      const verifier: CommandVerifier = vi.fn().mockResolvedValue(true);

      const promise = submit.submitKeystrokes('s1', ['/model opus'], {
        verifier,
        verifiedPrefixLength: 1,
      });
      // Verifier resolves before the retry interval fires.
      await advanceAndTick(500);
      await promise;

      expect(verifier).toHaveBeenCalled();
      const calls = (verifier as unknown as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0][0]).toBe('/model opus');
    });

    it('verifier retry-on-Enter when first scan misses', async () => {
      let scanCount = 0;
      // Miss the first retry interval (~16 polls of 25ms = 400ms),
      // succeed before the second one fires its Enter so the test
      // observes exactly one retry write before resolving.
      const verifier: CommandVerifier = async (_command, _sentAt) => {
        scanCount += 1;
        return scanCount > 20;
      };

      const promise = submit.submitKeystrokes('s1', ['/model opus'], {
        verifier,
        verifiedPrefixLength: 1,
      });
      // Total ~1000ms to cover Ctrl+C settle (100ms) + keypress group (200ms)
      // + first retry interval (400ms) + a few more polls before success.
      await advanceAndTick(1200, 120);
      await promise;

      // The retry path fires extra `\r` writes when verifier keeps returning false.
      const enterCount = sessionManager.writes.filter((w) => w.data === '\r').length;
      expect(enterCount).toBeGreaterThan(1);
    });

    it('time-settles trailing commands beyond verifiedPrefixLength', async () => {
      const verifier: CommandVerifier = vi.fn().mockResolvedValue(true);

      const promise = submit.submitKeystrokes(
        's1',
        ['/model opus', 'auto user prompt'],
        { verifier, verifiedPrefixLength: 1 },
      );
      await advanceAndTick(2500);
      await promise;

      // Verifier called only for the first (verified) command, not the
      // trailing user-supplied prompt.
      expect(verifier).toHaveBeenCalledTimes(1);
      const calls = (verifier as unknown as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0][0]).toBe('/model opus');
    });
  });
});
