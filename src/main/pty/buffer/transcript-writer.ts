import type { TranscriptRepository } from '../../db/repositories/transcript-repository';

/**
 * Hardened ANSI escape code stripper.
 *
 * Handles the full XTerm control sequence specification (ECMA-48 / ISO 6429):
 *
 *   CSI  - Control Sequence Introducer (ESC [ ... final) - colors, cursor, erase
 *   OSC  - Operating System Command    (ESC ] ... BEL/ST) - window title, hyperlinks
 *   DCS  - Device Control String       (ESC P ... ST)     - sixel, XTGETTCAP
 *   APC  - Application Program Command (ESC _ ... ST)     - custom app data
 *   PM   - Privacy Message             (ESC ^ ... ST)     - rarely used
 *   SOS  - Start of String             (ESC X ... ST)     - rarely used
 *   SS2  - Single Shift 2              (ESC N)
 *   SS3  - Single Shift 3              (ESC O)
 *   C1   - 8-bit control codes         (U+0080-U+009F)
 *
 * The regex patterns are derived from the ansi-regex npm package (chalk/ansi-regex,
 * 100M+ weekly downloads) extended with DCS/APC/PM/SOS coverage from the XTerm
 * Control Sequences specification (invisible-island.net/xterm/ctlseqs).
 *
 * The result is readable plain text. Not pretty, but complete.
 */
export function stripAnsiEscapes(text: string): string {
  // 1. String-type sequences terminated by ST (ESC \) or BEL:
  //    OSC (ESC ]), DCS (ESC P), APC (ESC _), PM (ESC ^), SOS (ESC X)
  //    Also handles 8-bit C1 initiators (\x9d for OSC, \x90 for DCS, etc.)
  //    Uses non-greedy match to find the nearest terminator.
  let result = text.replace(
    /(?:\x1b[P\]X^_]|\x90|\x9d|\x9e|\x9f|\x98)[\s\S]*?(?:\x1b\\|\x07|\x9c)/g,
    '',
  );

  // 2. CSI sequences: ESC [ (or C1 CSI \x9b) followed by parameter bytes,
  //    intermediate bytes, and a final byte.
  //    Parameter bytes: 0x30-0x3F (digits, semicolon, <=>? etc.)
  //    Intermediate bytes: 0x20-0x2F (space, !"#$%&'()*+,-./)
  //    Final byte: 0x40-0x7E (@A-Z[\]^_`a-z{|}~)
  //    This covers SGR colors, cursor movement, erase, scroll, private modes, etc.
  result = result.replace(
    /(?:\x1b\[|\x9b)[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g,
    '',
  );

  // 3. Two-character ESC sequences (ESC + single byte 0x20-0x7E):
  //    Charset selection (ESC ( B), cursor save/restore (ESC 7/8),
  //    index (ESC D), reverse index (ESC M), newline (ESC E),
  //    SS2 (ESC N), SS3 (ESC O), keypad modes (ESC = / ESC >), etc.
  result = result.replace(/\x1b[\x20-\x7e]/g, '');

  // 4. Standalone 8-bit C1 control codes (U+0080-U+009F).
  //    These are single-byte equivalents of ESC-initiated sequences.
  //    Rarely emitted by modern terminals but must be handled for robustness.
  result = result.replace(/[\x80-\x9f]/g, '');

  // 5. C0 control characters except \t (0x09), \n (0x0a), \r (0x0d).
  //    Strips NUL, BEL, BS, VT, FF, SO, SI, DLE, DC1-DC4, NAK, SYN,
  //    ETB, CAN, EM, SUB, ESC (orphaned), FS, GS, RS, US, DEL.
  result = result.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

  // 6. Normalize line endings: \r\n -> \n, standalone \r -> \n
  result = result.replace(/\r\n/g, '\n');
  result = result.replace(/\r/g, '\n');

  // 7. Collapse 3+ consecutive blank lines into 2.
  //    Prevents screen-clear sequences from leaving huge gaps.
  result = result.replace(/\n{3,}/g, '\n\n');

  // 8. Trim trailing whitespace on each line.
  //    Cursor positioning often pads lines with spaces.
  result = result.replace(/[ \t]+$/gm, '');

  return result;
}

/**
 * Splits a chunk of raw PTY data around alternate-screen toggles, returning
 * only the segments emitted while NOT in the alternate buffer.
 *
 * TUI agents (Claude Code, Codex, etc.) enter the alt buffer then redraw
 * the entire screen on every keystroke and animation frame. The redrawn
 * plain text is identical each time, so without filtering the transcript
 * would fill with dozens of duplicated copies. We treat alt-screen content
 * as ephemeral and drop it; only the pre-TUI banner and post-TUI exit
 * messages persist.
 *
 * Recognized toggle sequences:
 *   ESC [ ? 1049 h/l - smcup-style alt-screen on/off (modern, used by xterm)
 *   ESC [ ? 1047 h/l - older alt-screen on/off
 *   ESC [ ?   47 h/l - oldest alt-screen on/off (vt220)
 *
 * Threads the alt-screen state across calls via the `inAltAtStart` flag and
 * returns the resulting state via `inAltAtEnd`. The regex is constructed
 * inside the function so callers can never accidentally inherit a stale
 * `lastIndex` from another caller.
 *
 * Exported for unit testing.
 */
export function filterAltScreenContent(
  data: string,
  inAltAtStart: boolean,
): { content: string; inAltAtEnd: boolean } {
  const toggleRegex = /\x1b\[\?(?:1049|1047|47)([hl])/g;
  let cursor = 0;
  let currentlyInAlt = inAltAtStart;
  let captured = '';
  let match: RegExpExecArray | null;
  while ((match = toggleRegex.exec(data)) !== null) {
    if (!currentlyInAlt && match.index > cursor) {
      captured += data.slice(cursor, match.index);
    }
    currentlyInAlt = match[1] === 'h';
    cursor = toggleRegex.lastIndex;
  }
  if (!currentlyInAlt && cursor < data.length) {
    captured += data.slice(cursor);
  }
  return { content: captured, inAltAtEnd: currentlyInAlt };
}

/**
 * Streams ANSI-stripped PTY output to SQLite incrementally.
 *
 * Hooks directly into the PTY data stream as a separate consumer
 * (alongside PtyBufferManager). Maintains its own pending buffer per session,
 * independent of PtyBufferManager's 512KB ring buffer. This ensures long
 * sessions (2+ hours) capture the full transcript even after the ring buffer
 * evicts old content.
 *
 * Drops content emitted while the agent is in the alternate-screen buffer
 * (TUI mode) since redraws would otherwise produce dozens of duplicate copies
 * of the same plain text. Pre-TUI banner and post-TUI exit messages survive.
 *
 * Flushes to the database every 30 seconds (debounced). At worst, a crash
 * loses the last 30 seconds of output.
 */
export class TranscriptWriter {
  /** Per-session pending data not yet flushed to DB. */
  private pending = new Map<string, string>();
  private flushTimers = new Map<string, NodeJS.Timeout>();
  /** Tracks which sessions have had their DB row created. */
  private initialized = new Set<string>();
  /** Tracks whether each session is currently in the alternate-screen buffer.
   *  Threads across onData calls so a toggle in one chunk affects subsequent
   *  chunks. */
  private inAltScreen = new Map<string, boolean>();

  private static readonly FLUSH_INTERVAL_MS = 30_000;

  constructor(private transcriptRepo: TranscriptRepository) {}

  /**
   * Called on every PTY data chunk (same event source as PtyBufferManager).
   * Filters out alternate-screen content, strips ANSI codes from what
   * remains, and accumulates in the pending buffer. Debounces DB writes to
   * every 30 seconds.
   */
  onData(sessionId: string, data: string): void {
    const inAltAtStart = this.inAltScreen.get(sessionId) ?? false;
    const { content, inAltAtEnd } = filterAltScreenContent(data, inAltAtStart);
    this.inAltScreen.set(sessionId, inAltAtEnd);
    if (!content) return;

    const stripped = stripAnsiEscapes(content);
    if (!stripped) return;

    const existing = this.pending.get(sessionId) ?? '';
    this.pending.set(sessionId, existing + stripped);

    // Debounce: schedule flush if not already scheduled
    if (!this.flushTimers.has(sessionId)) {
      const timer = setTimeout(() => this.flush(sessionId), TranscriptWriter.FLUSH_INTERVAL_MS);
      this.flushTimers.set(sessionId, timer);
    }
  }

  /**
   * Flush pending data for a session to the database.
   * Lazily creates the transcript row on first flush - this avoids
   * FK constraint failures when the sessions DB row hasn't been
   * inserted yet (doSpawn runs before executeSpawnAgent inserts the record).
   */
  flush(sessionId: string): void {
    const timer = this.flushTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.flushTimers.delete(sessionId);
    }

    const chunk = this.pending.get(sessionId);
    if (!chunk) return;
    this.pending.set(sessionId, '');

    try {
      // Lazy init: create the transcript row on first flush.
      // By this point the sessions table row exists (inserted by
      // executeSpawnAgent after doSpawn returns).
      if (!this.initialized.has(sessionId)) {
        this.transcriptRepo.create(sessionId);
        this.initialized.add(sessionId);
      }
      this.transcriptRepo.appendChunk(sessionId, chunk);
    } catch (error) {
      // Best effort - don't crash the session if DB write fails
      console.error(`[TranscriptWriter] Failed to flush transcript for ${sessionId.slice(0, 8)}:`, error);
    }
  }

  /**
   * Final flush at session suspend/exit. Ensures all pending data is written.
   */
  finalize(sessionId: string): void {
    this.flush(sessionId);
  }

  /**
   * Clean up on session removal. Flushes remaining data and clears state.
   */
  remove(sessionId: string): void {
    this.finalize(sessionId);
    this.pending.delete(sessionId);
    this.initialized.delete(sessionId);
    this.inAltScreen.delete(sessionId);
  }

  /**
   * Clean up all sessions. Called during shutdown.
   */
  finalizeAll(): void {
    for (const sessionId of this.pending.keys()) {
      this.finalize(sessionId);
    }
  }
}
