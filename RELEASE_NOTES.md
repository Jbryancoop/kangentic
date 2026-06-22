## What's New

- **Modeless task-detail windows.** Drag, resize, snap, and tile task windows across the app shell, and click outside or middle-click to close them.
- **Universal keyboard and mouse bindings.** A unified binding set across the app, including middle-click to close task windows.
- **Saved diff view preference.** The split/inline git diff view is now a global preference, labeled "Git Diff View".
- **Rate-limit reset marker.** Rate-limit bars now show a session reset time indicator.
- **Activity-aware pause/resume.** The pause/resume button reflects the session's live activity state.
- **Configurable worktree setup.** Worktree creation runs your init script, with configurable node_modules linking plus progress and cancel support.
- **Background PR refresh.** Pull request state refreshes in the background on project open and on a timer, with a clearer clickable state badge.
- **CI-driven test gate.** The Tests column opens a PR and the Ship It column merges it once CI is green.

## Bug Fixes

- Fixed false idle and false thinking activity states during live streaming, and recovered stale counters after an aborted or errored turn.
- Spawned agents now resume reliably; a leaked CLAUDE_CODE_* environment no longer breaks resume.
- The move-to-Done warning now fires only when the move would actually destroy work.
- Task-detail and project window layouts now persist across restarts and project switches.
- Kimi session capture is scoped to the spawn's working directory, preventing stray-session mixups.
- More reliable PR linking: PRs created mid-session auto-link, fork PR state is preserved, and code-review tasks and fresh worktrees no longer mislink to the wrong PR.
- Stores stay pinned across Fast Refresh, and preview no longer seeds ghost columns.
