# Kangentic

Cross-platform desktop Kanban for Claude Code agents.

## CRITICAL: Single-Command Bash Calls Only

**THIS IS THE #1 RULE. Every Bash tool call MUST contain exactly ONE command.**

Claude Code does not support chained, piped, or redirected-stderr commands. Violations **will** produce errors or silent data loss.

**Forbidden operators:** `&&`, `||`, `|`, `;`, `2>/dev/null`, `2>&1`

**Forbidden patterns — NEVER do this:**
```
cd /some/path && git status          # WRONG — chained commands
git diff | head -20                  # WRONG — pipe
npm run build && npm test            # WRONG — chained commands
cat file.json | grep "key"          # WRONG — pipe
find . -name "*.ts" -type f         # WRONG — use Glob tool instead
find /path -name "types.ts" | head  # WRONG — pipe + find
command1 ; command2                  # WRONG — semicolon
some-command 2>/dev/null            # WRONG — stderr redirection
```

**ALWAYS use dedicated tools instead of shell commands:**
- **`Read`** tool (with `offset`/`limit`) — replaces `cat`, `head`, `tail`, `less`
- **`Grep`** tool — replaces `grep`, `rg`, and piping into `grep`
- **`Glob`** tool — replaces `find`, `ls` for file discovery
- **`Write`** tool — replaces `echo` redirection, `cat <<EOF`
- **Bash `timeout` parameter** — replaces `sleep`
- Run commands separately in individual Bash tool calls — replaces `&&`, `;`, `||`

**Correct alternatives:**
```
git -C /some/path status             # CORRECT — git -C for git commands in other dirs
git -C /some/path log --oneline -5   # CORRECT — never cd && git
npm run typecheck                    # CORRECT — run from cwd, or use --prefix
```

**Git specifically: ALWAYS use `git -C <path>` instead of `cd <path> && git ...`.** The `cd && git` pattern triggers a Claude Code security prompt that cannot be bypassed. `git -C` is the only correct way to run git in another directory.

**This rule applies everywhere: main sessions, subagents, worktree agents, commands, and skills. No exceptions.**

## Tech Stack

- **Runtime:** Electron 41 + Node 24
- **Frontend:** React 19, Zustand, Tailwind CSS 4, Lucide React icons
- **Backend:** better-sqlite3, node-pty, simple-git
- **Build:** Vite (renderer), esbuild (main/preload), electron-builder (packaging)
- **Testing:** Playwright with Electron support
- **Package:** NSIS (Windows), DMG (macOS), deb/rpm (Linux)

## Project Structure

```
build/            # Platform-specific signing & entitlement files
config/           # Vite configs (renderer, used by scripts/dev.js)
packages/
  launcher/       # Public npm package ("kangentic") -- thin npx installer
    bin/          # kangentic.js launcher script
src/
  main/           # Electron main process
    agent/        # Agent adapter system
      shared/     # Shared utilities (interpolateTemplate, resolveBridgeScript, execVersion)
      adapters/   # Per-agent subfolders (claude/, codex/, gemini/, qwen-code/, opencode/, aider/)
      commands/   # MCP command handlers
    boards/       # Board integration adapter system (mirrors agent/)
      shared/     # BoardAdapter interface + auth, mapping, download, rate-limit helpers
      adapters/   # Per-provider subfolders (github-issues/, azure-devops/, jira/, etc.)
      board-registry.ts  # Central BoardRegistry + boardRegistry singleton
    db/           # SQLite database, migrations, repositories
    engine/       # Transition engine (action execution)
    git/          # Worktree manager
    ipc/          # IPC handler registration
    pty/          # PTY session manager, shell resolver
  preload/        # Context bridge (preload.ts)
  renderer/       # React UI
    components/   # Board, dialogs, layout, terminal, sidebar
    hooks/        # useTerminal
    stores/       # Zustand stores (board, config, project, session)
  shared/         # Types and IPC channel constants
tests/
  e2e/            # Playwright E2E tests
scripts/          # Build and dev scripts
```

## Commands

- `npm start` — Start in development mode (Vite HMR + esbuild watch)
- `npm run build` — Production build to `.vite/build/`
- `npm test` — Run all Playwright E2E tests

- `npm run package` — Package for distribution (unpacked directory)
- `npm run make` — Build installer (NSIS on Windows, DMG on macOS, deb/rpm on Linux)

**Worktrees need `npm install`:** Git worktrees do not share `node_modules/` with the main repo. Always run `npm install` in a worktree before running any npm scripts (`npm run typecheck`, `npm run build`, `npx playwright test`, etc.). Without it, binaries like `tsc` won't be found.

## Architecture

### Data Flow
1. User drags a task between columns (swimlanes)
2. `TASK_MOVE` IPC handler fires in main process
3. Transition engine checks for actions attached to that lane transition
4. `spawn_agent` action builds a Claude CLI command and spawns a PTY session
5. Terminal output streams to renderer via IPC

### Key Patterns
- **IPC channels** defined in `src/shared/ipc-channels.ts` — single source of truth
- **Stores** use Zustand with IPC bridge: renderer store calls `window.electronAPI.*`, main process handles via `ipcMain.handle`
- **Icons** use Lucide React — no inline SVGs
- **PTY sessions** handle cross-platform shells (PowerShell needs `& ` prefix, WSL splits into exe + args, fish/nushell skip `--login`)
- **Claude CLI** is invoked with `cwd` set to the project directory (or worktree path) so that `.claude/`, `CLAUDE.md`, and commands are loaded into context
- **HMR / dev-mode parity** - The team dogfoods Kangentic from `npm start` daily, so dev mode must be visually and behaviourally indistinguishable from a production boot. See the "HMR patterns" subsection below for the four primitives and which one to reach for when adding a feature.
- **Command Terminal** - Ctrl+Shift+P opens an ephemeral "transient" session with no DB persistence. The `transientSessions` map in `session-store.ts` tracks per-project transient sessions (keyed by project ID). Unlike task-bound sessions, transient sessions are NOT restored by `syncSessions()` - they rely entirely on the in-memory map. The map is preserved across HMR via `import.meta.hot.data`. Closing the overlay keeps the PTY alive in the background; reopening reattaches to the existing session. Project switching stashes/restores transient session pointers.
- **Settings tab separator** — In `AppSettingsPanel`, tabs above the `separator: true` marker are per-project settings (saved to `.kangentic/config.json`). Tabs below the separator (Behavior, Notifications, Privacy) are shared settings that apply across all projects (saved to global config). When a project is open, all 7 tabs are shown. When no project is selected, only the 3 shared tabs appear. There is no Global/Project scope toggle. When adding new settings, decide if they are per-project or shared and place the tab accordingly.

### HMR patterns (CRITICAL for dev-mode parity)

The team uses Kangentic itself while building it, so a Vite Fast Refresh during a real session must not regress UX. Four primitives cover every HMR-sensitive surface; mixing them up causes flaky behaviour that only surfaces in dev, which is exactly the failure mode this project cannot tolerate. When adding a feature, pick the right pattern up front rather than reaching for ad-hoc fixes later.

| Pattern | When to reach for it | How to apply | Example sites |
|---|---|---|---|
| **A. Preserve** | Module-scope state (timers, AbortControllers, caches, counters, scroll positions) that must survive a module reload | `let x = import.meta.hot?.data?.x ?? <default>;` plus `import.meta.hot?.dispose((d) => { d.x = x; })` | `task-slice.ts` (`moveGeneration`), `session-store.ts` (`syncController`, transient sessions), `useTerminal.ts` (`savedScrollPositions`), `toast-store.ts` (`toasts`), `hmr-generation.ts` (`generation`), `auto-name-scheduler.ts` (timer maps) |
| **B. Re-sync** | Zustand stores whose truth lives in the main process (IPC-backed) | Add a `load*` / `sync*` call to the `vite:afterUpdate` handler in `App.tsx`. Enforced by `tests/unit/hmr-resync.test.ts` | `loadBoard()`, `loadBacklog()`, `loadConfig()`, `loadProjects()`, `syncSessions()` |
| **C. Re-key remount** | Stateful third-party React subtrees whose internal subscriptions go stale across Fast Refresh (currently: every `<DndContext>`) | `const hmrGeneration = useHmrGeneration();` then `<DndContext key={hmrGeneration}>`. Enforced by `tests/unit/hmr-resync.test.ts` | All 5 `<DndContext>` sites: `KanbanBoard`, `BacklogView`, `PrioritiesPopover`, `ProjectSidebar`, `ShortcutsTab` |
| **D. Cleanup** | Imperative DOM/global state no React component owns (e.g. classes toggled via `querySelector`) | Add the clear to the top of the `vite:afterUpdate` handler | `.drop-highlight` class removal in `App.tsx` |

**Picking the pattern (decision tree):**

1. Are you adding a new IPC-backed Zustand store, or a new `load*` / `sync*` method on an existing one? → **Pattern B**: add a call in `App.tsx`'s `vite:afterUpdate` handler. `hmr-resync.test.ts` will fail until you do.
2. Are you adding a new `<DndContext>` or other React component that wraps a third-party library with internal subscription state? → **Pattern C**: pair it with `useHmrGeneration()` and `key={hmrGeneration}`. The HMR enforcement test will catch a missing key.
3. Are you adding module-scope `let`/`const` mutable state (Maps, Sets, AbortControllers, counters) under `src/renderer/stores/` or `src/renderer/utils/`? → **Pattern A**: preserve it via `import.meta.hot.data`, or annotate the declaration with `// hmr-safe: <reason>` if reset-on-HMR is intentional. `hmr-resync.test.ts` enforces one or the other.
4. Are you imperatively setting a class, attribute, or global handle that React won't tear down? → **Pattern D**: add the clear to the existing `vite:afterUpdate` handler.

**Anti-patterns:**

- Don't combine A and C on the same state. Either preserve it across HMR (A) or accept that the component remounts and re-derives it (C).
- Don't add a fifth ad-hoc HMR workaround. If something doesn't fit A/B/C/D, that's a signal to surface the gap and extend the catalog deliberately, not to add a one-off.
- Don't gate Pattern A behind `process.env.NODE_ENV` checks. `import.meta.hot` is `undefined` in production builds, so the guards already collapse to no-ops.

**Verification:** the `hmr-parity` agent (`.claude/agents/hmr-parity.md`) audits this catalog after changes that touch HMR-sensitive surfaces. Run it during code review for any feature that adds stores, DndContext sites, module-scope state, or imperative DOM mutation.

### Shutdown (CRITICAL)

The `before-quit` handler in `src/main/index.ts` **must be fully synchronous**. Never use `event.preventDefault()` + async shutdown + `process.exit()`. That pattern cancels Electron's normal quit flow, which means Electron never reaches its own cleanup -- all Chromium child processes (GPU, utility, crashpad) survive as zombies. If the async chain stalls for any reason (network call, PTY wait, uncaught error), the main process also survives, and on Windows installed builds the app can auto-reopen.

The correct pattern:
1. Do all cleanup synchronously in `before-quit` (mark DB records, kill PTYs, close DBs)
2. **Do not** call `event.preventDefault()` -- let Electron's normal quit proceed
3. Fire-and-forget analytics (never await network calls during shutdown)
4. Set a hard failsafe timer (`taskkill /T /F` on Windows) as a backstop

This means we lose the 2-second graceful Claude CLI exit window (`suspendAll`). Sessions are still resumable because the DB records are marked `suspended` before PTYs are killed, and `--resume <id>` works from the saved session ID.

### Per-Project Directory
All runtime data lives under `<project>/.kangentic/` (auto-added to `.gitignore` on project open):
- `config.json` — project config overrides
- `sessions/<claudeSessionId>/` — per-session files (`settings.json`, `status.json`, `activity.json`)
- `worktrees/<slug>/` — git worktree checkouts

### Database
- Global DB (`<configDir>/index.db`) for projects list — configDir is `%APPDATA%/kangentic/` (Win), `~/Library/Application Support/kangentic/` (Mac), `~/.config/kangentic/` (Linux)
- Per-project DB (`<configDir>/projects/<projectId>.db`) for tasks, swimlanes, actions, sessions
- Migrations run automatically on open
- **Timestamps are stored as UTC ISO 8601 strings** (`TEXT` columns like `created_at`, `updated_at`, `archived_at`, `started_at`, `exited_at`). Always write via `new Date().toISOString()` - never use SQLite's `DEFAULT CURRENT_TIMESTAMP` (emits `YYYY-MM-DD HH:MM:SS` with no `Z` suffix; JS parses that as local time, not UTC) or naive strings like `new Date().toString()`. Display formatting is the renderer's job (`src/renderer/lib/datetime.ts`) - the DB only holds UTC instants.

### Testing

Three test tiers — prefer **unit tests** for pure logic, **UI tests** for anything that doesn't need the real Electron backend.

#### Unit tests (`tests/unit/`) — fast, no browser
- Run with `npm run test:unit` (vitest)
- Covers: event-bridge script, hook-manager inject/strip logic, session suspend state
- No build step, no browser — runs directly against source

#### UI tests (`tests/ui/`) — headless, fast, no windows
- Run with `npx playwright test --project=ui`
- Uses headless Chromium against the Vite dev server (auto-started by Playwright)
- `mock-electron-api.js` injects a full in-memory mock of `window.electronAPI` via `addInitScript()`
- Covers: app launch, project CRUD, task CRUD, drag-and-drop, column management
- No build step needed — runs against Vite HMR directly
- ~13 seconds for 72 tests

#### E2E tests (`tests/e2e/`) — real Electron, opens windows
- Run with `npx playwright test --project=electron`
- Uses Playwright's `_electron.launch()` — always opens a real window on Windows (no headless mode)
- Required for: PTY sessions, terminal rendering, session lifecycle, config persistence, shell detection
- Build required first: `npm run build`
- Shell-parameterized tests run for all detected terminals (WSL, PowerShell, bash, cmd, etc.)

#### Run both
- `npx playwright test` runs UI + Electron projects
- `npx playwright test --project=ui` for quick headless-only validation

#### Adding new tests
- Pure logic (parsers, filters, state machines) → add to `tests/unit/`
- Pure UI interactions (clicks, forms, dialogs, drag-and-drop) → add to `tests/ui/`
- Needs real IPC, PTY, or session spawning → add to `tests/e2e/`
- The mock in `tests/ui/mock-electron-api.js` supports full CRUD — extend it if new API methods are added

#### When to test

Full-tier runs are reserved for the `/test` command or explicit user request. While working on a task, stay scoped to what you changed.

**Always fine:**
- `npm run typecheck` - run freely at any point.
- Running tests you just added or modified, scoped to those files:
  - `npx vitest run tests/unit/my-new.test.ts`
  - `npx playwright test tests/ui/my-new.spec.ts`
- Single-file validation of an existing test directly affected by your change (same scoped form).

**Never run unless the user explicitly asks, or `/test` / `/merge-back` is executing:**
- `npm test`
- `npm run test:unit` (unscoped vitest)
- `npx vitest run` (no file path)
- `npx playwright test` and `npx playwright test --project=ui` (no spec path)

If a run would execute tests you did not add or modify, it is a full-tier run. Stop and let `/test` handle it.

**Pre-commit:** `/merge-back` runs typecheck automatically. Full-tier validation is the `/test` command's job.

### Auto-Name Tasks from Prompt

Always-on feature that suggests task titles from the description. Two surfaces:

- **`<NameFromPromptButton>`** in `src/renderer/components/NameFromPromptButton.tsx` - square Sparkles icon button placed alongside the title input (NOT inside it). Reusable; exposes a `useNameFromPromptAvailable(description)` hook. Used by `NewTaskDialog` and `TaskDetailEditForm`. Visibility gated on: project's default agent has `supportsSummarize`, the agent CLI is detected, and description is non-empty.
- **30-second rename toast** wired in `App.tsx` - fires once per task per app run for placeholder-titled tasks (`fix`, `wip`, etc., or empty). Persisted via `AppConfig.autoNameAskedTaskIds` (drained on task delete) so a dismissed suggestion does not re-appear after restart.

The capability is exposed by adapters via the optional `summarize?(prompt, cliPath, cwd)` method on `AgentAdapter`. Implementations live next to each adapter and use the shared `runCliPrintSummarize` helper in `src/main/agent/shared/auto-name.ts`. Capability matrix:

| Agent | Invocation | Prompt delivery |
|---|---|---|
| Claude | `claude --print --permission-mode plan` | stdin |
| Codex | `codex exec --skip-git-repo-check` | stdin |
| Gemini | `gemini --output-format text` | stdin (non-TTY headless) |
| Qwen Code | `qwen --output-format text` | stdin (non-TTY headless) |
| OpenCode | `opencode run -q` | stdin |
| Kimi | `kimi --print --quiet` | stdin |
| Cursor | `agent --output-format text -p "<prompt>"` | positional arg |
| Droid | `droid exec -o text "<prompt>"` | positional arg |
| Copilot | `copilot --silent -p "<prompt>"` | positional arg |
| Aider, Warp | (no clean plain-text headless mode yet) | n/a |

Adapters that omit `summarize` are gated out automatically: the renderer hides the button and never schedules the 30s toast.

**Production knobs:**
- `AppConfig.autoNameAskedTaskIds: string[]` - persisted "don't re-ask" set, drained when a task is deleted (single + bulk delete in `task-crud.ts`)
- `AppConfig.autoNameRateLimitPerHour: number` (default 60, 0 disables) - sliding-window cap on summarize CLI calls per hour, enforced in the IPC handler

**Verification:** `node scripts/probe-summarize.js` runs each detected adapter's `summarize()` against a sample description and reports success/timeout/format issues. Run after installing or upgrading any agent CLI to verify Kangentic's invocation still produces a sane title.

**Adding a new adapter's summarize:** import `runCliPrintSummarize` and `buildSummarizePrompt` from `../../shared/auto-name`, then add a `summarize()` method that picks the right `args`, `promptVia`, and (if needed) `extractRaw`. Mirror the pattern in `tests/unit/agent-summarize-shape.test.ts`. Update `tests/ui/mock-electron-api.js` to set `supportsSummarize: true` on the agent's mock entry.

### Performance

- **Terminal ownership handoff:** Each PTY session spawns exactly one Claude Code CLI process. The bottom panel and task detail dialog share that single process but never render simultaneously — when the dialog opens, it claims the session via `dialogSessionId` and the panel unmounts its xterm instance. On close, the panel recreates its xterm from the PTY scrollback buffer. This prevents duplicate xterm instances from sending conflicting resize calls (different container widths garble TUI output) and ensures one CLI process per task regardless of which view is active.
- **Activity log replaces aggregate terminal:** The "Activity" tab shows structured events (tool calls, idle state) from Claude Code hooks instead of raw terminal output. Uses a plain DOM list — no xterm/WebGL overhead. Events flow: hook → event-bridge.js → JSONL file → fs.watch → IPC → Zustand store → ActivityLog component.
- **WebGL renderer:** xterm instances attempt WebGL acceleration first, with automatic fallback to canvas on context loss or unavailability.
- **Resize debouncing:** PTY resize calls are debounced (200ms) and suppressed entirely during panel drag operations to prevent scrollback eviction from rapid row-count changes.

## Conventions

- TypeScript strict mode
- Prefer editing existing files over creating new ones
- Use `data-testid` and `data-swimlane-name` attributes for test selectors
- All dialogs use global `useEffect` Escape key listener
- When adding or updating tests, use the `/test` command to ensure correct tier classification
- **No `any` types** — never use `any` in new code. Use proper types from `src/shared/types.ts`, `unknown` with type guards, or generic constraints. The `/code-review` command will flag `any` usage. Existing `any` casts should be replaced when touching the file.
- **Git commit/push workflow:** When asked to "commit and push", "commit changes", or similar — use `/merge-back`. It handles commit, typecheck, rebase, and push safely. Works from both worktrees and the main repo. Use `/pull-request` instead when a PR audit trail is desired — it shares the same commit/rebase flow but creates a PR and admin-merges it instead of pushing directly.
- **No shorthand variable names** — use full, descriptive names. `currentIndex` not `curIdx`, `previousValue` not `prev`, `session` not `sess`. Applies to all code: variables, refs, parameters, callback args, etc.
- **No em-dashes or double-dashes** — never use em-dashes (U+2014), `&mdash;`, or `--` as sentence or list separators. Use a single dash `-` for inline separators (e.g. `**Bold** - description`) or restructure with periods. Em-dashes render as garbled characters on Windows console code pages; double-dashes look awkward in UI text. Applies to source code, comments, tests, docs, scripts, and JSX.
- **Confirmation dialogs:** Use `ConfirmDialog` for all yes/no prompts. Set `showDontAskAgain` when the confirmation should be suppressible. Never create one-off modal components for simple confirmations.
- **Per-task lifecycle locks:** Any IPC handler or helper that crosses an `await` boundary AND mutates per-task state (`task.session_id`, PTY sessions via `sessionManager.spawn`/`kill`/`suspend`, worktrees via `ensureTaskWorktree`/`cleanupTaskResources`, or calls `spawnAgent`/`autoSpawnForTask`) MUST wrap its async region in `withTaskLock(taskId, async () => { ... })` from `src/main/ipc/task-lifecycle-lock.ts`. This serializes concurrent operations on the same task while leaving different tasks fully parallel. Two rules: (1) cancellation (`AbortController.abort()`) goes OUTSIDE the lock so the in-flight holder can observe its abort and release; (2) the lock is NOT reentrant - never call another `withTaskLock` for the same `taskId` from inside a locked block. Pure read-only handlers and synchronous-only paths do not need the lock - if you never `await`, you cannot race. See the JSDoc on `withTaskLock` and existing usage in `handlers/sessions.ts` for the canonical pattern. Contract is locked in by `tests/unit/task-lifecycle-lock.test.ts`.
- **Documentation maintenance:** `/sync-docs` reviews and updates `docs/` to match source code. Runs automatically during `/merge-back`. See `.claude/skills/sync-docs/SKILL.md` for the source-to-doc mapping.

### Skill context: when to fork

Claude Code's `context: fork` skill-frontmatter field runs a skill in an isolated subagent: it gets no prior conversation history, receives its SKILL.md as the prompt, and returns only a final summary to the main loop. This gives fresh, unbiased context and keeps heavy intermediate output out of the main session. Use it deliberately:

- **Fork** (`context: fork`, no `agent:` so it routes to the default general-purpose agent) when ALL hold: the skill is self-contained (derives everything from git, files, and args), produces heavy or noisy intermediate output, benefits from fresh/unbiased context, ends in a digestible summary, and has no mid-run user gate. No skill currently forks: `code-review` previously did, but moved to a main-loop driver + delegation when it gained the size-gated `Workflow` path (a forked driver calling `Workflow` would nest subagents - see the "Do NOT fork" rule below). Its fresh-context independence is preserved by delegating the review judgment to fresh subagents instead.
- **Do NOT fork** when ANY hold: the skill is a gated, mutating workflow (commit, rebase, push, tag, admin-merge) that needs main-loop visibility and confirmations; it is a knowledge-injection skill whose whole purpose is to enrich the MAIN context (`session-lifecycle`, `cross-platform`, `ipc-bridge`); it is active implementation tied to the current conversation; or it already delegates heavy work to a subagent (forking the driver risks subagent nesting, which is undocumented). `test` and `sync-docs` stay inline for this reason.
- **Active-implementation skills** verify by auto-spawning their auditor agent (delegation), not by forking. Example targets: `add-ipc-endpoint` to `ipc-auditor`, `add-migration` to `migration-safety`, and `code-review` to its dimension auditors (`ipc-auditor`, `hmr-parity`, `platform-guard`, `session-debugger`, `migration-safety`) via the in-session `Workflow` orchestrator on large diffs. `test` delegates likewise (`test-builder`), fanning out per-tier coverage auditors via `Workflow` on sprawling changes.
- **Never route a fixing or mutating skill to `agent: Explore` or `agent: Plan`** - those built-in agents are read-only and skip CLAUDE.md, so they would drop our conventions (single-command Bash, no em-dashes, no `any`). The default general-purpose fork loads CLAUDE.md and keeps the skill's `allowed-tools`.
