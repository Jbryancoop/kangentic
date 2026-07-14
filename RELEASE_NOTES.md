## What's New

- **Usage statistics dashboard** - a new project-level and app-wide view of token usage, cost, and session activity, with live and cumulative breakdowns.
- **Mobile companion bridge** - pair a mobile device over a secure relay transport to watch and drive your boards, backed by a typed protocol package.
- **Detachable panes** - pop the Stats, Changes, and Browser surfaces out into their own movable, resizable windows.
- **Refreshed branding** - new Warm Craft desktop app icons and a theme-adaptive title-bar mark.

## Bug Fixes

- Command Terminal now refits its content on container-only size changes and settles scrollback cleanly on repaint.
- Advanced per-task overrides lock reliably at first spawn from every entry point.
- Usage stats capture git churn on every finalization and merge live sessions correctly; the Live view's cost cards and sparkline are fixed.
- The Changes panel shows diffs for tasks without a worktree, and its state is scoped per window.
- Pasted or dropped images now inject an agent-readable reference.
- Orphaned background shells drain via transcript instead of a dead hook.
- Restored the pointer cursor on buttons after a Tailwind v4 regression.
- Board task-detail windows hide correctly over the Backlog view.
