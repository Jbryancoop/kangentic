## What's New

- **Searchable conversation memory.** Semantic + keyword search (hybrid RAG) across your past conversations.
- **Description peek.** Open a task's full description as a resizable side panel and toggle it with Mod+Shift+K.
- **Per-task commit graph.** A new commit graph pane in the task detail view.
- **Copyable terminal output blocks.** Select and copy whole output blocks straight from the terminal.
- **Markdown preview in the diff viewer.** Toggle a rendered markdown view of changed files.
- **Smarter model picker.** Rescans installed models when you open the dropdown, hides superseded model generations, and shows a self-discovered context-window badge.
- **Redesigned Edit Columns.** A master-detail layout with maximize support.
- **MCP improvements.** Attach and remove files on existing tasks, no more prompts for Kangentic's own MCP tools, and each MCP tool pill now links to its docs.
- **Snappier UI.** Eliminated a class of recurring UI freezes.

## Bug Fixes

- Terminal: honor OSC 52 clipboard writes, restore the model/effort picker after a live model change, stop block-copy from misfiring on live prompts, and land PowerShell sessions correctly in bracketed project paths.
- Board cards now show an honest context percentage (never over 100%) and stream the model and context directly from the session transcript.
- Fixed a ContextBar flip-flop caused by out-of-order rate-limit windows.
- Sidebar divider clicks no longer collapse the project panel.
- Restored terminals now paint at the fitted width instead of a stale size.
- Backlog import filters now cover the full source, and the orphan sweep no longer deletes fresh session directories.
