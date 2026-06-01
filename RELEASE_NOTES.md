## Bug Fixes

- Live session state now stays visible across hot reloads and when switching between projects.
- Resuming a Claude session now survives moving a task to Done and back, thanks to stable worktree folder naming.
- Backlog imports no longer re-add tasks that were already promoted to the board.
- Creating a new project no longer inherits board import sources from other projects.
- Claude agent capability detection is more robust and tolerates wrapped command output.
