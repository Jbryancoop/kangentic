---
paths:
  - "src/main/index.ts"
  - "src/main/shutdown.ts"
  - "src/main/pty/shutdown/**"
---
# Rule: the `before-quit` shutdown path must be synchronous

Electron's `before-quit` handler must do only synchronous work. The previous approach
(`event.preventDefault()` + async shutdown + `process.exit()`) cancelled Electron's normal quit
flow: if the async chain stalled (network call, PTY wait, uncaught error), the main process
survived and every Chromium child process (GPU, utility, crashpad) became a zombie. On Windows
installed builds it also caused the app to auto-reopen.

## The rule

The `before-quit` handler in `src/main/index.ts`, and everything it calls, must be fully
synchronous.

1. Do all cleanup synchronously: mark DB session records `suspended`, kill PTYs, close DBs
   (better-sqlite3 is synchronous).
2. Do NOT call `event.preventDefault()`. Let Electron's normal quit proceed.
3. Fire-and-forget analytics. Never `await` a network call during shutdown.
4. Set a hard failsafe timer (`taskkill /T /F` on Windows, `SIGKILL` of the process group
   elsewhere) as a backstop.

This forfeits the 2-second graceful CLI exit window (`suspendAll`). Sessions stay resumable
because DB records are marked `suspended` before PTYs are killed, and `--resume <id>` works from
the saved session id.

## Enforcement (self-maintaining)

- **Tests:** `tests/unit/task-move-shutdown.test.ts`, `shutdown-history-wiring.test.ts`, and
  `shutdown-leak-fixes.test.ts` cover early-exit guards, IPC error swallowing during shutdown,
  and closing connections before close to plug leaks. Run in CI via `npm run test:unit`.
- **Contract:** the JSDoc in `src/main/shutdown.ts` and
  `src/main/pty/shutdown/session-shutdown.ts` restate the synchronous requirement at the call
  sites.

## Scope

The Electron quit path only. Normal runtime code may be async; this rule is specifically about
`before-quit` and the functions it invokes synchronously.
