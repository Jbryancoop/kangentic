import type { TranscriptRepository } from '../../db/repositories/transcript-repository';

// The ANSI/control-code stripper now lives in shared/ so the renderer and the
// shared transcript formatter can reuse it. Re-exported here to keep the PTY
// lifecycle import sites (resize-manager, session-id-manager, tests) stable.
import { stripAnsiEscapes } from '../../../shared/ansi-strip';
export { stripAnsiEscapes };

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
