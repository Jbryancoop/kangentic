## What's New

### Four new agent adapters

- **OpenCode** (sst) - hook-based activity stream via plugin, MCP server wiring via `OPENCODE_CONFIG_CONTENT`, Plan/Build permission modes mapped to OpenCode's `--agent` flag, auth detection via `~/.local/share/opencode/auth.json`, and TUI transcript cleanup for cross-agent handoff.
- **Qwen Code** (Alibaba) - caller-owned session IDs via `--session-id`, auto-pre-populated folder trust for spawned worktrees, MCP server wiring, transcript cleanup, and full E2E session-resume coverage.
- **Kimi Code** (Moonshot AI) - full wire-protocol v1.9 telemetry (context %, token counts, tool events) via `~/.kimi/sessions/<hash>/<id>/wire.jsonl`, caller-owned session IDs via `--session <uuid>`, `--continue` for resume-latest, subagent lifecycle tracking, PlanDisplay markdown rendering in the Activity log, and CLI auth detection.
- **Factory Droid** - native session JSONL parsing for the Transcript tab, Ink TUI scrollback cleanup for handoff, and a "no live telemetry" capability flag so the UI sets accurate expectations for Droid's PTY-only model.

### Embedded browser pane

A sandboxed Chromium pane lives inside the task dialog. Point it at any URL, draw annotations, pick DOM elements, and submit the rendered frame plus context to the active agent as a multi-modal prompt, all without leaving the task. Includes a clear-data action, a settings tab, and a shared partition constant.

### Global search palette (Ctrl+Shift+F)

One overlay searches across active tasks, archived tasks, backlog items, session events from `events.jsonl`, and registered projects, with per-kind grouped results and keyboard navigation. Selecting a session-event hit scrolls the Activity Log to the matched event with a brief highlight; backlog hits switch to the backlog view and open the item. Also exposed to agents as the `kangentic_search_everything` MCP tool.

### Per-column and per-task model & effort overrides

Pin Plan to opus, Execute to gpt-5-codex, Review to a cheaper model. Kangentic live-applies model and effort changes via the agent's `/model` and `/effort` slashes when sessions cross a column boundary, with no respawn needed for adapters that support live swap. Per-task overrides via the new context-bar popover take precedence over the column override; both fall through to the agent default when unset.

### Auto-name tasks from the prompt

Task titles can be generated from the description via a new Sparkles button next to the title field, plus a 30-second toast that suggests a rename for placeholder-titled tasks. Implemented per-adapter (Claude, Codex, Gemini, Qwen, Kimi, OpenCode, Cursor, Droid, Copilot) using each agent's plain-text headless mode. Configurable rate limit and a "don't ask again" persistence key.

### Activity engine rewrite

The 3-guard state machine was replaced with a single-predicate `ActivityEngine` with declarative watchdogs and a process-tree-based background-shell watcher. Tier A (PID-aware) plus Tier B (count heuristic) detection of background-shell exits, with cycle-shared OS process queries to fix the 10-session scaling cliff. New IPC paths (`session:notifyUserInterrupt`, `session:getActivityReason`, `session:getActivityStats`) feed a Developer settings tab with a live debug overlay (Ctrl+Shift+D). Fast Ctrl+C recovery via a 3-second user-interrupt coordinator, where the previous floor was 5 minutes through the stuck-pending-tools watchdog.

### Other notable additions

- Per-tool stats breakdown captured per session with cost, tokens, durations, and interrupted counts.
- Rate-limit pill in the context bar synced across all active agents, generalized for adapters that report multiple limit windows.
- Claude effort level shown next to model name in the context bar.
- Optimistic delete for tasks with snap-back if the IPC fails.
- Last active task tab remembered per project.
- Analytics events tagged with the agent name and resolved model so launches/exits/completions are attributable.
- Task prompts and handoff context wrapped in a structured XML envelope (`<task><title>...</title><description>...</description></task>`) with a new `{{task_xml}}` template variable, replacing ad-hoc string concatenation.
- MCP routing by prompt project cues so cross-project tool calls land on the right project automatically.
- MCP `create_task` now auto-attaches files referenced by absolute path in the prompt.

## Bug Fixes

- PTY writes are now serialized through a per-session FIFO queue, fixing paste truncation under load.
- Background Bash (`run_in_background:true`) keeps the task active until the process tree confirms exit, instead of going idle on the agent's PostToolUse.
- Stuck "thinking" state after a natural background-shell exit now releases promptly.
- Stale `task.session_id` after idle-timeout suspend is reconciled on next sync.
- Stale per-session activity entries are evicted on `syncSessions`, fixing ghost spinners after task moves.
- Fresh-spawn `auto_command` bursts no longer fire a leading Ctrl+C that mangled the first prompt on Windows ConPTY.
- Sidebar activity indicators are hidden when the project rail is collapsed.
- Command Terminal no longer freezes when opened from the Backlog view.
- `removeWithRetry` budget extended for Windows handle release (worktree cleanup races).
- Qwen now launches the interactive TUI when given a prompt (was non-interactive).
- Kimi MCP config is written to disk on Windows to avoid invalid JSON from PowerShell quoting.
- OpenCode exit sequence reduced to Ctrl+C only after empirical verification (`/exit` and `/quit` aren't recognized).
- Codex 0.128 no longer has stale `.codex/hooks.json` written to it.
- Multi-line task descriptions render with `<description>` tags on their own lines so the agent sees clean structure.
- Empty prompt sections are omitted from the XML envelope.

## Removed

- The always-visible board search bar and its in-place row filter. Task search is now part of the global search palette (Ctrl+Shift+F). The label/priority filter button moves to a small floating control at the top right of the board.
