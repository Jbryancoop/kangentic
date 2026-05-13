## What's New

### Per-task agent, model, and effort overrides

Pre-spawn picker lets you choose a different agent, model, or effort level for a single task without changing the column or project default. Overrides are remembered per task and persist across resumes via a model cache. Falls through to the column override, then the project default, then the agent's built-in default.

### Chrome-style zoom in the embedded browser

Ctrl+Wheel, Ctrl +/-, and a toolbar pill all control browser pane zoom. Zoom level is preserved per task. Ctrl+Enter in the note input is now scoped, so it sends to the agent without stealing focus.

### Pasted screenshots auto-compressed

Screenshots pasted from the clipboard are downscaled and re-encoded to fit within Claude's API image budget, preventing oversize-image rejections.

### Unified MCP task search

`kangentic_search_tasks` now searches across the active board and the backlog in a single call, with the source surface returned for each match.

### Persistent lifetime usage stats

Lifetime usage stats now survive task and session deletion. The StatusBar period selector (Live/Today/Week/Month/All Time) keeps a complete history regardless of which tasks have been archived or removed.

### Activity engine: trace capture, replay, and overlay

The activity debugger gained a trace capture/replay pipeline, a timeline overlay (Ctrl+Shift+D), invariant fuzzing in the test suite, and a memoized grid layout. Background-shell detection now uses snapshot health for probe-failure signaling and preserves named bg shells across HMR.

### Devtools surface for agents

MCP devtools surface expanded with screenshots, console, mutations, React tree/recent renders, IPC log, latency telemetry, and a preview-inspection bridge. All dev-only, excluded from production builds.

### /test skill maintenance

`/test` now self-maintains its affected-test selection rather than relying on a manually curated list. `/code-review` auto-fixes findings by default.

## Bug Fixes

- Done drop-zone animation restored and several dev-mode HMR parity gaps closed
- PreSpawnContextBar stays pinned to the bottom during pre-spawn instead of jumping
- Session reconcile heals stale `task.session_id` values that drift to "suspended"
- Task move no longer crashes when the DB closes mid-handler during shutdown
- Done confirm now fires when a worktree has unsaved work, preventing accidental loss
- Transient sessions show in the activity debugger overlay
- Renderer `syncSessions` is HMR-resilient against preload-renderer skew
- Phantom background-shell counters eliminated from activity watcher adoption
- Stale-thinking watchdog raised from 45s to 180s to avoid spurious idle flips
- Updater no longer crashes when `app-update.yml` is missing in dev builds
- OpenCode adapter only disables its activity plugin once installed
- Fixed fetch hang on task spawn and miscellaneous shutdown leaks
- CDP detach guarded against destroyed webContents on quit
- Activity-debug overlay always centers on first launch and on auto-spawn mount
