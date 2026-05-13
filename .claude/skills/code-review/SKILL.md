---
description: Review git changes for quality and conventions
allowed-tools: Read, Glob, Grep, Edit, Write, Bash(git:*), Bash(npm:*), Bash(npx:*)
argument-hint: [review-only]
---

# Code Review

Review the current git changes (staged and unstaged) for quality, correctness, and project conventions, then apply every safely-fixable finding.

## Modes

- **Default** (`/code-review`) - review, then immediately apply every safely-fixable finding, re-run typecheck, and report `Changes Applied` + `Skipped (with reason)`.
- **Review-only** (`/code-review review-only`) - findings table + Verdict footer only, no edits applied.

The skill reads `$ARGUMENTS`. If the literal token `review-only` is present, skip the Apply Phase and Re-typecheck steps and emit the legacy Verdict footer instead of the Changes/Skipped report.

**User-provided arguments (if any):** $ARGUMENTS

## Instructions

All commands below run from the **current working directory** - never use `cd <path> && git ...` (triggers an unbypasable security prompt). If the CWD is a worktree, git operates on it automatically.

1. Run `npm run typecheck` to check for type errors. Any type errors are **highest-priority findings** - they represent potential runtime crashes. Include them in the review output even if they are in files not touched by the current diff.
2. Run `npx vitest run tests/unit/hmr-resync.test.ts` (fast, ~150ms). This enforces the three mechanical HMR-parity invariants: every IPC-backed store has its `load*` / `sync*` registered in `App.tsx`'s `vite:afterUpdate` handler; every top-level mutable module state under `src/renderer/stores/` or `src/renderer/utils/` either preserves itself via `import.meta.hot.dispose(` or carries a `// hmr-safe:` directive; every `<DndContext>` has `key={...HmrGeneration}`. A failure here is a **Critical** finding (dev-mode regression that production users won't see but dogfooders will mistake for a real bug).
3. Run `git diff` and `git diff --staged` to identify all changed files and hunks. If both are empty, emit "No changes to review." and stop.
4. For each changed file, read the full file to understand the surrounding context.
5. Analyze every change against the criteria below and build the findings table.
6. **Apply Phase** (skip in `review-only` mode): for every finding, attempt the recommended fix using `Edit`/`Write`. Each fix is its own atomic unit - if one fails or is unsafe, skip it with a reason but keep the others. See "What gets auto-fixed" below.
7. **Re-typecheck** (skip in `review-only` mode): run `npm run typecheck` again. If a fix introduces a new type error, revert that specific edit and move the finding to `Skipped` with reason `"Fix introduced type error: <message>"`. Do not roll back unrelated fixes.
8. Emit the output format below.

## Review Criteria

### Correctness
- Logic errors, off-by-one mistakes, null/undefined risks
- Missing error handling or unhandled promise rejections
- Race conditions or incorrect async/await usage

### Performance
- Unnecessary allocations, re-renders, or repeated work
- Missing memoization where expensive computation occurs
- Inefficient data structures or algorithms

### Maintainability
- Readability: unclear naming, overly complex expressions
- Duplication that should be extracted
- Premature abstractions or over-engineering

### Best Practices
- TypeScript strict mode compliance - **no `any` in new code**. Use proper types from `src/shared/types.ts`, `unknown` with type guards, or generic constraints. Flag any new `any` or `as any` cast as a finding.
- **External-input parsers need a real-shape fixture test.** When code parses input from outside the TypeScript boundary (`JSON.parse` of file contents, IPC payloads from external CLIs, network responses, child-process stdout) and dispatches on string-literal field comparisons, flag it as a finding unless there is a regression test that replays a real (sanitized) sample of the external format. Type-safety stops at the parse boundary. TypeScript will happily narrow `unknown` to a union you declared, even when the runtime shape has drifted. Runtime fixtures are the type system on the other side. See `tests/fixtures/codex-rollout-event-msg.jsonl` + `tests/unit/codex-session-history-parser.test.ts` for the canonical pattern.
- **No shorthand variable names** in new or changed code. Use full, descriptive names: `session` not `sess`, `currentIndex` not `curIdx`, `previousValue` not `prev`. Applies to variables, parameters, callback args, refs.
- Security: injection risks, unsanitized input
- Proper error handling at system boundaries

### Project Conventions (from CLAUDE.md)
- Single-command bash calls only (no `&&`, `||`, `|`, `;` chaining)
- Lucide React icons only (no inline SVGs)
- `data-testid` and `data-swimlane-name` attributes for test selectors
- Zustand stores with IPC bridge pattern
- IPC channels defined in `src/shared/ipc-channels.ts`
- All dialogs use global `useEffect` Escape key listener
- **No agent-specific code outside `src/main/agent/adapters/`.** Flag any branch on agent name (`agent === 'claude'`, `agent === 'droid'`, `taskAgent === '<x>'`, `switch (adapter.name)`, etc.) found in renderer code, IPC handlers, shared utilities, stores, or tests outside the `adapters/` tree. Adapter-specific copy, tooltips, capability decisions, and behavior must live with the adapter and surface through generic capability fields (e.g. `AgentAdapter.liveTelemetryUnsupported`, `AdapterRuntimeStrategy`, `AgentDetectionInfo` extensions). Suggested grep: `agent === '|taskAgent ===|adapter\.name ===` under `src/renderer/`, `src/shared/`, and `src/main/ipc/`.

### Domain-Specific Checks

After identifying changed files in Step 2, read the relevant skill files to load domain context. Then apply the domain-specific checks below in addition to the general criteria.

**IPC files** (`ipc-channels.ts`, `types.ts`, `preload.ts`, `handlers/`, `mock-electron-api.js`):
- Read `.claude/skills/ipc-bridge/SKILL.md` before reviewing these changes
- Verify all 7 IPC layers are consistent: channel constant, types, preload, handler, service, store, mock
- Check push event subscriptions return unsubscribe functions
- Check push event callbacks filter by `projectId`
- Check `!mainWindow.isDestroyed()` guard on broadcasts

**Session/PTY/terminal files** (`session-manager.ts`, `session-queue.ts`, `transition-engine.ts`, `tasks.ts` handleTaskMove, `session-store.ts`, `TerminalPanel.tsx`):
- Read `.claude/skills/session-lifecycle/SKILL.md` before reviewing these changes
- Verify state transitions follow the legal state machine
- Check `commandInjector.cancel()` is called before session state changes in handleTaskMove
- Check generation counter / reference comparison guards are preserved
- Check terminal ownership handoff: one xterm per session, `dialogSessionId` exclusion
- Check `status` is not overwritten after suspend (exit handler must check current status)

**Shell/agent/path files** (`shell-resolver.ts`, `command-builder.ts`, `worktree-manager.ts`, `paths.ts`, `useTerminal.ts`):
- Read `.claude/skills/cross-platform/SKILL.md` before reviewing these changes
- Check for Unicode em-dashes (must use ASCII `--`)
- Check PowerShell quoting: prompts replace `"` with `'` before `quoteArg()`
- Check Windows file ops use `{ force: true }` on `rmSync`
- Check `git -C <path>` instead of `cd && git`
- Check xterm WebGL context loss handling
- Check PTY resize debouncing is preserved

**HMR-sensitive files.** Trigger this check whenever the diff matches ANY of: a file under `src/renderer/stores/`, a file under `src/renderer/utils/`, `src/renderer/App.tsx`, or a hunk containing `<DndContext`, `import.meta.hot`, or a new top-level `let` declaration in the renderer:
- Read `.claude/agents/hmr-parity.md` before reviewing these changes. That file is the source of truth for the four HMR primitives (A: Preserve, B: Re-sync, C: Re-key, D: Cleanup) documented in `CLAUDE.md`'s "HMR patterns" section.
- Apply the decision matrix from `hmr-parity.md`: classify what new HMR-sensitive surface was added (new `<DndContext>`, new IPC-backed store method, new module-scope mutable state, new IPC subscription, new imperative DOM mutation, new code in the `vite:afterUpdate` handler) and verify the correct pattern is used.
- Flag anti-patterns: mixing A and C on the same state; a fifth ad-hoc HMR workaround; `process.env.NODE_ENV` gating around `import.meta.hot` (redundant, since `hot` is `undefined` in production); module-scope `addEventListener` registered at import time; reassigning `import.meta.hot.data = {...}` instead of mutating `data.x = value`.
- The Step 2 vitest run already catches the mechanical violations (missing store re-sync, missing dispose block, missing DndContext key). Do not duplicate those checks here; focus on semantic mismatches the test cannot detect.
- A missing HMR pattern is a **High**-severity finding (visible dogfooding regression). An anti-pattern is **Medium**. A redundant `NODE_ENV` guard is **Low**.

## Apply Phase

Default mode applies fixes immediately after the findings table. Fixes land in the working tree only - **never commit**; the user runs `/merge-back` for that.

### What gets auto-fixed

Local, mechanical, single-file or tightly-scoped edits:

- TypeScript `any` / `as any` casts -> proper type from `src/shared/types.ts`, `unknown` + type guard, or generic constraint
- Shorthand variable names -> expanded (`sess` -> `session`, `prev` -> `previousValue`, `curIdx` -> `currentIndex`)
- Em-dashes (U+2014) and `--` used as punctuation -> single dash `-` or restructured sentence
- Missing `data-testid` / `data-swimlane-name` on test selectors that the convention requires
- Single-command bash chain violations in skills/docs (`&&`, `||`, `|`, `;`) -> split into separate Bash blocks
- `cd <path> && git ...` -> `git -C <path> ...`
- Missing `{ force: true }` on Windows `fs.rmSync` in cleanup paths
- Missing `!mainWindow.isDestroyed()` guard on IPC broadcasts
- Inline SVGs -> Lucide React icon (when an obvious match exists)
- Mechanical agent-specific moves (move a string constant or capability flag into `src/main/agent/adapters/`); non-mechanical splits are skipped with reason
- One-file type fixes (narrow a return type, add a missing annotation)

### What gets skipped (with reason)

- **Architectural refactors** spanning multiple modules or changing public APIs
- **Missing test coverage** -> reason: `"Missing coverage; run /test write to add"`
- **Deletion of code the human just added** -> ask first
- **Conflicting findings** -> reason: `"Conflicts with finding #N; pick one and re-run"`
- **Ambiguous renames at >5 call sites** -> reason: `"Ambiguous rename; suggest manual review"`
- **Stakeholder-input findings** (security policy choices, UX copy, log-level changes)
- **Type errors in untouched files** -> reason: `"Outside current diff scope; flag for separate task"`
- **Findings that would trip a hook the user opted out of**
- **Any fix that introduces a new type error** (auto-reverted by the re-typecheck step)

For every skip, the report includes: finding number, `file:line`, reason, and a concrete next step (run `/test write`, manual review, defer to follow-up task, etc.).

## Output Format

### Findings Table

Present all findings in a single table, sorted by severity (Critical first, then High, Medium, Low):

| # | Severity | Category | Location | Finding | Recommendation |
|---|----------|----------|----------|---------|----------------|
| 1 | Critical | Correctness | `src/main/foo.ts:42` | Brief description of the issue | **Must fix** - what to change and why |
| 2 | High | Best Practices | `src/renderer/Bar.tsx:15` | Brief description | **Should fix** - suggested change |
| 3 | Medium | Performance | `src/main/baz.ts:88` | Brief description | **Consider** - tradeoff explanation |
| 4 | Low | Maintainability | `src/shared/types.ts:10` | Brief description | **Optional** - nice-to-have improvement |

#### Severity levels

| Severity | Meaning | Action |
|----------|---------|--------|
| **Critical** | Type errors, runtime crashes, data loss, security vulnerabilities | **Must fix** before merging |
| **High** | Logic bugs, missing error handling, `any` types, race conditions | **Should fix** - real risk of breakage |
| **Medium** | Performance issues, convention violations, unclear code | **Consider** - improves quality but not blocking |
| **Low** | Style nits, minor duplication, optional improvements | **Optional** - fix if touching the area anyway |

### Default-mode footer

After the findings table, run the Apply Phase and then emit:

```
### Changes Applied (N)

| # | File:Line | What changed |
|---|-----------|--------------|
| 1 | src/main/foo.ts:42 | Replaced `any` cast with `Task` type |
| 2 | src/renderer/Bar.tsx:15 | Renamed `sess` -> `session` (3 sites) |

Re-typecheck: PASS

### Skipped (M)

| # | File:Line | Why | Next step |
|---|-----------|-----|-----------|
| 5 | src/main/baz.ts:88 | Architectural refactor - splits handler across 3 files | Design review |
| 7 | src/renderer/Qux.tsx | Missing test coverage | Run `/test write` |

### Summary
- Files reviewed: N
- Findings: A critical, B high, C medium, D low
- Auto-fixed: N
- Skipped: M
- Verdict: **Clean** (or **Needs revision** - M skipped findings require human judgment)
```

Edge cases the footer must handle cleanly:
- No diff at all -> short-circuit at the `git diff` step (Step 3) with `"No changes to review."`
- Diff exists, zero findings -> `"No findings, nothing to fix."` and skip the Apply Phase
- Re-typecheck FAILS -> show the error block, list which fix was reverted, mark Verdict as **Needs revision**
- Step 2 hmr-resync vitest FAILS -> the failure output is itself a Critical finding. Include the failing assertion's message verbatim in the findings table, attempt the auto-fix in the Apply Phase (e.g. add the missing store re-sync call to `App.tsx`, add the missing `key={hmrGeneration}` to the new `<DndContext>`, add a `// hmr-safe:` directive or `dispose` block to the new module-scope state), then re-run the vitest in addition to typecheck during Step 7. If the test still fails after the fix attempt, mark Verdict as **Needs revision**.

### Review-only-mode footer

When `review-only` is in `$ARGUMENTS`, skip the Apply Phase and emit the legacy footer:

- **Files reviewed:** N
- **Findings:** N critical, N high, N medium, N low
- **Verdict:** one of:
  - **Ship it** - no findings, or only low-severity items
  - **Minor issues** - medium findings worth addressing, no blockers
  - **Needs revision** - critical or high-severity findings that should be resolved

## Allowed Tools

Default mode uses `Read`, `Edit`, `Write`, `Glob`, `Grep`, and `Bash` (git/npm only). `review-only` mode restricts itself to `Read`/`Glob`/`Grep`/`Bash`. Always run commands from the project root - no chained commands (`&&`, `||`, `|`, `;`).

**CRITICAL: Use `git -C <path>` for all git commands in other directories.** Never use `cd <path> && git ...` - the `cd && git` pattern triggers an unbypasable Claude Code security prompt.

**Do not commit.** The skill applies fixes to the working tree only. The user runs `/merge-back` to commit and push.
