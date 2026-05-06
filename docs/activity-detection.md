# Activity Detection

Kangentic tracks whether each agent session is **thinking** (working on a turn), **idle** (waiting for input or done), or in a **permission** state (paused awaiting user approval). This drives the task card spinner, the desktop "task done" notification, idle-timeout suspend, and auto-focus behavior.

## Why this matters

The "task done" notification is one of Kangentic's core differentiators. Agents that have started backgrounded work (`Bash(run_in_background:true)`) are still working until those processes exit, even after the agent's hook stream has gone quiet. A session that prematurely shows "idle" causes a false notification; one that's stuck in "thinking" never notifies at all. Both are user-visible bugs.

This subsystem aims to be near-100% accurate: notification fires within seconds of the agent (and all its background work) actually being done.

## Architecture

```
   ┌──────────────────────────────────────────────────────────────────┐
   │  Agent CLI hook ↦ event-bridge.js ↦ events.jsonl                 │
   │  (each adapter wires its own hook flow; see below)               │
   └─────────────────────────────────┬────────────────────────────────┘
                                     │
                ┌────────────────────▼─────────────────────┐
                │  StatusFileReader (watches events.jsonl) │
                │  → SessionTelemetry.ingestEvents(events) │
                └────────────────────┬─────────────────────┘
                                     │
   ┌─────────────────────────────────▼──────────────────────────────────┐
   │              ActivityEngine (single-predicate state machine)        │
   │                                                                    │
   │   activity = 'permission' IFF permissionPending                    │
   │            = 'thinking'   IFF turnActive                           │
   │                              OR subagentDepth > 0                  │
   │                              OR backgroundShells > 0               │
   │            = 'idle'       otherwise                                │
   └─────────────────────────────────┬──────────────────────────────────┘
                                     │
                ┌────────────────────┼─────────────────┬──────────────┐
                ▼                    ▼                 ▼              ▼
   ┌───────────────────┐ ┌─────────────────────────┐ ┌────────────┐ ┌────────────┐
   │ Stability window  │ │ Watchdog table (3 holds)│ │ BgShell    │ │ Ctrl+C     │
   │ (400ms)           │ │ - bg-shell hatch (5min) │ │ Watcher    │ │ synthesis  │
   │                   │ │ - stuck-tools  (5min)   │ │ (proc-tree)│ │ (3s settle)│
   │                   │ │ - stale-think  (45s)    │ │            │ │            │
   └───────────────────┘ └─────────────────────────┘ └────────────┘ └────────────┘
                                                          │
                                                          ▼
                                                ┌────────────────────┐
                                                │ ProcessTreeProbe   │
                                                │ Win: Get-CimInstance│
                                                │ POSIX: ps -A       │
                                                └────────────────────┘
```

## Key files

The engine itself is split across modules under `pty/activity/engine/`. External consumers import from `engine/index.ts`; internal modules are implementation details.

| File | Role |
|------|------|
| `src/main/pty/activity/engine/index.ts` | Public surface re-exports (`ActivityEngine`, `ActivitySnapshotWriter`, types, default constants) |
| `src/main/pty/activity/engine/activity-engine.ts` | Engine class - lifecycle + orchestration (delegates to the modules below) |
| `src/main/pty/activity/engine/shapes.ts` | `SessionEngineState`, `ActivityEngineOptions`, `TransitionRecord`, `PendingTool`, event sets, default thresholds |
| `src/main/pty/activity/engine/predicate.ts` | Pure `derivePredicate` / `deriveReason` / `deriveActivityAndReason` - no engine reference, no mutation |
| `src/main/pty/activity/engine/event-handlers.ts` | Pure `updateCounters` / `updatePermissionFlag` - the big switch on event type |
| `src/main/pty/activity/engine/counter-snapshot.ts` | `snapshotCounters` and `formatCounterDelta` for the audit log |
| `src/main/pty/activity/engine/state-factory.ts` | `createSessionEngineState` initial-state factory |
| `src/main/pty/activity/engine/watchdog.ts` | `WatchdogHold` table + `findActiveWatchdogHold` lookup - declarative safety nets |
| `src/main/pty/activity/engine/snapshot-writer.ts` | `ActivitySnapshotWriter` - atomic JSON snapshots for post-mortem diagnostics |

Surrounding infrastructure:

| File | Role |
|------|------|
| `src/main/pty/activity/session-telemetry.ts` | Wires the engine to event ingestion + PTY tracker + watchers + user-interrupt coordinator |
| `src/main/pty/activity/user-interrupt-coordinator.ts` | 3-second settle timer for Ctrl+C; synthesizes Interrupted if engine still hot |
| `src/main/pty/activity/usage-accumulator.ts` | Per-tool usage stats (call count, cost, tokens) |
| `src/main/pty/activity/pr-command-detector.ts` | PR command pattern detector |
| `src/main/pty/activity/pty-activity-tracker.ts` | PTY-byte fallback for non-hook agents |
| `src/main/pty/activity/background-shell/watcher.ts` | Process-tree-based natural-exit detector |
| `src/main/pty/activity/background-shell/process-tree.ts` | Cross-platform descendant enumeration; `listAllProcesses` shared once per cycle |
| `src/main/pty/activity/background-shell/resume.ts` | Resume-time orphan adoption |
| `src/main/pty/activity/background-shell/looks-like-shell-id.ts` | Shell-id shape gate |
| `src/main/agent/event-bridge.js` | Generic hook-to-JSONL bridge with directive language (tool, tool-id, detail, remap, ...) |
| `src/main/agent/adapters/claude/hook-manager.ts` | Claude Code hook configuration |
| `src/shared/types.ts` | `ActivityState`, `ActivityReason`, `EventType`, `SessionEvent.toolId` |

## ActivityState

```ts
type ActivityState = 'thinking' | 'idle' | 'permission';
```

Three top-level states:

- **`thinking`** — agent is working. Spinner shown on task card. Notifications NOT fired.
- **`idle`** — agent is truly done. Notification fires. Auto-focus / auto-suspend can act.
- **`permission`** — agent paused awaiting user approval. Distinct from `idle` so the UI can render a different affordance (lock icon vs idle dot).

## ActivityReason (discriminated union)

Every transition emits both an `ActivityState` AND an `ActivityReason` describing WHY:

```ts
type ActivityReason =
  | { kind: 'idle' }
  | { kind: 'permission' }
  | { kind: 'tool';            pendingCount: number; currentTool: string | null }
  | { kind: 'subagent';        depth: number }
  | { kind: 'background-shell'; count: number; ids: readonly string[] }
  | { kind: 'turn-active' };
```

The renderer uses `reason.kind` to pick a Lucide icon (Wrench / Users / Terminal / Lock / Loader2 / Mail) and inline label for the TaskCard hover tooltip.

Priority ladder: `permission > tool > subagent > background-shell > turn-active > idle`. Anchored to `state.activity` for consistency — when forced paths (Interrupted, forceIdle) commit a transition that diverges from the bare predicate (e.g. clearing all counters on Esc), the reason follows the committed state.

## EventType reference

The 21 `EventType` values written to `events.jsonl` by `event-bridge.js`, defined in `src/shared/types.ts`. The activity column shows how each event maps to `ActivityState` via the `EventTypeActivity` table, also in `src/shared/types.ts`.

| EventType key | JSONL value | Activity mapping | Notes |
|---------------|-------------|------------------|-------|
| `Prompt` | `prompt` | `thinking` | User submitted a prompt; agent is starting a turn |
| `ToolStart` | `tool_start` | `thinking` | Agent began invoking a tool |
| `ToolEnd` | `tool_end` | log-only | Tool returned; counters update but state does not |
| `Idle` | `idle` | `idle` | Agent finished its turn (Stop hook, prompt-regex, or silence timer) |
| `Interrupted` | `interrupted` | `idle` | User pressed Esc / Ctrl+C; clears counters and commits idle |
| `SessionStart` | `session_start` | log-only | Session began; carries adapter session metadata |
| `SessionEnd` | `session_end` | log-only | Session ended (CLI process exited) |
| `SubagentStart` | `subagent_start` | `thinking` | Main agent spawned a child agent |
| `SubagentStop` | `subagent_stop` | log-only | Subagent returned; depth counter decrements |
| `Notification` | `notification` | log-only | Informational notification from the agent |
| `Compact` | `compact` | `thinking` | Context-window compaction in progress |
| `TeammateIdle` | `teammate_idle` | log-only | Cross-agent teammate signaled idle |
| `TaskCompleted` | `task_completed` | log-only | Agent declared the task finished |
| `ConfigChange` | `config_change` | log-only | Agent settings/model changed mid-session |
| `WorktreeCreate` | `worktree_create` | `thinking` | Agent created a git worktree |
| `WorktreeRemove` | `worktree_remove` | log-only | Agent removed a git worktree |
| `BackgroundShellStart` | `background_shell_start` | `thinking` | `Bash(run_in_background: true)` launched |
| `BackgroundShellEnd` | `background_shell_end` | log-only | `KillBash` invoked; decrements active-shells counter |
| `ModelStart` | `model_start` | log-only | LLM API call beginning (Qwen/Gemini per-call telemetry) |
| `ModelEnd` | `model_end` | log-only | LLM API call returned |
| `ToolSelectionStart` | `tool_selection_start` | log-only | Agent is choosing the next tool |

"log-only" means the event is recorded for the activity feed and may update internal counters, but does not on its own change `ActivityState`. State changes only occur through the predicate (see below) or via direct `Idle` / `Interrupted` events.

## ActivityDetectionStrategy variants

Each adapter declares one strategy via its `runtime.activity` field (constructed through the `ActivityDetection` factory). The three variants:

| Kind | Hooks fire? | PTY fallback? | Used by | Semantics |
|------|-------------|---------------|---------|-----------|
| `hooks` | Yes (sole source of truth) | No | Claude Code | Activity state is driven exclusively by hook deliveries. PTY traffic is ignored for state transitions. |
| `pty` | No | Yes | Aider, Cursor, Warp, Droid, Codex (today) | No hook protocol available. The PTY tracker emits `forceIdle` after a silence window, optionally short-circuited by an adapter-supplied `detectIdle(data)` regex that matches the agent's input prompt. |
| `hooks_and_pty` | Yes (primary) | Yes (fallback) | Gemini, Qwen, Kimi, OpenCode, Copilot | Hooks are authoritative when they fire; the PTY tracker is auto-suppressed on the first hook event and re-engages only if hooks stop arriving. |

Both `pty` and `hooks_and_pty` may pass an optional `detectIdle(data: string) => boolean` for instant idle detection from the input-prompt regex. Without it, idle is inferred from a silence timer.

## Predicate

The engine exposes ONE predicate:

```
'thinking' IFF turnActive
            OR subagentDepth > 0
            OR (activeBackgroundShellIds.size + anonymousBackgroundShellCount) > 0
'permission' IFF permissionPending
'idle' otherwise
```

Notably absent: `pendingToolCount` is NOT in the predicate. An explicit `Idle` event (Stop hook) must transition to idle even if a tool's PostToolUse never arrived. `pendingToolCount` only drives the `'tool'` reason for UI tooltips.

### turnActive

Set on any "thinking-initiating" event (`ToolStart`, `Prompt`, `SubagentStart`, `Compact`, `WorktreeCreate`, `BackgroundShellStart`). Cleared by `Idle`, `Interrupted`. Persists across the silent gaps between tool calls so the spinner doesn't flicker.

### Subagent depth

Tracks nested subagent invocations. SubagentStop decrements (clamped to 0). When the main agent fires Stop while a subagent is still running, `turnActive = false` but `subagentDepth > 0` keeps the predicate true. Idle emits when depth hits 0 (and no other counter holds).

### Background-shell tracking (Set + anonymous fallback)

Two storage modes:

- **`activeBackgroundShellIds: Set<string>`** — when the hook directive extracted a `shell_id` (today: KillBash events), the engine tracks shells by id. `markBackgroundShellEnded(sessionId, shellId)` removes the matching id.
- **`anonymousBackgroundShellCount: number`** — fallback for shells whose start-event lacked a shell_id (the common case today; production hooks emit the command string as detail, not a shell_id). The watcher's count-based heuristic decrements this.

The predicate uses `set.size + anonymousCount > 0` so both modes coexist.

### Permission flag

Set when an `Idle` event fires with `detail: 'permission'`. Cleared by:
- `Prompt` (user typed something new)
- `Interrupted` (Esc)
- `SubagentStart` (main agent spawning a child)
- `Idle` with non-permission detail (agent ended turn)
- `ToolStart`/`ToolEnd` at `subagentDepth === 0` (main agent activity)

Subagent-tool events at depth>0 do NOT clear permission (the permission belonged to the main agent which is still paused).

### Tool tracking (stack with correlation IDs + LIFO-by-name fallback)

`pendingToolStack: Array<{ id?: string; name: string }>` records in-flight tools in start order. `currentTool` always reflects the top of the stack and is exposed via `ActivityReason` for the TaskCard hover tooltip ("Running Bash").

ToolEnd matching priority:
1. **By correlation id** — when both events carry `event.toolId` (Claude's `tool_use_id` extracted via the `tool-id` / `tool-id-nested` directives), exact removal regardless of stack position. Solves the duplicate-name and out-of-order cases.
2. **LIFO-by-name** — fallback when an event has no toolId or the id didn't match (drift recovery from hook drop or version skew).
3. **Raw pop** — fallback for `Interrupted` (no tool name carried).

Hard reset on `pendingToolCount === 0`: the stack is cleared even if name desync left dangling entries. Idle events also clear the stack (see "Idle clamp" below).

Adapters opt into ID correlation by adding `tool-id:<field>` and `tool-id-nested:<parent>:<field>` directives to their hook config. Adapters without correlation IDs leave `event.toolId` undefined and the engine falls back to LIFO-by-name automatically - no breaking change.

### Idle clamp

When a non-permission `Idle` event arrives, the engine forcibly clears `pendingToolCount`, the stack, and `currentTool`. The agent's turn is done; any unmatched ToolStart events are stale by definition (PostToolUse hook dropped, tool force-killed, etc.).

Permission idles bypass the clamp because the agent paused awaiting approval and may resume the same tool.

## Stability window (400ms)

When the predicate flips from `thinking` to `idle` due to a Stop event or a counter clearing, the engine waits 400ms before emitting the transition. If a thinking signal arrives during the window, the pending idle is cancelled. Prevents `idle → thinking → idle` flicker from out-of-order hook arrivals.

Bypassed by:
- `Interrupted` (Esc — instant, no flicker concern)
- `forceIdle` (PTY-driven; already debounced 3s in PtyActivityTracker)
- Stale-thinking watchdog (already 45s)

Configurable via `ActivityEngineOptions.idleStabilityWindowMs`. Tests set this to 0 for deterministic timing.

## Three safety nets (the watchdog table)

The predicate handles the common case. Three timer-driven safety nets in `engine/watchdog.ts` catch hook-loss / orphan situations. Each is a `WatchdogHold` describing a state shape, threshold, reset action, and audit-log label. `findActiveWatchdogHold(state, holds)` picks the matching one each cycle.

### 1. Stale-thinking watchdog (45s)

Held by `turnActive` alone (no tools, no subagent, no bg shells) for 45 seconds. The matching Idle/Stop hook never arrived. Emits synthetic `Idle/Timeout`, clears `turnActive`. Bypasses the stability window (the 45s already debounced any flicker).

### 2. Bg-shell escape hatch (5 min)

Held by background shells alone for 5 minutes. The process-tree watcher couldn't observe the natural exit (probe failure, unusual platform, etc.). Force-clears the counters and emits idle through the stability window.

In practice the watcher catches most cases within seconds; the 5-min hatch is a final safety net.

### 3. Stuck-pending-tools watchdog (5 min)

Held by `pendingToolCount > 0` alone for 5 minutes. Common cause: user pressed Ctrl+C, the agent killed the bash, but `PostToolUseFailure` didn't propagate. Without this hatch the engine would be stuck in `thinking` forever - the stale-thinking watchdog requires `pendingToolCount === 0` to fire, the bg-shell hatch requires bg shells, and the Idle clamp only works when Idle actually fires.

Resets `pendingToolCount`, the stack, `currentTool`, AND `turnActive` (the matching Stop hook for this turn was lost along with the PostToolUse). Goes through the stability window for the same reason as the bg-shell hatch.

Real long-running foreground tools rarely run 5 min in total silence - they emit nested ToolStart/End from sub-tools and subagents that refresh `lastSignalAt`.

### Adding a new watchdog

Append to the table in `buildWatchdogHolds()`:

```ts
{
  predicate: (state) => /* what state shape qualifies as stuck */,
  thresholdMs: config.someThresholdMs,
  trigger: 'timer:my-watchdog',
  reset: (state) => { /* mutations to clear the hold */ },
  applyStabilityWindow: true,
}
```

The predicates are mutually exclusive (each requires exactly one signal source non-zero, others zero) so order only matters when predicates could overlap.

## Ctrl+C user-interrupt synthesis (3s)

When the user presses Ctrl+C in a session terminal, the renderer fires the `notifyUserInterrupt` IPC alongside the regular `\x03` write to the PTY. Telemetry arms a 3-second settle timer per session. After the window, if the engine is still in `thinking` AND state is hot (`pendingToolCount > 0` OR `turnActive`), telemetry synthesizes an `Interrupted` event with `detail: 'user-ctrl-c'`. The engine's Interrupted handler clears all counters and commits idle immediately.

If Claude's hooks already recovered the engine state during the settle window, the synthetic is a no-op (state isn't hot). Multiple rapid Ctrl+C presses collapse to one - the existing timer is cleared and re-armed each time.

Without this path, hook-drop scenarios on Ctrl+C have to wait for the 5-minute stuck-pending-tools watchdog to fire.

## BgShellWatcher (the primary natural-exit mechanism)

Empirical analysis of ~50 production sessions found:
- ~206 `background_shell_start` events
- ~4 `background_shell_end` events (KillBash)
- 0 `BashOutput` tool calls

Conclusion: agents almost never explicitly end their bg shells. The only reliable signal is OS process-tree observation.

### How it works

The watcher polls every 2 seconds. For each session with `activeShellCount > 0`:

1. Check if the Claude CLI's root PID is alive. If dead, fire `onRootProcessDied` (engine forceIdle).
2. Enumerate the Claude CLI's descendant processes via `ps` (POSIX) or `Get-CimInstance Win32_Process` (Windows).
3. **Tier A (PID-aware):** for shells registered via `registerShellPid(shellId, pid)`, check `isAlive(pid)`. If dead, fire `onShellPidExited(shellId)` → engine removes by id.
4. **Tier B (count heuristic):** filter descendants to "shell-like" basenames (bash, sh, cmd, pwsh, node, npm, npx, python, etc.). If the count dropped below the snapshot taken at the last `background_shell_start` AND the engine reports tracked shells, fire `onNaturalExit(delta)`. Engine drains anonymous count by delta.

### Lazy polling

The watcher only polls when at least one session has `getActiveShellCount() > 0`. Idle Kangentic = zero polls.

### Cross-platform

- **Windows:** `powershell.exe -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Csv -NoTypeInformation"`. Walks the parent map in JS. Times out at 1.5s.
- **POSIX:** `ps -A -o pid=,ppid=,comm=`. Walks the parent map in JS. Times out at 1.5s.
- **Liveness probe:** `process.kill(pid, 0)`; treats EPERM as alive (matches existing pattern).

### Kill switch

Set `KANGENTIC_BG_SHELL_WATCHER=0` to disable the watcher. The 5-min escape hatch remains as fallback.

## Resume reconciliation

When Kangentic restarts mid-session, the engine starts clean but the agent's Claude CLI may have living descendant processes. `reconcileBgShellsOnResume` enumerates the descendants at resume time, filters to shell-like basenames, and adopts them as anonymous bg shells. The watcher then prunes them as they exit naturally.

## Observability

### TaskCard hover tooltip

The activity icon on each task card is wrapped in a tooltip rendering `ActivityReasonTooltip`. Hover reveals an icon + inline label per reason kind: "Running Bash", "2 subagents active", "1 background shell", "Awaiting permission", etc.

### Activity Engine Debug Overlay (Developer settings tab)

A per-project setting under **Developer → Activity Engine Debug Overlay** enables a floating panel showing live engine state:
- Current activity + reason for each running session
- Raw counters (tools, subagents, bg shells)
- Ring buffer of last 10 transitions

Polls `getActivityStats(sessionId)` every 2 seconds. Hidden by default — power users discover via Developer settings; bug reporters can enable + screenshot.

## Synthetic events

The engine itself emits synthetic events into the activity log via the `onSyntheticEvent` callback for two cases:

- **Watchdog Idle/Timeout:** when the 45s stale-thinking watchdog or the 5-min bg-shell escape hatch fires. Pushed BEFORE the matching `onActivityChange` so the log entry appears before the state change.
- **Natural-exit `BackgroundShellEnd`:** when the watcher infers a bg shell exited naturally. Detail is `IdleReason.NaturalExit` for `onNaturalExit` (anonymous) or the shell_id for `onShellPidExited` (Tier A).

## Test infrastructure

Three test tiers:

1. **Unit** (`tests/unit/activity-engine.test.ts`, `bg-shell-watcher.test.ts`, `process-tree.test.ts`, `bg-shell-resume.test.ts`): direct engine + watcher tests with mock probe.
2. **Property** (`tests/unit/activity-engine-property.test.ts`): fast-check generates random event sequences, asserts invariants (counters never negative, activity matches reason kind, dispose is idempotent, multi-session isolation).
3. **Replay** (`tests/unit/activity-engine-replay.test.ts`): drives sanitized real production `events.jsonl` files through the engine and pins expected end-state. Fixtures live at `tests/fixtures/replay/`. Sanitization helper at `tests/fixtures/replay/_sanitize.mjs`.
4. **E2E** (`tests/e2e/background-shell-idle.spec.ts`): real Electron + mock Claude CLI exercising the full pipeline with actual bg processes.

## Configuration

### `ActivityEngineOptions`

```ts
interface ActivityEngineOptions {
  bgShellEscapeHatchMs?: number;     // default 5 * 60_000
  staleThinkingTimeoutMs?: number;   // default 45_000
  idleStabilityWindowMs?: number;    // default 400
  now?: () => number;                // testability
}
```

Plumbed through `SessionManagerOptions.activityEngineOptions` for tests.

### Per-project setting

`developer.activityDebugOverlay: boolean` — enables the debug overlay for the current project. Default false.

### Environment variables

- `KANGENTIC_BG_SHELL_WATCHER=0` — disables the bg-shell process-tree watcher (fallback to escape hatch only).
- `SKIP_PROCESS_TREE_PROBE=1` — skips real-OS probe smoke tests in CI environments without `ps`/`pwsh`.

## History

The current design (v2) replaced a v1 three-guard state machine that had grown to 557 lines with overlapping concerns: Guard 1 (suppressSubagentWakeDuringPermission), Guard 2 (deferStopUntilSubagentFinishes), Guard 3 (deferStopUntilBackgroundShellsFinish), composite hand-off bookkeeping, a 45s stale-thinking watchdog, a 10-min Guard 3 escape hatch, and a `pendingPermissions` counter with depth-≥2 freeze logic.

The v2 single-predicate engine + process-tree watcher reduced this to ~600 lines total across `engine/activity-engine.ts` + `background-shell/watcher.ts` + `background-shell/process-tree.ts`, with a near-100% empirical hit rate on the natural-exit cases that motivated the rewrite.
