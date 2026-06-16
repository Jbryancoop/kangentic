## What's New

- **Cross-agent transcript views.** `get_transcript` now works across every agent with structured output -- responses/result views, tailing, search, and size caps -- via a shared transcript-parsing capability.
- **One-step project relocation.** Re-point a project at a new folder in a single action: Kangentic moves the folder, quiesces its own running sessions, and migrates per-agent project data for all agents.
- **Roomier task dialogs.** The New Task and Task Detail dialogs are larger, support maximize/restore, and have cleaner close controls.
- **Unified overlay motion.** In-app overlays share one consistent animation, with double-click-to-maximize on dialog headers.
- **Smarter Changes panel.** The diff view centers the first change on open and restores your scroll position when you revisit it.
- **Quieter first move out of Done.** Moving a task out of Done for the first time no longer re-fires the column's auto-command.

## Bug Fixes

- Fixed several false "idle" states in the activity indicator: during parallel and nested subagents, while a subagent or a long-running foreground tool or test shell is still working, and for PID-less background shells.
- Suppressed a false "Session crashed" notification when a session is deliberately torn down.
- A clean quit now releases watcher and PTY handles and exits 0.
- Guarded the New Task and Task Detail dialogs against accidental double-submit.
- Agents now restart only on a model change, not on a permission-mode change.
- Stopped labels from being dropped on tasks with very large descriptions.
- Task and session actions now route by the project you are interacting with.
- The Move-to-Done dialog names the real branch, right-sizes its data-loss warnings, and refreshes remote refs before warning about unpushed commits.
- MCP-created tasks now appear on the board without needing a drag.
- Fixed worktree cleanup stalling the git queue on a Move-to-Done.
- Fixed a drop-to-Done flash and skipped needless session respawns on no-op column config saves.
