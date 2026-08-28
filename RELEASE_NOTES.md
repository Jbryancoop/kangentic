## What's New

- **Each task's agent browser gets its own cookie jar, but you sign in once.** A project's identity-provider login (Google, Okta, and the like) is shared across that project's tasks, while each task's localhost session stays isolated, so one task's dev-server session can never be mistaken for another's.
- **A task never starts from a stale base branch.** Kangentic checks that the base is current before cutting the worktree, and the Changes panel offers "Update from base" when a task's branch has fallen behind.
- **Pop out a single file's diff.** Double-click a file row in Changes to open that one diff in its own window (up to eight at a time), so you can read one file while the panel stays on another.
- **Filter the Agent Monitor by project.** The toolbar's scope filter now takes a multi-project selection instead of one project at a time.
- **Agent task tools answer more up front.** The MCP task tools now return four things an agent used to have to discover by probing, so it spends fewer calls working out what it is looking at.
- **Dev builds say so.** An `npm start` window names itself "Kangentic (dev)" in the wordmark and the taskbar, and warns loudly when another instance already holds the single-instance lock instead of silently handing you the wrong build.

## Bug Fixes

- Terminal rows no longer drift a column per emoji: every terminal parser now measures with the Unicode 11 width table.
- Fast mouse scrolling and motion are paced into bounded lanes, so a burst can no longer flood the PTY or leave a stale report queued ahead of the current one.
- A terminal reattaching after a resize repaints from the parsed grid, so rows no longer come back interleaved.
- Pasting into an unfocused session now settles on that session's real output instead of the first thing it sees.
- Closing a browser pane mid-operation no longer races the abort and timeout paths, and a resumed session carries its project through correctly.
