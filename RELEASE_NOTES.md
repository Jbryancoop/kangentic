## What's New

- **Cross-project agent monitor** - one view of every running agent across all your projects, with a live output peek on each card and a shared task detail you can open without leaving it.
- **Board profiles** - per-column agent, model, and effort presets that a task picks up as it moves across the board.
- **First-launch walkthrough** - a five-step guided tour that introduces the board, columns, and agents on a fresh install.
- **Rewritten description editor** - a source-first markdown editor with compact attachment chips, plus a paste-as-plain-text path.
- **Command Terminals in the sidebar** - live Command Terminals are surfaced per project and can be named, and the sidebar footer gains a split button and a background menu on the project list.
- **Release notes before you update** - the updater now shows what changed in a modal before it restarts to apply an update.
- **Column tools over MCP** - agents can create and delete board columns, and column removal can be staged from board settings.
- **Send-to-session steering** - push a message into a running agent session over MCP, with a durable log of everything that was sent.
- **Task-numbered worktrees** - worktree directories are named after the task number, so they are recognizable on disk and stay well under Windows path limits.
- **Preview exit notifications** - the session that launched a preview is told when that preview exits.
- **Agent Override editing** - an edit pencil on the Agent Override branch of the task dialog, and the task run mode now survives a save.
- Terminal OSC 8 links open in your default browser with no confirmation dialog, and the activity glyphs across the board, sidebar, and cards now come from the shared branding set.
- **Faster board and terminal** - board hot paths are cut and cards stay live during a drag, terminal initialization is deferred a frame, monitor snapshot pushes are gated, and task transcripts are revalidated by file stat before being re-parsed.

## Bug Fixes

- The context bar no longer presents configured values as if they were live agent telemetry, and its usage coloring matches the mobile threshold ramp.
- Menu popovers portal to the document body, so they escape clipping ancestors instead of being cut off.
- A Monitor wait is tracked as a background holder, so a task waiting on one no longer reads as idle.
- Worktree creation resolves the base branch against real refs, guards the checkout where it happens, and only checks for commits once there is branch work to do.
- Terminal repaints are steadier: no-op resizes are skipped, the settle arms on rows-only resizes, a starting TUI's first frame gets a bounded settle wait, and pre-sample held bytes are dropped instead of painting over a replay.
- The Command Terminal remounts its xterm host on a branch switch instead of swapping the session id underneath it.
- A board card held mid-move now lands at its destination, and a To Do restore resets correctly.
- The conversation view only auto-follows new messages when you are already scrolled to the bottom.
- PR badges resolve their state at link time, and a PR URL merely cited in a task description is no longer linked.
- The onboarding walkthrough is gated on the install rather than replaying for each project.
- Failure toasts no longer leak IPC plumbing into their text, and the spawn-blocked notice names the project it happened in.
- Closing an overlay during its entrance animation no longer leaves it stuck open.
- The import dialog's search box matches against the fields a row actually displays.
- Dictation's live chip reflects a real capture signal.
