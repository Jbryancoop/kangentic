import type { SessionManager } from '../pty/session-manager';
import type { PasteEngine } from '../pty/paste-engine';
import { sanitizeForPty } from '../../shared/paths';
import { agentRegistry } from '../agent/agent-registry';

/**
 * Per-command verifier the CommandInjector polls between writes when delivering
 * a chained injection sequence (e.g. `/model X` then `/effort Y`). Returns true
 * when the agent has confirmed the injected command was processed, false on
 * single-scan miss. Adapters supply this via `getSubmissionVerifier('command-injection')`,
 * with the `sentAt` of the most recent Enter so the verifier can bound its scan
 * window.
 *
 * Exported here as the single source of truth - `injection-plan.ts` and
 * `slash-command-verifier.ts` both import this rather than redeclaring locally.
 */
export type CommandVerifier = (command: string, sentAt: number) => Promise<boolean>;

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

  /**
   * Active sequence delivery worker, keyed by taskId. Tracks both the
   * currently-running burst and a single "queued next" sequence so rapid
   * scheduleSequence() calls coalesce: only the most-recently-scheduled
   * sequence runs after the current one completes. Intermediate schedules
   * (e.g. transient drags through a column) are dropped harmlessly.
   */
  private sequenceWorkers = new Map<string, {
    sessionId: string;
    next: {
      commands: string[];
      verifier: CommandVerifier | null;
      verifiedPrefixLength: number;
    } | null;
  }>();

  /**
   * Schedule a chain of commands to a single live PTY session. Used by the
   * column-transition flow where we may need to send `/model X`, `/effort Y`,
   * and an `auto_command` in sequence - calling `schedule()` three times would
   * not work because each call cancels the prior pending entry.
   *
   * Two competing constraints shape the implementation:
   *
   * 1. **Ink-based TUI keypress framing**: Claude Code is a React-for-CLI
   *    (Ink) app. Writes that arrive within the same tick are treated as a
   *    paste, in which case `\r` becomes a literal newline-in-input instead
   *    of Submit. We stagger text -> Escape -> Enter with ~100ms between so
   *    each lands as a separate keypress.
   * 2. **Rapid drag robustness**: when a second scheduleSequence call lands
   *    while the first is still firing keypresses, we cannot interleave the
   *    second's writes (they would scramble the in-flight prompt). Instead
   *    we stash the new commands as the worker's "next" sequence; when the
   *    current burst finishes, the worker drains "next" (overwriting any
   *    intermediate schedules). End result for a fast A->B->A->B drag: the
   *    first sequence runs to completion, then the latest one runs - middle
   *    transitions are coalesced away.
   */
  scheduleSequence(
    taskId: string,
    sessionId: string,
    commands: string[],
    opts: {
      verifier?: CommandVerifier | null;
      /**
       * Number of leading commands in `commands` to verify with the supplied
       * verifier. The remaining commands are written and time-settled like
       * the unverified path. Lets callers (e.g. prepareInjectionPlan) verify
       * deterministic adapter-emitted writes (`/model X`, `/effort Y`) while
       * leaving user-supplied auto_commands fire-and-forget - the verifier
       * cannot know whether a `/`-prefixed user command will produce a
       * matching JSONL entry, so attempting to verify it risks dropping the
       * user's intended command after retry exhaustion. Defaults to
       * verifying every command when a verifier is supplied (legacy
       * single-purpose use).
       */
      verifiedPrefixLength?: number;
    } = {},
  ): void {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      console.log(`[AUTO_COMMAND] No session ${sessionId.slice(0, 8)} -- skipping sequence`);
      return;
    }
    const sanitized = commands.map((c) => this.sanitize(c)).filter((c) => c.length > 0);
    if (sanitized.length === 0) return;

    const verifier = opts.verifier ?? null;
    // Default to verifying everything when a verifier is provided; clamp to
    // the actual sanitized length so an over-large hint doesn't index past
    // the array. Filter-then-clamp is intentional: an empty command was
    // dropped, but the caller's prefix length still refers to the
    // pre-filter sequence; clamping is the safe interpretation.
    const verifiedPrefixLength = verifier
      ? Math.min(opts.verifiedPrefixLength ?? sanitized.length, sanitized.length)
      : 0;

    const existing = this.sequenceWorkers.get(taskId);
    if (existing) {
      // A burst is in flight. Stash this as "next"; the worker will pick it
      // up when the current burst finishes. Overwriting any previous "next"
      // intentionally coalesces transient drags.
      existing.next = { commands: sanitized, verifier, verifiedPrefixLength };
      console.log(
        `[AUTO_COMMAND] Queueing sequence for task ${taskId.slice(0, 8)} (in-flight burst running)`
      );
      return;
    }

    // No burst in flight - start one immediately.
    this.sequenceWorkers.set(taskId, { sessionId, next: null });
    void this.writeSequence(taskId, sessionId, sanitized, verifier, verifiedPrefixLength);
  }

  /**
   * Write one staggered sequence to the PTY, then drain the worker's "next"
   * sequence if one was queued while this one was in flight.
   *
   * Reliability: each write goes through `sessionManager.write` which
   * enqueues into the per-session FIFO write-queue. That queue is the same
   * mechanism that keeps Ctrl+V paste sequences intact under concurrent
   * writes - byte order is FIFO regardless of caller. Combined with the
   * inter-keypress delays, each character lands as a discrete Ink keypress
   * rather than a paste, so `\r` is interpreted as Submit.
   *
   * Wrapped in try/catch so a thrown write (e.g. the PTY died mid-sequence)
   * always tears down the worker entry; otherwise future scheduleSequence()
   * calls for the same task would silently queue forever.
   */
  private async writeSequence(
    taskId: string,
    sessionId: string,
    commands: string[],
    verifier: CommandVerifier | null,
    verifiedPrefixLength: number,
  ): Promise<void> {
    const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

    // Tunables. The verified path is optimized for "feels instant": ~80ms
    // per keypress group (40ms text→Esc, 40ms Esc→Enter), sub-100ms
    // confirmation polling, and a tight retry loop so a missed Enter is
    // recovered within a couple hundred ms instead of seconds. Without
    // verification, COMMAND_SETTLE stays conservative because we have no
    // signal - 500ms swallows Claude's /model context-cache refresh worst
    // case for the unverified fallback path.
    const CTRL_C_SETTLE = 100;
    const KEYPRESS_DELAY = 40;
    const COMMAND_SETTLE = 500;
    // Verification cadence: poll the JSONL aggressively (25ms = ~40 Hz),
    // and if we haven't seen confirmation within RETRY_INTERVAL, fire
    // another Enter. Most missed-Enter cases recover on the first or
    // second retry, so total verification time in the happy path is
    // ~50-150ms and in the worst case ~2s before we give up.
    const VERIFY_POLL_MS = 25;
    const RETRY_INTERVAL_MS = 400;
    const MAX_RETRIES = 4;

    try {
      // Leading Ctrl+C clears any half-typed input or interrupts thinking.
      this.sessionManager.write(sessionId, '\x03');
      await wait(CTRL_C_SETTLE);

      for (let commandIndex = 0; commandIndex < commands.length; commandIndex++) {
        const command = commands[commandIndex];
        const shouldVerify = verifier !== null && commandIndex < verifiedPrefixLength;
        const sentAt = Date.now();
        this.sessionManager.write(sessionId, command);
        await wait(KEYPRESS_DELAY);
        this.sessionManager.write(sessionId, '\x1b'); // Escape - dismiss autocomplete
        await wait(KEYPRESS_DELAY);
        this.sessionManager.write(sessionId, '\r');   // Enter - submit

        if (shouldVerify && verifier) {
          const confirmed = await this.pollWithRetries(
            verifier,
            command,
            sentAt,
            sessionId,
            { pollMs: VERIFY_POLL_MS, retryIntervalMs: RETRY_INTERVAL_MS, maxRetries: MAX_RETRIES },
          );
          if (!confirmed) {
            // After exhausting retries, clear any stuck text from the
            // prompt buffer so the next command does not concatenate
            // into the failed one. Better to drop the command than to
            // produce a malformed combined invocation.
            console.warn(
              `[AUTO_COMMAND] Verification failed for "${command}" on task ${taskId.slice(0, 8)}`
              + ` after ${MAX_RETRIES} retries -- clearing prompt and continuing`,
            );
            this.sessionManager.write(sessionId, '\x03');
            await wait(50);
          }
        } else {
          await wait(COMMAND_SETTLE);
        }
      }

      console.log(
        `[AUTO_COMMAND] Delivered sequence (${commands.length} cmds) to session ${sessionId.slice(0, 8)}`
        + ` for task ${taskId.slice(0, 8)}: ${commands.join(' | ')}`,
      );
    } catch (error) {
      console.error(
        `[AUTO_COMMAND] writeSequence failed for task ${taskId.slice(0, 8)}:`, error,
      );
      this.sequenceWorkers.delete(taskId);
      return;
    }

    const worker = this.sequenceWorkers.get(taskId);
    if (!worker) return;
    if (worker.next && worker.next.commands.length > 0) {
      const next = worker.next;
      worker.next = null;
      // Recurse to drain the queued sequence. Worker entry stays alive so
      // any further schedules continue to coalesce.
      await this.writeSequence(taskId, sessionId, next.commands, next.verifier, next.verifiedPrefixLength);
      return;
    }
    this.sequenceWorkers.delete(taskId);
  }


  /**
   * Poll a verifier with a tight loop and re-send Enter periodically when
   * confirmation does not arrive. This is the reliability core of the
   * verified path: in the happy case the JSONL entry appears within
   * 50-100ms of the initial Enter and we return immediately; in the
   * "Enter eaten by overlay" case we re-fire Enter every retryIntervalMs
   * until either a write lands cleanly or we exhaust the retry budget.
   */
  private async pollWithRetries(
    verifier: CommandVerifier,
    command: string,
    initialSentAt: number,
    sessionId: string,
    opts: { pollMs: number; retryIntervalMs: number; maxRetries: number },
  ): Promise<boolean> {
    const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    let sentAt = initialSentAt;
    let retries = 0;
    while (true) {
      const deadline = Date.now() + opts.retryIntervalMs;
      while (Date.now() < deadline) {
        if (await verifier(command, sentAt)) return true;
        await wait(opts.pollMs);
      }
      if (retries >= opts.maxRetries) return false;
      retries += 1;
      sentAt = Date.now();
      this.sessionManager.write(sessionId, '\r');
    }
  }

  /**
   * Cancel a pending injection for a specific task. Drops the queued "next"
   * sequence on any active worker but does NOT interrupt an in-flight burst:
   * once a burst has started writing keypresses, aborting mid-stream would
   * leave Claude's TUI in a half-typed state. Callers that need to truly
   * stop a session should use sessionManager.kill/suspend instead.
   */
  cancel(taskId: string): void {
    const entry = this.pending.get(taskId);
    if (entry) {
      this.pending.delete(taskId);
      entry.cleanup();
    }
    const worker = this.sequenceWorkers.get(taskId);
    if (worker) worker.next = null;
  }

  /** Cancel all pending injections. Called on killAll/suspendAll. */
  cancelAll(): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      entry.cleanup();
    }
    for (const worker of this.sequenceWorkers.values()) {
      worker.next = null;
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

      // Get the adapter's submission verifier for paste context so the engine
      // waits on a deterministic signal instead of any post-\r byte. When the
      // adapter is unknown or has no verifier (extremely rare - the session
      // exists at this point), the engine falls back to time-based settle.
      const session = this.sessionManager.getSession(sessionId);
      const agentName = session ? this.sessionManager.getSessionAgentName(sessionId) : null;
      const adapter = agentName ? agentRegistry.get(agentName) : undefined;
      const verifier = adapter?.getSubmissionVerifier?.('paste') ?? undefined;

      await this.pasteEngine.pasteAndSubmit(sessionId, sanitized, {
        bracketed: false,
        signal: controller.signal,
        source: `auto_command:${taskId.slice(0, 8)}`,
        verifier,
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
