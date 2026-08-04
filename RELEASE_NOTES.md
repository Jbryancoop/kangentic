## What's New

- **Release notes on first launch** - after an update installs, Kangentic shows what changed the first time you launch the new version, in a What's New dialog with its own icon and title.

## Bug Fixes

- Resuming after `/clear` now follows the conversation fork, so the session picks up the live thread instead of the abandoned one.
- Agent Monitor cards now show "-" when a session's context usage or model is genuinely unknown, instead of printing a confident 0% or falling back to the agent's name.
- Fullscreen terminal sessions replay their parsed grid, so reopening a task shows the current frame instead of a stale one, and mouse encoding is re-asserted on that replay so clicking and scrolling keep working.
- On Windows, Claude's full-repaint flag is now on by default, fixing history entries that could disappear when scrolling back through a fullscreen session.
