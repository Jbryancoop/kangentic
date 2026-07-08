## What's New

- In-place task description edits via MCP: agents can now update a task's description with targeted find-and-replace edits through `kangentic_update_task`, instead of resending the whole description.
- Background conversation indexing: a central embedding engine now indexes conversation memory in the background, duty-cycle throttled so it stays out of the way of active work.

## Bug Fixes

- More accurate analytics: model IDs are normalized, tool-use counts are backfilled, and the client identifier is scoped correctly.
- Context-window sizes are restored from saved metrics on boot, so board cards show the right model context right away instead of waiting to rediscover it.
- The conversation viewer keeps wide content contained and stays open when you switch projects.
