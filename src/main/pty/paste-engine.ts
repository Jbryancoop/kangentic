import type { SessionManager } from './session-manager';

/**
 * PasteEngine: deterministic text-paste-and-submit primitive for TUI agent
 * sessions. Used by the embedded browser pane (`browser-capture` source)
 * and the `CommandInjector` (auto_command path) so both share one
 * delivery contract.
 *
 * Algorithm (3 phases):
 *
 *   1. drain pending writeQueue bytes for the session
 *   2. atomic `writeRaw(\e[200~payload\e[201~)` (or just `payload` when
 *      `bracketed: false`) - bypasses the queue's 4KB chunking so the
 *      bracketed paste markers can't be split across kernel reads
 *   3. wait `PASTE_TO_ENTER_GAP_MS` for Ink/React to commit the
 *      `usePaste` state update, then atomic `writeRaw('\r')`
 *
 * Why the gap (the bug we hunted for an entire afternoon):
 *
 *   Claude Code (and any Ink-based TUI) listens on two separate input
 *   channels - `usePaste` for bracketed paste content, `useInput` for
 *   keystrokes. The close marker `\e[201~` fires `usePaste(content)`
 *   which calls `setState({placeholder: content})`. React BATCHES that
 *   state update. If the very next byte is `\r`, `useInput` fires its
 *   submit handler immediately - and reads STALE placeholder state
 *   because React hasn't committed yet. No submit happens; the
 *   `[Pasted text +N lines]` placeholder sits there waiting.
 *
 *   The 500ms gap gives React's commit phase a beat between the paste
 *   close marker and the Enter keystroke, so the submit handler reads
 *   committed state. This is the version the user empirically
 *   validated as working ("It worked!"). Replacing this gap with
 *   output-settle observation, combined-cr, or verify+retry all
 *   regressed in the app context. Don't change this without re-running
 *   the user's manual end-to-end test.
 */

export interface PasteOptions {
  /** Wrap content in `\e[200~ ... \e[201~`. Default true. */
  bracketed?: boolean;
  /** Hard timeout for the entire pasteAndSubmit operation. Default 10000ms. */
  timeoutMs?: number;
  /** Caller-driven cancellation. */
  signal?: AbortSignal;
  /** Diagnostic label for the `[paste-engine]` log lines. */
  source?: string;
}

export interface PasteEngine {
  pasteAndSubmit(sessionId: string, text: string, options?: PasteOptions): Promise<void>;
}

export class PasteSubmitError extends Error {
  readonly code: 'aborted' | 'timeout';
  constructor(code: PasteSubmitError['code'], message: string) {
    super(message);
    this.name = 'PasteSubmitError';
    this.code = code;
  }
}

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
const PASTE_TO_ENTER_GAP_MS = 500;

/**
 * Strip characters that would corrupt the PTY paste:
 * - `\r` (CR) is interpreted as Enter and prematurely submits, leaving
 *   the rest as a separate paste atom.
 * - Other C0 controls (except `\t` and `\n`) can ring the bell, reset
 *   terminal state, or trigger ANSI sequences.
 *
 * Preserves `\t` (0x09) and `\n` (0x0A); needed for indentation and
 * line breaks in our XML-formatted payloads.
 */
export function sanitizeForPaste(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f]/g, '');
}

/** Sleep that rejects with PasteSubmitError('aborted') if the signal aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new PasteSubmitError('aborted', 'paste-engine: aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new PasteSubmitError('aborted', 'paste-engine: aborted'));
    }, { once: true });
  });
}

export function createPasteEngine(sessionManager: SessionManager): PasteEngine {
  return {
    async pasteAndSubmit(sessionId, text, options = {}) {
      const start = Date.now();
      const bracketed = options.bracketed ?? true;
      const totalTimeoutMs = options.timeoutMs ?? 10000;
      const source = options.source ?? 'unknown';

      // Combine caller signal with our timeout into a single signal.
      const timeoutController = new AbortController();
      const timeoutTimer = setTimeout(() => timeoutController.abort(), totalTimeoutMs);
      const linkedSignal = linkSignals(options.signal, timeoutController.signal);

      const safeText = sanitizeForPaste(text);
      const pastePacket = bracketed
        ? `${BRACKETED_PASTE_START}${safeText}${BRACKETED_PASTE_END}`
        : safeText;

      try {
        await sessionManager.drain(sessionId);
        if (linkedSignal.aborted) throw new PasteSubmitError('aborted', 'paste-engine: aborted before write');

        // Phase 1: paste packet (no Enter)
        sessionManager.writeRaw(sessionId, pastePacket);

        // Phase 2: gap for Ink's usePaste -> React commit
        await sleep(PASTE_TO_ENTER_GAP_MS, linkedSignal);

        // Phase 3: Enter (separate atomic write so it reads committed state)
        sessionManager.writeRaw(sessionId, '\r');

        console.log(`[paste-engine] ${source}: ${pastePacket.length}b paste + ${PASTE_TO_ENTER_GAP_MS}ms + \\r in ${Date.now() - start}ms`);
      } catch (caughtError) {
        if (timeoutController.signal.aborted && !options.signal?.aborted) {
          throw new PasteSubmitError('timeout', `paste-engine: ${source} exceeded ${totalTimeoutMs}ms`);
        }
        throw caughtError;
      } finally {
        clearTimeout(timeoutTimer);
      }
    },
  };
}

/**
 * Compose two AbortSignals into one that aborts when either input does.
 * Replaces a polyfill of `AbortSignal.any` to keep typings consistent
 * across our toolchain.
 */
function linkSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  if (a.aborted) return a;
  const controller = new AbortController();
  const propagate = (): void => controller.abort();
  a.addEventListener('abort', propagate, { once: true });
  b.addEventListener('abort', propagate, { once: true });
  return controller.signal;
}
