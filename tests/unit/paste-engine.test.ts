/**
 * Unit tests for src/main/pty/paste-engine.ts.
 *
 * Engine contract: split delivery with a 500ms wall-clock gap between
 * the bracketed paste packet and the Enter keystroke.
 *
 *   1. await drain() to clear any pending writeQueue bytes
 *   2. writeRaw(`\e[200~payload\e[201~`)  -- paste packet only, no Enter
 *   3. wait PASTE_TO_ENTER_GAP_MS (500ms) for Ink's usePaste setState to
 *      commit through React's batching cycle
 *   4. writeRaw('\r')  -- separate atomic write so the submit handler
 *      reads committed state, not stale closure state
 *
 * This is the version the user empirically validated as working ("It
 * worked!"). Replacing the gap with output-settle observation,
 * combined-cr atomic delivery, or evidence-and-retry approaches all
 * regressed in the app context.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createPasteEngine, sanitizeForPaste, PasteSubmitError } from '../../src/main/pty/paste-engine';

class MockSessionManager extends EventEmitter {
  writeRawCalls: Array<{ id: string; data: string }> = [];
  drainResolvers: Array<() => void> = [];

  drain(_id: string): Promise<void> {
    return new Promise((resolve) => {
      this.drainResolvers.push(resolve);
    });
  }

  writeRaw(id: string, data: string): void {
    this.writeRawCalls.push({ id, data });
  }

  flushDrain(): void {
    const pending = this.drainResolvers.splice(0, this.drainResolvers.length);
    for (const resolve of pending) resolve();
  }
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('sanitizeForPaste', () => {
  it('strips lone CR', () => {
    expect(sanitizeForPaste('hello\rworld')).toBe('hello\nworld');
  });
  it('normalizes CRLF to LF', () => {
    expect(sanitizeForPaste('a\r\nb\r\nc')).toBe('a\nb\nc');
  });
  it('preserves tab and newline', () => {
    expect(sanitizeForPaste('a\tb\nc')).toBe('a\tb\nc');
  });
  it('strips other C0 controls', () => {
    expect(sanitizeForPaste('a\x07b\x1bc\x00d')).toBe('abcd');
  });
});

describe('PasteEngine.pasteAndSubmit', () => {
  let mockSessionManager: MockSessionManager;
  let engine: ReturnType<typeof createPasteEngine>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockSessionManager = new MockSessionManager();
    engine = createPasteEngine(mockSessionManager as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    mockSessionManager.removeAllListeners();
  });

  it('drains, writes bracketed paste packet, waits 500ms, then sends \\r', async () => {
    const promise = engine.pasteAndSubmit('s1', 'hello world');

    await tick();
    // Engine should be awaiting drain
    expect(mockSessionManager.writeRawCalls).toHaveLength(0);

    mockSessionManager.flushDrain();
    await tick();

    // Phase 1: paste packet written (no Enter)
    expect(mockSessionManager.writeRawCalls).toHaveLength(1);
    expect(mockSessionManager.writeRawCalls[0]).toEqual({
      id: 's1',
      data: '\x1b[200~hello world\x1b[201~',
    });

    // Phase 2: 500ms gap for React commit
    vi.advanceTimersByTime(500);
    await tick();

    // Phase 3: Enter sent as separate atomic write
    expect(mockSessionManager.writeRawCalls).toHaveLength(2);
    expect(mockSessionManager.writeRawCalls[1]).toEqual({ id: 's1', data: '\r' });

    await expect(promise).resolves.toBeUndefined();
  });

  it('skips bracketed markers when bracketed:false (still two phases)', async () => {
    const promise = engine.pasteAndSubmit('s1', '/test', { bracketed: false });

    await tick();
    mockSessionManager.flushDrain();
    await tick();

    expect(mockSessionManager.writeRawCalls[0].data).toBe('/test');

    vi.advanceTimersByTime(500);
    await tick();

    expect(mockSessionManager.writeRawCalls[1].data).toBe('\r');
    await expect(promise).resolves.toBeUndefined();
  });

  it('sanitizes embedded CR before writing', async () => {
    const promise = engine.pasteAndSubmit('s1', 'line one\rline two', { bracketed: false });

    await tick();
    mockSessionManager.flushDrain();
    await tick();

    expect(mockSessionManager.writeRawCalls[0].data).toBe('line one\nline two');

    vi.advanceTimersByTime(500);
    await tick();

    expect(mockSessionManager.writeRawCalls[1].data).toBe('\r');
    await expect(promise).resolves.toBeUndefined();
  });

  it('sanitizes ESC and BEL out of payload before bracketed-paste wrap', async () => {
    const promise = engine.pasteAndSubmit('s1', 'a\x07b\x1bc');

    await tick();
    mockSessionManager.flushDrain();
    await tick();

    expect(mockSessionManager.writeRawCalls[0].data).toBe('\x1b[200~abc\x1b[201~');

    vi.advanceTimersByTime(500);
    await tick();

    expect(mockSessionManager.writeRawCalls[1].data).toBe('\r');
    await expect(promise).resolves.toBeUndefined();
  });

  it('aborts when AbortSignal is signalled before drain completes', async () => {
    const controller = new AbortController();
    const promise = engine.pasteAndSubmit('s1', 'payload', { signal: controller.signal });
    promise.catch(() => undefined);

    await tick();
    controller.abort();
    await tick();

    mockSessionManager.flushDrain();
    await tick();

    await expect(promise).rejects.toBeInstanceOf(PasteSubmitError);
    await expect(promise).rejects.toMatchObject({ code: 'aborted' });
    expect(mockSessionManager.writeRawCalls).toHaveLength(0);
  });

  it('rejects with timeout when total operation exceeds timeoutMs', async () => {
    const promise = engine.pasteAndSubmit('s1', 'payload', { timeoutMs: 500 });
    promise.catch(() => undefined);

    await tick();
    vi.advanceTimersByTime(500);
    await tick();

    mockSessionManager.flushDrain();
    await tick();

    await expect(promise).rejects.toBeInstanceOf(PasteSubmitError);
    await expect(promise).rejects.toMatchObject({ code: 'timeout' });
  });
});
