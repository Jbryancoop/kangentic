## What's New

- **Push-to-talk dictation.** Hold a hotkey to speak and have your words typed straight into the terminal, with local on-device voice-to-text.
- **Agent-driven browser pane.** Agents can now drive an embedded Browser pane through the new `kangentic_browser_*` MCP tools, with a streamlined Agent Browser settings tab.
- **Ollama adapter.** Run local LLMs through Kangentic with the new Ollama agent adapter.
- **Team-shared column descriptions.** Add a shared description to any board column; it round-trips through `kangentic.json` for the whole team.
- **Ticket numbers on cards.** Opt in to show ticket numbers on task cards.
- **MCP task-creation cap.** Set a limit on how many tasks the MCP server can create, from settings.
- **Persistent task layout and stats.** Each task remembers its detail-view layout and accumulates lifetime session stats.
- **Task title in preview.** The preview header now shows the task title.

## Bug Fixes

- Claude now opens in fullscreen and resizes correctly when the window changes size.
- Restored Ctrl+V paste and copy in the app.
- Eliminated terminal and board freezes under heavy output via PTY backpressure.
- Smarter activity detection with fewer false idle and thinking states.
- Session history now resumes correctly after a worktree rename.
- Background task cards now show the live model.
- Silenced a benign Monaco editor console error during diff disposal.
