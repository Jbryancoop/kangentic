## What's New

- **Relocate a project.** Move a project to a new directory without losing its board, tasks, or history.
- **Smarter model picker.** The model picker auto-discovers newly released models and groups [1m] context variants and dated snapshots in the dropdown.
- **Customizable hotkeys.** A new Hotkeys settings panel, backed by a central keybinding registry, lets you see and customize keyboard shortcuts.
- **Maximize task detail and terminal.** Maximize/restore controls and keyboard shortcuts for the task detail view and command terminal.
- **Resizable task detail split.** Drag the divider between the terminal and the right-hand panel in task detail to resize the split.
- **Unified toolbar.** The board and backlog now share a single toolbar with shared search and filter.

## Bug Fixes

- Plan-to-execute handoff now respawns the agent correctly when the permission mode changes.
- Cleared a stuck permission state that could linger after approving a subagent's tool call.
- More accurate background-shell activity tracking, including timed-out auto-backgrounded Bash and watcher-confirmed live shells held past the grace window.
- The worktree is now recreated on a Done round-trip past an empty husk.
- The filter popover stays anchored when you apply a filter, with a clearer pill hover affordance.
