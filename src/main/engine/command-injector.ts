import type { SessionManager } from '../pty/session-manager';
import type { PasteEngine } from '../pty/paste-engine';
import { resolveSubmissionEvidence } from '../agent/submission-evidence';
import { sanitizeForPty } from '../../shared/paths';

/**
 * Tracks a pending auto-command injection for a single task.
 * Contains the cleanup function that removes all event listeners and timers.
 */
interface PendingInjection {
  cleanup: () => void;
}

/**
 * CommandInjector schedules and delivers auto-commands to PTY sessions.
 *
 * When a task moves into a column with an `auto_command`, the injector writes
 * the command text into the running terminal. It handles three scenarios:
 *
 * 1. **Existing session** -- injects immediately (Ctrl+C to clear input first)
 * 2. **Freshly spawned session** -- waits for first `thinking` event (CLI alive)
 * 3. **Queued session** -- waits for `status:running`, then applies fresh logic
 *
 * The injector is keyed by taskId so rapid moves cancel previous injections.
 * All state is in-memory -- no persistence needed (event-based, not recoverable).
 *
 * Delivery is delegated to PasteEngine.pasteAndSubmit, which writes the
 * `text + \r` packet via a single un-chunked pty.write call. Empirically
 * proved 100% reliable via scripts/paste-harness.js (vs the legacy split
 * delivery which was 4/5 on multi-line and 0/5 with text+Esc+Enter atomic).
 * The Ctrl+C interrupt for existing sessions stays here because it requires
 * the TUI to FULLY process the interrupt-clear before new text arrives;
 * sending it in the same atomic write as the text would cancel the text.
 */
export class CommandInjector {
  private pending = new Map<string, PendingInjection>();

  constructor(
    private sessionManager: SessionManager,
    private pasteEngine: PasteEngine,
  ) {}

  /**
   * Schedule an auto-command for delivery to a PTY session.
   *
   * @param taskId      - Task ID (used as map key; re-scheduling cancels previous)
   * @param sessionId   - Target session ID
   * @param command     - Already-interpolated command text (e.g. "/test" or "review the code")
   * @param opts.freshlySpawned - True if session was just spawned (wait for CLI startup)
   * @param opts.timeoutMs      - Hard timeout before giving up (default 120_000ms)
   */
  schedule(
    taskId: string,
    sessionId: string,
    command: string,
    opts?: { freshlySpawned?: boolean; timeoutMs?: number },
  ): void {
    // Cancel any existing injection for this task
    this.cancel(taskId);

    const freshlySpawned = opts?.freshlySpawned ?? false;
    const timeoutMs = opts?.timeoutMs ?? 120_000;

    // Check if session exists and has a live PTY
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      console.log(`[AUTO_COMMAND] No session ${sessionId.slice(0, 8)} -- skipping`);
      return;
    }

    // Existing session (not freshly spawned) -- inject immediately
    if (!freshlySpawned) {
      this.deliver(sessionId, taskId, command, true);
      return;
    }

    // Queued or freshly spawned -- need to wait for CLI to be alive
    const isQueued = session.status === 'queued';
    this.scheduleDeferred(taskId, sessionId, command, isQueued, timeoutMs);
  }

  /** Cancel a pending injection for a specific task. */
  cancel(taskId: string): void {
    const entry = this.pending.get(taskId);
    if (entry) {
      this.pending.delete(taskId);
      entry.cleanup();
    }
  }

  /** Cancel all pending injections. Called on killAll/suspendAll. */
  cancelAll(): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      entry.cleanup();
    }
  }

  /**
   * Handle deferred injection for freshly spawned or queued sessions.
   * Waits for the CLI to start (via 'thinking' event from hooks) before injecting.
   */
  private scheduleDeferred(
    taskId: string,
    sessionId: string,
    command: string,
    isQueued: boolean,
    timeoutMs: number,
  ): void {
    let state: 'queued' | 'waiting' = isQueued ? 'queued' : 'waiting';

    // --- Timers ---
    // 30s fallback: if hooks never fire, inject anyway (CLI should be running by then)
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    // Hard timeout: ultimate safety net
    const hardTimer = setTimeout(() => {
      console.warn(`[AUTO_COMMAND] Hard timeout (${timeoutMs}ms) for task ${taskId.slice(0, 8)} -- cancelling`);
      this.cancel(taskId);
    }, timeoutMs);

    const startFallbackTimer = (): void => {
      if (fallbackTimer) return;
      fallbackTimer = setTimeout(() => {
        if (!this.pending.has(taskId)) return;
        console.log(`[AUTO_COMMAND] 30s fallback for task ${taskId.slice(0, 8)} -- injecting`);
        detachAndDeliver();
      }, 30_000);
    };

    // Detach all event listeners and timers, then deliver the command.
    // deliver() sets a new pending entry that tracks the submit timers.
    const detachAndDeliver = (): void => {
      this.sessionManager.off('activity', onActivity);
      this.sessionManager.off('session-changed', onSessionChanged);
      this.sessionManager.off('exit', onExit);
      if (fallbackTimer) clearTimeout(fallbackTimer);
      clearTimeout(hardTimer);
      this.deliver(sessionId, taskId, command, false);
    };

    // --- Event listeners ---
    const onActivity = (evtSessionId: string, activityState: string): void => {
      if (evtSessionId !== sessionId) return;
      if (!this.pending.has(taskId)) return;

      if (state === 'waiting' && activityState === 'thinking') {
        // CLI is alive -- detach listeners and deliver command
        detachAndDeliver();
      }
    };

    const onSessionChanged = (evtSessionId: string, session: { status: string }): void => {
      if (evtSessionId !== sessionId) return;
      if (!this.pending.has(taskId)) return;

      if (state === 'queued' && session.status === 'running') {
        // Session started -- transition to waiting for CLI startup
        state = 'waiting';
        startFallbackTimer();
      }
    };

    const onExit = (evtSessionId: string): void => {
      if (evtSessionId !== sessionId) return;
      if (!this.pending.has(taskId)) return;

      console.log(`[AUTO_COMMAND] Session ${sessionId.slice(0, 8)} exited -- cancelling injection for task ${taskId.slice(0, 8)}`);
      this.cancel(taskId);
    };

    // --- Attach listeners ---
    this.sessionManager.on('activity', onActivity);
    this.sessionManager.on('session-changed', onSessionChanged);
    this.sessionManager.on('exit', onExit);

    // Start fallback timer immediately if not queued (already running)
    if (!isQueued) {
      startFallbackTimer();
    }

    const cleanup = (): void => {
      this.sessionManager.off('activity', onActivity);
      this.sessionManager.off('session-changed', onSessionChanged);
      this.sessionManager.off('exit', onExit);
      if (fallbackTimer) clearTimeout(fallbackTimer);
      clearTimeout(hardTimer);
    };

    this.pending.set(taskId, { cleanup });
  }

  /**
   * Deliver a command to a PTY session via the PasteEngine.
   *
   * Flow:
   *   1. (optional) Ctrl+C as a separate write to clear pending input or
   *      interrupt thinking. We give the TUI ~150ms to process the
   *      interrupt before sending the command text - if Ctrl+C and text
   *      were in the same atomic write, the interrupt would cancel the
   *      text we just wrote (verified via scripts/paste-harness.js).
   *   2. pasteEngine.pasteAndSubmit writes `text + \r` as ONE atomic
   *      pty.write, guaranteeing the Enter is processed in the same
   *      kernel read as the text. No autocomplete-Escape needed -
   *      atomic delivery sidesteps the autocomplete race entirely.
   *
   * @param sendCtrlC - Send Ctrl+C first to clear existing input / interrupt thinking
   */
  private async deliver(
    sessionId: string,
    taskId: string,
    command: string,
    sendCtrlC: boolean,
  ): Promise<void> {
    const sanitized = this.sanitize(command);
    if (!sanitized) {
      this.pending.delete(taskId);
      return;
    }

    // Per-delivery AbortController so cancel(taskId) can interrupt the
    // engine if it's mid-await on submission evidence.
    const controller = new AbortController();
    let interruptTimer: ReturnType<typeof setTimeout> | null = null;

    this.pending.set(taskId, {
      cleanup: () => {
        controller.abort();
        if (interruptTimer) clearTimeout(interruptTimer);
        this.pending.delete(taskId);
      },
    });

    try {
      if (sendCtrlC) {
        // Send Ctrl+C through the queue, then drain so it's flushed,
        // then a brief settle window to let the TUI process the
        // interrupt-clear before we deliver the new command. This window
        // is the ONLY wall-clock delay in the path; it's load-bearing
        // because the interrupt-clear is async on the TUI side.
        this.sessionManager.write(sessionId, '\x03');
        await this.sessionManager.drain(sessionId);
        await new Promise<void>((resolve, reject) => {
          if (controller.signal.aborted) {
            reject(new Error('aborted'));
            return;
          }
          interruptTimer = setTimeout(() => resolve(), 150);
          controller.signal.addEventListener('abort', () => {
            if (interruptTimer) clearTimeout(interruptTimer);
            reject(new Error('aborted'));
          }, { once: true });
        });
      }

      // Resolve per-adapter evidence so the engine waits on a deterministic
      // signal instead of any post-\r byte. resolveSubmissionEvidence falls
      // back to `{ minBytes: 50 }` when the adapter is unknown (extremely
      // rare - the session exists at this point) so cursor-blip false
      // positives are still filtered.
      const evidence = resolveSubmissionEvidence(this.sessionManager, sessionId);

      await this.pasteEngine.pasteAndSubmit(sessionId, sanitized, {
        bracketed: false,
        signal: controller.signal,
        source: `auto_command:${taskId.slice(0, 8)}`,
        evidence,
      });

      console.log(`[AUTO_COMMAND] Delivered to session ${sessionId.slice(0, 8)} for task ${taskId.slice(0, 8)}`);
    } catch (caughtError) {
      // Ignore aborts (cleanup already ran).
      const message = caughtError instanceof Error ? caughtError.message : String(caughtError);
      if (!message.includes('abort')) {
        console.warn(`[AUTO_COMMAND] Delivery failed for task ${taskId.slice(0, 8)}: ${message}`);
      }
    } finally {
      // Only clear pending if it's still our entry (cleanup may have
      // already cleared it during cancel).
      const entry = this.pending.get(taskId);
      if (entry) {
        this.pending.delete(taskId);
      }
    }
  }

  /**
   * Strip control characters from interpolated command text.
   * Newlines in a task title could prematurely submit a partial command.
   */
  private sanitize(command: string): string {
    return sanitizeForPty(command);
  }
}
