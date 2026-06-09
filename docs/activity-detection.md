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
   │                   │ │ - stale-think  (180s)   │ │            │ │            │
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
| `src/main/agent/event-bridge.js` | Generic hook-to-JSONL bridge; decodes typed `<kind>:<base64(JSON)>` directives (extractTool, extractDetail, setTypeWhen, ...) built by `src/main/agent/shared/directive-builders.ts` |
| `src/main/agent/adapters/claude/hook-manager.ts` | Claude Code hook configuration |
| `src/shared/types.ts` | `ActivityState`, `ActivityReason`, `EventType`, `SessionEvent.toolId` |

## ActivityState

```ts
type ActivityState = 'thinking' | 'idle' | 'permission';
```

Three top-level states:

- **`thinking`** - agent is working. Spinner shown on task card. Notifications NOT fired.
- **`idle`** - agent is truly done. Notification fires. Auto-focus / auto-suspend can act.
- **`permission`** - agent paused awaiting user approval. Distinct from `idle` so the UI can render a different affordance (lock icon vs idle dot).

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

Priority ladder: `permission > tool > subagent > background-shell > turn-active > idle`. Anchored to `state.activity` for consistency - when forced paths (Interrupted, forceIdle) commit a transition that diverges from the bare predicate (e.g. clearing all counters on Esc), the reason follows the committed state.

## EventType reference

The 22 `EventType` values written to `events.jsonl` by `event-bridge.js`, defined in `src/shared/types.ts`. The activity column shows how each event maps to `ActivityState` via the `EventTypeActivity` table, also in `src/shared/types.ts`.

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
| `IdleHint` | `idle_hint` | conditional idle | "Waiting for your input" notification, classified at the source. Ends the turn only when no other holder remains; otherwise log-only (see "Idle hints" below) |
| `Compact` | `compact` | `thinking` | Context-window compaction in progress |
| `TeammateIdle` | `teammate_idle` | log-only | Cross-agent teammate signaled idle |
| `TaskCompleted` | `task_completed` | log-only | Agent declared the task finished |
| `ConfigChange` | `config_change` | log-only | Agent settings/model changed mid-session |
| `WorktreeCreate` | `worktree_create` | `thinking` | Agent created a git worktree |
| `WorktreeRemove` | `worktree_remove` | log-only | Agent removed a git worktree |
| `BackgroundShellStart` | `background_shell_start` | `thinking` | `Bash(run_in_background: true)` launched, or a foreground Bash auto-backgrounded on timeout (its `tool_response` carries a shell id) |
| `BackgroundShellEnd` | `background_shell_end` | log-only | `KillBash` invoked; decrements active-shells counter |
| `ModelStart` | `model_start` | log-only | LLM API call beginning (Qwen/Gemini per-call telemetry) |
| `ModelEnd` | `model_end` | log-only | LLM API call returned |
| `ToolSelectionStart` | `tool_selection_start` | log-only | Agent is choosing the next tool |

"log-only" means the event is recorded for the activity feed and may update internal counters, but does not on its own change `ActivityState`. State changes only occur through the predicate (see below) or via direct `Idle` / `Interrupted` events.

### Idle hints (waiting-for-input notifications)

Some turns end without a `Stop`/`Idle` hook ever reaching the main agent - most commonly when the whole turn was delegated to a subagent. When the subagent stops, `subagentDepth → 0` but `turnActive` is still `true`, and the only thing that arrives is a `Notification` ("Claude is waiting for your input"). Because `Notification` is log-only, nothing clears `turnActive`, and the session stays `thinking` until the 180s stale-thinking watchdog fires - the user sees the spinner spin ~3 minutes after the agent is actually done.

`idle_hint` closes that gap. The classification happens **at the source, not in the engine**: the Claude adapter's `Notification` hook carries a generic `setTypeWhenDetailContains('waiting for your input', EventType.IdleHint)` directive (the only Claude-specific string), so `event-bridge.js` rewrites the matching notification's `type` to `idle_hint`. The match runs on the already-extracted `detail` text (empirically "Claude is waiting for your input"), so it does not depend on which payload field carried the message. The engine never string-matches notification text and never branches on agent name.

The engine treats `idle_hint` as **conditionally** turn-ending (`idleHintEndsTurn` in `predicate.ts`): it clears `turnActive` only when `turnActive && pendingToolCount === 0 && subagentDepth === 0 && bgShellCount === 0 && !permissionPending`. When the guard passes, the predicate flips to idle through the normal 400ms stability window (near-instant for the user). When it fails - tools, subagents, or background shells still outstanding, or a permission pending - `idle_hint` is a pure no-op, so a notification that fires mid-turn never short-circuits genuine work, and the 180s stale-thinking watchdog remains the ultimate backstop. `idle_hint` is in `LOG_ONLY_EVENTS`, so it never resets `lastSignalAt` (a failed guard leaves the genuine work's watchdog anchor untouched).

**Why the substring is deliberately narrow.** A scan of 221 real Claude sessions surfaced exactly four distinct notification texts: "Claude is waiting for your input" (794x), "Claude Code needs your approval for the plan" (109x), "Claude Code needs your attention" (43x), and "Claude needs your permission[ to use X]" (51x). Only the first fires for a pure turn-end whose `Stop` hook can be dropped. The other three each fire ~6s AFTER a `PermissionRequest` (tool permission, ExitPlanMode plan approval, or AskUserQuestion) has already driven the engine to the `permission` state, so they are correctly left log-only - reclassifying any of them would conflate `permission` with `idle`. The negative cases are pinned with the real strings in `tests/unit/event-bridge-remap.test.ts`.

Only the Claude adapter wires this today, because Claude is the only agent for which we have captured evidence (a real session) of both the notification text and the dropped-Stop failure mode (a turn fully delegated to a subagent). The engine path is generic: any adapter that classifies a notification into `idle_hint` gets the same behavior.

To extend it to another hook-based agent, capture a real session that exhibits the stall, read the notification's extracted `detail`, then add a `setTypeWhenDetailContains('<observed substring>', EventType.IdleHint)` directive (built via the typed builder in that adapter's hook-manager, never hand-authored) to that adapter's Notification hook. Do not guess the string. Current status of the other agents:

- **Gemini / Qwen Code** share the same hook shape (`AfterAgent` -> `idle` stop-equivalent, `Notification` -> `notification`), so they could be susceptible. But they wire no `SubagentStart`/`SubagentStop` hooks, so the subagent-delegation failure mode is not modeled, and we have no captured session to confirm their notification text. Wire only after capturing evidence.
- **Kimi** does not need this: its wire protocol emits an explicit `TurnEnd -> Idle`, and none of its `Notification`-mapped messages mean "waiting for input."
- **Codex / Copilot / OpenCode** wire no Notification hook, so the pattern cannot apply.

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

Set on any "thinking-initiating" event (`ToolStart`, `Prompt`, `SubagentStart`, `Compact`, `WorktreeCreate`, `BackgroundShellStart`). Cleared by `Idle`, `Interrupted`. Also re-armed when a permission pause resolves (see [Permission flag](#permission-flag)). Persists across the silent gaps between tool calls so the spinner doesn't flicker.

### Subagent depth

Tracks nested subagent invocations. SubagentStop decrements (clamped to 0). When the main agent fires Stop while a subagent is still running, `turnActive = false` but `subagentDepth > 0` keeps the predicate true. Idle emits when depth hits 0 (and no other counter holds).

### Background-shell tracking (Set + anonymous fallback)

Two storage modes:

- **`activeBackgroundShellIds: Set<string>`** - when the hook directive extracted a `shell_id` (today: KillBash events), the engine tracks shells by id. `markBackgroundShellEnded(sessionId, shellId)` removes the matching id.
- **`anonymousBackgroundShellCount: number`** - fallback for shells whose start-event lacked a shell_id (the common case today; production hooks emit the command string as detail, not a shell_id). The watcher's count-based heuristic decrements this.

The predicate uses `set.size + anonymousCount > 0` so both modes coexist.

### Permission flag

Set when an `Idle` event fires with `detail: 'permission'`. Cleared by:
- `Prompt` (user typed something new)
- `Interrupted` (Esc)
- `SubagentStart` (main agent spawning a child)
- `Idle` with non-permission detail (agent ended turn)
- `ToolStart`/`ToolEnd` at `subagentDepth === 0` (main agent activity)

Subagent-tool events at depth>0 do NOT clear permission (the permission belonged to the main agent which is still paused).

**Resume restores `turnActive`.** A permission pause begins with `Idle{detail:'permission'}`, which clears `turnActive` (Idle is a turn-ending event). When the pause resolves, the wake is typically a depth-0 `ToolEnd` (e.g. the `AskUserQuestion` / `ExitPlanMode` tool ending after the user answers/approves) - a LOG_ONLY event that clears `permissionPending` but does not re-arm `turnActive`. The resumed turn emits no fresh `Prompt`/`ToolStart` hook, so without intervention the predicate would see no holder and drop to **idle** until the PTY force-thinking net catches up seconds later. To avoid that, `processEvent` restores `turnActive = true` whenever `permissionPending` transitions `true -> false` on a non-turn-ending event (i.e. not `Idle`/`Interrupted`, which are genuine end-of-turn). This is classified by the generic permission-clear shape, not by tool or agent name, so it covers every permission-class pause. Pinned by the `session-006`/`session-007` replay fixtures.

### Tool tracking (stack with correlation IDs + LIFO-by-name fallback)

`pendingToolStack: Array<{ id?: string; name: string }>` records in-flight tools in start order. `currentTool` always reflects the top of the stack and is exposed via `ActivityReason` for the TaskCard hover tooltip ("Running Bash").

ToolEnd matching priority:
1. **By correlation id** - when both events carry `event.toolId` (Claude's `tool_use_id` extracted via the `extractToolId` directives, top-level and nested), exact removal regardless of stack position. Solves the duplicate-name and out-of-order cases.
2. **LIFO-by-name** - fallback when an event has no toolId or the id didn't match (drift recovery from hook drop or version skew).
3. **Raw pop** - fallback for `Interrupted` (no tool name carried).

Hard reset on `pendingToolCount === 0`: the stack is cleared even if name desync left dangling entries. Idle events also clear the stack (see "Idle clamp" below).

Adapters opt into ID correlation by adding `extractToolId(['<field>'])` and `extractToolId(['<field>'], { nested: '<parent>' })` directives to their hook config. Adapters without correlation IDs leave `event.toolId` undefined and the engine falls back to LIFO-by-name automatically - no breaking change.

### Idle clamp

When a non-permission `Idle` event arrives, the engine forcibly clears `pendingToolCount`, the stack, and `currentTool`. The agent's turn is done; any unmatched ToolStart events are stale by definition (PostToolUse hook dropped, tool force-killed, etc.).

Permission idles bypass the clamp because the agent paused awaiting approval and may resume the same tool.

## Stability window (400ms)

When the predicate flips from `thinking` to `idle` due to a Stop event or a counter clearing, the engine waits 400ms before emitting the transition. If a thinking signal arrives during the window, the pending idle is cancelled. Prevents `idle → thinking → idle` flicker from out-of-order hook arrivals.

Bypassed by:
- `Interrupted` (Esc - instant, no flicker concern)
- `forceIdle` (PTY-driven; already debounced 3s in PtyActivityTracker)
- Stale-thinking watchdog (already 180s)

Configurable via `ActivityEngineOptions.idleStabilityWindowMs`. Tests set this to 0 for deterministic timing.

## Three safety nets (the watchdog table)

The predicate handles the common case. Three timer-driven safety nets in `engine/watchdog.ts` catch hook-loss / orphan situations. Each is a `WatchdogHold` describing a state shape, threshold, reset action, and audit-log label. `findActiveWatchdogHold(state, holds)` picks the matching one each cycle.

### 1. Stale-thinking watchdog (180s)

Held by `turnActive` alone (no tools, no subagent, no bg shells) for 180 seconds. The matching Idle/Stop hook never arrived. Emits synthetic `Idle/Timeout`, clears `turnActive`. Bypasses the stability window (the 180s already debounced any flicker).

### 2. Bg-shell sole-holder grace (30s)

Once the turn is over and a background shell is the ONLY holder of `thinking`, the engine flips to idle after a short grace (`timer:bg-shell-hatch`). Force-clears the bg-shell counters and emits idle through the stability window.

Crucially, the deadline is anchored to when bg shells became the sole holder (`bgShellHoldSince`), NOT to `lastSignalAt`. A `Bash(run_in_background:true)` that exits naturally fires no `BackgroundShellEnd` hook (agents almost never end their shells - see the watcher section), so an orphan can linger in the counter. An earlier design had the watcher refresh `lastSignalAt` every 2s while it saw any shell-like descendant, to keep a then-5-min hatch warm; for an orphan whose exit the watcher could not attribute, that pulse pushed the deadline out forever and pinned the session `active` indefinitely (empirically confirmed on tasks #175/#180). Anchoring to the hold-start makes the deadline immovable by any keep-alive.

Once the turn is over the agent is idle (waiting for input), so a short grace is correct whether or not detached bg work is still running. The watcher's attributed drain (`onNaturalExit`, ~4s) still wins for clean exits; the grace is the backstop for the unattributable case.

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

### Identity tracking and unattributable ends

A backgrounded Bash is tracked by id where possible. `PreToolUse` fires `background_shell_start` before Claude has assigned a shell id, so it counts anonymously (detail falls through to the command string). `PostToolUse` then re-emits `background_shell_start` carrying the assigned id from `tool_response` (field `shellId`, with `shell_id` / `backgroundTaskId` / `bash_id` as version fallbacks). The engine treats that as a **promotion**: it swaps one anonymous slot for a named slot keyed by the id, keeping the total count constant. A single backgrounded Bash is therefore tracked once, by id - not double-counted.

The PostToolUse remap keys on the **extracted shell-id detail** (`setTypeWhenDetailMatches('^[\w-]{1,64}$', ...)`, the id-shape regex sibling of `setTypeWhenDetailContains`), not on `tool_input.run_in_background`. This covers a second, distinct launch path: a **foreground** Bash that exceeds Claude Code's 10-minute ceiling is auto-promoted to a background shell and returns control, **without** ever carrying `run_in_background: true` (#187). Its `PreToolUse` was therefore a plain `ToolStart` (not a `background_shell_start`), so `pendingToolCount` was incremented; but its `PostToolUse` `tool_response` still carries the assigned shell id (empirically `bjosycg6w` in session `3fc0dca7`, `events.jsonl` line 20). Keying on the shell-id detail promotes it correctly, and the engine's `BackgroundShellStart` handler **closes the in-flight pending tool** matched by `tool_use_id` (the tool moved to the background rather than ending) as it opens the named shell - otherwise the orphaned pending tool would stick the session `thinking` until the 5-min watchdog. The inverse risk - a normal foreground Bash mistaken for a backgrounded shell - is structurally avoided: this `PostToolUse` `extractDetail` sources only the `tool_response` shell-id fields, so a plain completion has no detail and never remaps, and a failed Bash flows through `PostToolUseFailure` (a separate directive set). Such a named shell is then held active by the watcher each cycle it sees the bash alive and reclaimed by the 30s sole-holder grace once it exits - the exact "10-min E2E" case the grace was built for.

`background_shell_end` from `KillBash` carries the id and drains the matching named slot; without an id it drains the anonymous count. An **unattributable** end - one that matches no named slot AND has no anonymous slot to drain - is treated as a no-op that bumps the `unmatchedBgShellEnd` compensation counter, rather than draining an arbitrary named shell. This bounds the blast radius of any input-layer mistake: a spurious end (for example, a tool-blind remap that mislabels a foreground tool completion) can never silently decrement a real, id-tracked shell and trigger a premature idle. Remaps are tool-scoped at the source via the typed `setTypeWhen` builder (`whenTool`), so a foreground Agent/Task completion is never mapped to a bg-shell event in the first place.

### Lazy polling

The watcher only polls when at least one session has `getActiveShellCount() > 0`. Idle Kangentic = zero polls.

### Cross-platform

- **Windows:** `powershell.exe -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Csv -NoTypeInformation"`. Walks the parent map in JS. Times out at 1.5s.
- **POSIX:** `ps -A -o pid=,ppid=,comm=`. Walks the parent map in JS. Times out at 1.5s.
- **Liveness probe:** `process.kill(pid, 0)`; treats EPERM as alive (matches existing pattern).

### Kill switch

Set `KANGENTIC_BG_SHELL_WATCHER=0` to disable the watcher. The 30s sole-holder grace remains as fallback.

## Resume reconciliation

When Kangentic restarts mid-session, the engine starts clean but the agent's Claude CLI may have living descendant processes. `reconcileBgShellsOnResume` enumerates the descendants at resume time, filters to shell-like basenames, and adopts them as anonymous bg shells. The watcher then prunes them as they exit naturally.

## Observability

### TaskCard hover tooltip

The activity icon on each task card is wrapped in a tooltip rendering `ActivityReasonTooltip`. Hover reveals an icon + inline label per reason kind: "Running Bash", "2 subagents active", "1 background shell", "Awaiting permission", etc.

### Activity Engine Debug Overlay (Developer settings tab)

A per-project setting under **Developer → Activity Engine Debug Overlay** enables a floating panel showing live engine state:
- Current activity + reason for each running session
- Raw counters (tools, subagents, bg shells)
- **Compensation counters** (`staleThinking`, `bgShellHatch`, `stuckPendingTools`, `forceThinking`, `forceIdle`, `unmatchedBgShellEnd`) - monotonic tallies of silent recovery events. In a clean session all six read 0; any non-zero value flags a watchdog / forced transition / unattributable event that did not visibly flip the activity pill.
- Ring buffer of last 10 transitions
- **PTY chunk timeline** - bucketed PTY arrivals over the last ~120 seconds (100ms buckets) from `ActivityStatsSnapshot.recentPtyChunks`, rendered by `ActivityTimeline` alongside the watchdog deadline (`lastSignalAt + thresholdMs`). Empty in production builds where the trace recorder is dead-code-eliminated.

Polls `getActivityStats(sessionId)` every 2 seconds. Hidden by default - power users discover via Developer settings; bug reporters can enable + screenshot.

### Trace capture and replay (dev only)

`src/main/pty/activity/trace-recorder.ts` is a dev-only passive recorder that writes two per-session JSONL files to the session directory:

- `pty-chunks.jsonl` - one `{ts, length}` line per PTY chunk arrival (no content, just timestamps and sizes)
- `status-deltas.jsonl` - one `{ts, ...usage}` line per `status.json` update

Both files rotate at `TRACE_FILE_MAX_BYTES` (10 MB) with one rotated copy kept (`.1` suffix), capping per-file disk use at ~20 MB. The recorder is always-on in dev so the data is there when a flip-flop or stuck-thinking report comes in after the fact; production builds eliminate the entire module via `__KANGENTIC_DEV__` esbuild dead-code elimination.

The dev-only `kangentic_devtools_capture_trace` MCP tool reads these alongside `events.jsonl` to produce a portable replay fixture. The `activity-engine-trace-replay.test.ts` suite drives captured traces back through the engine to pin expected end-state.

### Invariant property testing

`tests/unit/activity-engine-property.test.ts` uses fast-check to generate random event sequences and assert invariants the engine must preserve:
- Counters never go negative
- `activity` always matches `reason.kind` per the priority ladder
- `dispose` is idempotent
- Multiple sessions stay isolated (event delivery to session A does not perturb session B)

The fuzz tests complement the deterministic replay fixtures by exercising input shapes the recorded sessions never produced.

## Synthetic events

The engine itself emits synthetic events into the activity log via the `onSyntheticEvent` callback for two cases:

- **Watchdog Idle/Timeout:** when the 180s stale-thinking watchdog, the 30s bg-shell sole-holder grace, or the 5-min stuck-pending-tools hatch fires. Pushed BEFORE the matching `onActivityChange` so the log entry appears before the state change.
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
  bgShellEscapeHatchMs?: number;     // default 5 * 60_000 (stuck-pending-tools hatch)
  bgShellOnlyGraceMs?: number;       // default 30_000 (bg-shell sole-holder grace)
  staleThinkingTimeoutMs?: number;   // default 180_000
  idleStabilityWindowMs?: number;    // default 400
  now?: () => number;                // testability
}
```

Plumbed through `SessionManagerOptions.activityEngineOptions` for tests.

### Per-project setting

`developer.activityDebugOverlay: boolean` - enables the debug overlay for the current project. Default false.

### Environment variables

- `KANGENTIC_BG_SHELL_WATCHER=0` - disables the bg-shell process-tree watcher (fallback to the sole-holder grace only).
- `SKIP_PROCESS_TREE_PROBE=1` - skips real-OS probe smoke tests in CI environments without `ps`/`pwsh`.

## History

The current design (v2) replaced a v1 three-guard state machine that had grown to 557 lines with overlapping concerns: Guard 1 (suppressSubagentWakeDuringPermission), Guard 2 (deferStopUntilSubagentFinishes), Guard 3 (deferStopUntilBackgroundShellsFinish), composite hand-off bookkeeping, a 45s stale-thinking watchdog, a 10-min Guard 3 escape hatch, and a `pendingPermissions` counter with depth-≥2 freeze logic.

The v2 single-predicate engine + process-tree watcher reduced this to ~600 lines total across `engine/activity-engine.ts` + `background-shell/watcher.ts` + `background-shell/process-tree.ts`, with a near-100% empirical hit rate on the natural-exit cases that motivated the rewrite.
