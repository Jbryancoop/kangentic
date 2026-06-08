## What's New

- **Per-column session control.** Columns can now run their own isolated agent session, with separate settings for the session target and spawn strategy. These per-column settings round-trip to `kangentic.json` so they can be shared with your team.
- **Live session stats in the context bar.** The context bar now surfaces live session stats with an expandable tool-call breakdown.
- **Smarter code review.** Code review scopes against the base branch through your working tree, and larger reviews automatically fan out across multiple agents.
- **More reliable PR linking.** Branches now resolve to their pull request through a confidence-ranked resolver.
- **Clearer diagnostics.** Main-process logs are tagged with the project name and prefixed with local-time timestamps.
- **Readable Isolated badge.** A theme-adaptive Isolated badge now appears on the session tab and task detail.

## Bug Fixes

- Smoother, flicker-free drag-to-Done animations: cards no longer snap back, flash back to their source column, or flicker on repeat completion.
- More accurate activity tracking: no false idle when a running session's directory is deleted, active state restores after a permission pause, and "waiting for input" is treated as idle.
- Agent sessions killed by the OS are now resumed on startup.
- The model and effort picker is interactive in the Command Terminal and default-agent tasks.
- Bridge and plugin scripts now deploy correctly in dev mode.
