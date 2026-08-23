## What's New

- **Every concurrent agent gets its own browser.** Each agent now drives a private offscreen browser lane instead of contending for one shared guest, CDP drives are serialized per guest so two agents can no longer interleave mid-command, and every drive records its caller so contention is visible when it happens. A lane is torn down with the session that owns it, and an agent's browser now survives the task window being closed.
- **Dev-server ports are leased per task.** A global registry hands out a dev-server port that nothing else is using, so two agents starting servers at the same moment cannot pick the same number, and a task's Browser pane can default to its own lease. `kangentic_check_dev_ports` reports what a task holds and what is actually listening on the machine, and the default lease range has been moved clear of every common framework default. In prompt templates, `{{port}}` resolves to the task's own reserved port.
- **A browser pane that hits a build error says so.** Instead of returning a screenshot of a dev server's error overlay, the agent gets the build error itself, named file and all, with a note that the break may belong to another agent sharing the worktree.
- **An agent's focus move is shown rather than hidden.** The terminal dims and the pane is marked while an agent drives the browser, so keystrokes never land somewhere surprising. OAuth popups are allowed through.
- **Find tasks by ticket number.** Search `#` followed by a task's ticket number to jump straight to it.
- **Dictation targets whatever text field has focus**, not just the agent terminal.
- **Auto-update now works on Linux.**
- **Clearer board vocabulary.** The Tests and Ship It columns are now Testing and Merge, and auto-command is labelled as a message to the agent.
- **Spawn failures are no longer silent.** Starting a task on a branch that is already checked out is now rejected with a reason instead of failing quietly.

## Bug Fixes

- A finished or archived task no longer tries to resume a conversation, and Kangentic will not resume one the agent never wrote. Restoring a task out of Done reads as in progress rather than Paused, and unarchives the task.
- A very large transcript can no longer exhaust the main process's memory: reads are bounded, and each adapter's entry ids are now absolute and session-scoped.
- The release workflow publishes exactly one release per tag, so a release can no longer go out missing a platform's builds.
- Android push notifications no longer double-render alerts, and the idle signal is settle-debounced so it stops firing early.
- A failure inside the dev-port ledger can no longer take a task operation down with it, and a browser lane can no longer block the app from shutting down.
- Terminal mouse reports are paced as individual PTY writes, so scrolling behaves under fast input.
- An agent whose CLI exited under a still-live shell is now retired instead of lingering as though it were running.
