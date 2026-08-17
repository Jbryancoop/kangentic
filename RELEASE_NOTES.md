## What's New

- **Two new agent adapters: Grok Build (xAI) and Antigravity.** Both ship with the full Claude-parity harness: caller-owned session resume, hook-driven activity detection, Kangentic MCP wiring, folder trust, and usage telemetry. Kangentic now supports 14 agent CLIs.
- **Verified auto_command delivery for six more agents.** A task's opening prompt is now confirmed delivered rather than fired and forgotten, with a warning toast naming the command and reason when delivery fails.
- **In-app announcements got a home.** A megaphone in the title bar carries an unread badge and opens a browsable history, so an announcement you dismissed is still readable later.
- **Mobile companion pairing is honest in both directions.** The desktop announces a revoked pairing, and acts immediately when the phone unpairs from its side.
- **The Kangentic MCP server is now wired into Codex, Gemini, and Droid**, so agents on those CLIs can read and drive their own board.

## Bug Fixes

- Agent TUIs render in color again: sessions now default `TERM` and no longer inherit a leaked `NO_COLOR`.
- WSL sessions spawn as `wsl.exe`, and single-quoted CLI paths convert correctly for unix-like shells.
- Cursor is detected by its own `cursor-agent` binary instead of the generic `agent` shim that other CLIs also install.
- An agent running background subagents no longer reads as idle while a turn is retrying.
- Pasted images are capped at the measured size clamp, and the clipboard temp directory is pruned instead of growing without bound.
- The announcement history panel keeps a stable floor, and a preview run no longer relights the unread badge.
