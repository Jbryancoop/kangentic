# Command Injection

Kangentic injects per-column "auto-commands" and per-column model/effort settings into a live agent session when a task moves between columns. The `CommandInjector` (`src/main/engine/command-injector.ts`) owns this flow. This document covers how the **command-injection** verification context confirms each chained command lands cleanly on the agent's TUI.

## Why verification exists

Column transitions can chain several commands in sequence: `/model X`, `/effort Y`, then a user-supplied `auto_command`. Without verification, an Enter key can be silently dropped by the TUI (autocomplete still showing, model picker overlay open, render frame skipped), causing the next command's text to concatenate into the previous prompt buffer. The result is a single combined entry like `<command-args>claude-opus-4-7\n/effort xhigh</command-args>` -- a "model not found" failure that quietly leaves the column's intended settings unapplied.

Time-based settles cannot detect this because the writes did succeed; only the input semantics broke. We need an **authoritative signal** from the agent that the command was processed as the discrete invocation we intended.

## The verifier contract

Adapters declare verification capability via the optional `getSubmissionVerifier` method:

```typescript
interface AgentAdapter {
  getSubmissionVerifier?(contextType: SubmissionContextType): SubmissionVerifier | null;
}

type SubmissionContextType = 'paste' | 'command-injection';

type SubmissionContext =
  | { type: 'paste' }
  | { type: 'command-injection'; text: string; agentSessionId?: string; cwd?: string; sentAt?: number };

type SubmissionVerifier = (context: SubmissionContext) => Promise<boolean>;
```

For the `'command-injection'` context, the verifier receives the literal command text plus session metadata (the captured `agent_session_id`, the session `cwd`, and `sentAt` — the wall-clock timestamp of the most recent Enter the verifier should match against) and returns `true` once it confirms the command was processed. `sentAt` advances on each retry-Enter so stale transcript entries from previous attempts cannot satisfy the current verification.

## Claude's JSONL-polling implementation

Claude is the only adapter that currently provides a `'command-injection'` verifier. Claude Code writes every successful slash invocation to its session JSONL transcript as a `local_command` system entry whose `<command-name>` matches the slash and whose `<command-args>` matches exactly what was sent. The verifier (`src/main/agent/adapters/claude/slash-command-verifier.ts`) tail-scans this file for an entry matching both fields exactly:

- Match `<command-name>` against the slash (e.g. `/model`).
- Match `<command-args>` against the literal args we sent (e.g. `claude-opus-4-7`).

A combined-args entry like `claude-opus-4-7\n/effort xhigh` is **not** a match by design -- that is the failure mode we want to detect and retry.

The scan is bounded by a 50ms tolerance window around the send time (`Date.now()` at the moment of the Enter), so the polling cadence (~25ms) lands on the expected entry within ~50-100ms in the happy path.

## Retry semantics in `CommandInjector`

`CommandInjector.scheduleSequence` chains commands with the following timing:

1. Initial write of command text + Escape + Enter (text → `\x1b` → `\r`).
2. **If the command falls within `verifiedPrefixLength`**: poll the verifier every 25ms for up to 400ms. If unconfirmed, re-fire `\r` and try again. After 4 retries, log a warning, send Ctrl+C to clear the prompt buffer, and continue with the next command.
3. **Otherwise** (no verifier, or command falls outside the verified prefix): wait a fixed 500ms settle window before the next command.

The `verifiedPrefixLength` distinction is critical: deterministic adapter-emitted writes (`/model X`, `/effort Y` from `getInjectionSequence`) are safe to verify because we know exactly what JSONL entry to expect. A trailing user-supplied `auto_command` is **not** verified: it may not produce a matching JSONL entry the verifier recognizes, and retry exhaustion would drop the user's intended action. So we let auto-commands sail through with a time-based settle.

## When to use `'paste'` vs `'command-injection'`

| Context | Caller | What gets verified | Latency |
|---------|--------|-------------------|---------|
| `'paste'` | `pasteEngine.pasteAndSubmit` (browser captures, single auto-command paste) | "the agent acknowledged this prompt" | 100-500ms |
| `'command-injection'` | `CommandInjector.scheduleSequence` (chained slash commands) | "this exact command was processed as a discrete invocation" | 50-150ms typical, ~2s worst case |

The two contexts solve different problems: `'paste'` confirms one-shot paste submissions of arbitrary user prompts, while `'command-injection'` confirms each link in a multi-command chain landed cleanly. They share an interface (`getSubmissionVerifier`) so adapters declare what they support per context, and the renderer/IPC layer never has to branch on agent name.

**OR-combine vs poll-and-retry.** The two contexts also differ in how the engine consumes the verifier:

- `'paste'` runs the verifier **in parallel** with the activity-event listener and post-`\r` data path. The first signal to resolve wins. A verifier resolving `false` does not short-circuit the fallbacks — they remain active for the rest of the wait window. This matches the "best-effort confirmation" model: a verifier strengthens evidence but cannot weaken the existing fallback path.
- `'command-injection'` runs the verifier in a **tight poll loop** inside `CommandInjector.pollWithRetries`. On each iteration the verifier is invoked with the current `sentAt`; if it returns `false`, the loop sleeps `pollMs` and retries. Past the retry interval (with no confirmation), Enter is re-fired and `sentAt` advances. This matches the "deterministic chain" model: each command must be confirmed before the next.

## Per-adapter support matrix

| Adapter | `'paste'` | `'command-injection'` |
|---------|-----------|----------------------|
| Claude | `null` (time-based fallback) | JSONL-polling verifier |
| Codex / Gemini / Qwen | `null` | `null` |
| OpenCode / Copilot / Aider | `null` | `null` |
| Cursor / Droid / Kimi / Warp | `null` | `null` |

When an adapter returns `null`, the caller falls back to:
- `'paste'`: activity event or any post-`\r` data byte (within 3s).
- `'command-injection'`: a fixed 500ms inter-command settle.

A non-Claude adapter could implement `'command-injection'` verification once its CLI exposes a comparable structured signal (e.g. a CLI-emitted JSONL transcript with command markers). Until then, time-based settles are the safest universal default.

## Test coverage

- `tests/unit/agent-submission-verifier-shape.test.ts` enforces every registered adapter implements `getSubmissionVerifier`.
- `tests/unit/command-injector.test.ts` covers the single-command path including `getSubmissionVerifier('paste')` wiring.
- `tests/unit/command-injector-sequence.test.ts` covers chained sequences with verifier success, retry-on-unconfirmed, and `verifiedPrefixLength` behavior.
- `tests/unit/injection-plan.test.ts` covers `prepareInjectionPlan` wiring the verifier to `CommandInjector.scheduleSequence`.

## Files

- `src/main/engine/injection-plan.ts` -- builds the chained sequence + verifier from a column transition spec.
- `src/main/engine/command-injector.ts` -- delivers the sequence to the PTY with retry-on-unconfirmed semantics.
- `src/main/agent/adapters/claude/slash-command-verifier.ts` -- Claude-specific JSONL-polling implementation.
- `src/shared/types.ts` -- `SubmissionContext`, `SubmissionContextType`, `SubmissionVerifier` type definitions.
