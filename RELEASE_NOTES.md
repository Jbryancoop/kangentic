## What's New

- **Changes panel for branch review.** Review your branch diff in-app with a branch header, a segmented diff-scope control, and a resizable auto-fit file tree. Toggle between tree and flat views, sort files, collapse all, mark individual files as "viewed", and navigate across files from the keyboard. Git metadata refreshes automatically as you work.
- **Command terminals are now full windows.** Drag, resize, snap, and tile command terminals on a dedicated, globally-persisted layer, and run several tiled side by side.

## Bug Fixes

- Switching projects no longer replays window entrance animations or flashes the terminal panel.
- The model and effort popover no longer gets clipped by the footer.
- Team board-config changes in `kangentic.json` now hot-reload on the authoring machine.
- The command terminal keeps focus when you maximize or restore it.
- Fixed incorrect PR linking when a worktree's merge commit matched another pull request.
