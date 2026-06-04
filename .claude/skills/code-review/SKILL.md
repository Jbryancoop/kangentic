---
description: Review git changes for quality and conventions (auto-scales to a multi-agent pass on large diffs)
allowed-tools: Read, Glob, Grep, Edit, Write, Bash(git:*), Bash(npm:*), Bash(npx:*), Agent, Workflow
argument-hint: [review-only]
---

# Code Review

Review the current git changes (staged and unstaged) for quality, correctness, and project conventions, then apply every safely-fixable finding.

## Modes

- **Default** (`/code-review`) - review, then immediately apply every safely-fixable finding, re-run typecheck, and report `Changes Applied` + `Skipped (with reason)`.
- **Review-only** (`/code-review review-only`) - findings table + Verdict footer only, no edits applied.

The skill reads `$ARGUMENTS`. If the literal token `review-only` is present, skip the Apply Phase and Re-typecheck steps and emit the legacy Verdict footer instead of the Changes/Skipped report.

**User-provided arguments (if any):** $ARGUMENTS

**Auto-scaling (small vs large diffs).** This skill runs as a thin **driver** in the main loop. It measures the diff, then dispatches: small diffs get a single-pass review delegated to one fresh reviewer subagent (today's behavior, unchanged); large diffs auto-scale to the in-session multi-agent **Heavy Path** (see below). Both modes (default and `review-only`) work on both paths. The mechanism is identical in spirit to today: the actual review judgment always runs in a **fresh context window** that did not generate the code - the driver itself only runs mechanical pre-flight (typecheck, the HMR vitest, `git diff`) and orchestration.

### Reviewer independence

This review may run in the **same session that produced the code under review**, or in a **separate one that did not** - treat both the same. Judge the diff strictly on its own merits - correctness, conventions, and the criteria below - and do **not** assume the author's (or your own prior) intent was correct. That a change was just made is not evidence it is right. The driver delegates every finding to a fresh subagent that receives the diff as input but not the generation reasoning, so it can re-derive expected behavior independently even in the same-session case. Adversarial verifiers treat "the author clearly meant X" as inadmissible: verify X is actually present and correct in the code, and when uncertain, **refute** (drop) the finding rather than wave it through on assumed intent.

### Not the same as `/code-review ultra`

`ultra` is a Claude Code **built-in** that launches a multi-agent review in the **cloud** - user-initiated, billed, and not self-launchable by this skill. This project skill (`/code-review`) is an **in-session, local** reviewer: small diffs get the single-pass review, large diffs auto-scale to the in-session `Workflow` Heavy Path described here. Use `ultra` for a deep cloud audit on demand; this skill for the automatic, auto-fixing local pass. They are complementary, not unified - there is no attempt to share code between them.

## Instructions (driver)

The skill is a thin driver that runs in the main loop. All commands below run from the **current working directory** - never use `cd <path> && git ...` (triggers an unbypasable security prompt); use `git -C <path>` if you must target another directory. If the CWD is a worktree, git operates on it automatically.

1. **Pre-flight typecheck.** Run `npm run typecheck` to check for type errors. Any type errors are **highest-priority findings** - they represent potential runtime crashes. Include them in the review output even if they are in files not touched by the current diff.
2. **Pre-flight HMR vitest.** Run `npx vitest run tests/unit/hmr-resync.test.ts` (fast, ~150ms). This enforces the three mechanical HMR-parity invariants: every IPC-backed store has its `load*` / `sync*` registered in `App.tsx`'s `vite:afterUpdate` handler; every top-level mutable module state under `src/renderer/stores/` or `src/renderer/utils/` either preserves itself via `import.meta.hot.dispose(` or carries a `// hmr-safe:` directive; every `<DndContext>` has `key={...HmrGeneration}`. A failure here is a **Critical** finding (dev-mode regression that production users won't see but dogfooders will mistake for a real bug).
3. **Gather + measure the diff.** Run `git diff` and `git diff --staged` (each its own Bash call) to capture all changed files and hunks. If both are empty, emit "No changes to review." and stop. Then derive the size from `git diff --stat` and `git diff --staged --stat`: `changedFiles` = the deduped union of file paths across staged + unstaged; `changedLines` = total insertions + deletions.
4. **Size gate.** Compute `isSmall = changedFiles <= 8 && changedLines <= 400` (AND, so a 3-file / 900-line refactor still takes the heavy path).
5. **Dispatch:**
   - **`isSmall` (default - behavior identical to today):** delegate the single-pass review procedure below to **one fresh `Agent`** (the general-purpose agent; read-write in default mode, read-only in `review-only`). Pass it: the captured diff, `$ARGUMENTS`, and the pre-flight results from steps 1-2 (so it does not re-run them). The agent runs the **single-pass review procedure** end to end (read files -> analyze -> findings table -> Apply Phase -> Re-typecheck -> emit Output Format) and returns the finished report. The driver relays it. **No Workflow is spawned below threshold.**
   - **large (`!isSmall`):** invoke the **`Workflow`** Heavy Path (see "## Heavy Path"). It returns a **verified findings array**. The driver then folds in the pre-flight signals (step 1 type errors as Critical rows; a step 2 vitest failure as a Critical row with the assertion message verbatim), runs the existing **Apply Phase** over the findings (skip in `review-only`), runs **Re-typecheck** (skip in `review-only`; also re-run the step 2 vitest if an HMR fix landed), and emits the **Output Format**. The Heavy Path agents are read-only; only the driver mutates, so auto-fix-by-default is preserved.

### Single-pass review procedure (small path; also defines Apply + Output for both paths)

Whichever path runs, the review judgment is produced in a fresh context window that did not generate the code (see "Reviewer independence").

1. For each changed file, read the full file to understand the surrounding context.
2. Analyze every change against the criteria below and build the findings table.
3. **Apply Phase** (skip in `review-only` mode): for every finding, attempt the recommended fix using `Edit`/`Write`. Each fix is its own atomic unit - if one fails or is unsafe, skip it with a reason but keep the others. See "What gets auto-fixed" below.
4. **Re-typecheck** (skip in `review-only` mode): run `npm run typecheck` again. If a fix introduces a new type error, revert that specific edit and move the finding to `Skipped` with reason `"Fix introduced type error: <message>"`. Do not roll back unrelated fixes.
5. Emit the output format below.

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

After identifying changed files in Step 3 (Gather + measure the diff), read the relevant skill files to load domain context. Then apply the domain-specific checks below in addition to the general criteria.

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

## Heavy Path (large diffs)

Runs only when the size gate selects the heavy path (`changedFiles > 8` OR `changedLines > 400`). The driver invokes the in-session `Workflow` tool with the script below. **No `claude -p` or any headless `claude` shell invocation - ever.** Every finder and verifier is a **read-only** subagent in its own fresh context window; only the driver (main loop) mutates the working tree, in the existing Apply Phase. The Workflow returns a `findings[]` array whose objects map 1:1 onto the Findings Table columns, so the rest of the pipeline (Apply Phase, Re-typecheck, Output Format) is identical to the small path - the heavy-path findings table is indistinguishable from today's.

### Dimension finders

The universal finders always run. The domain finders are **gated by changed-file globs** - the same gates the Domain-Specific Checks section uses - and each delegates to its existing read-only auditor agent via `agentType` (the auditor already loads its own domain skill, so do not duplicate its checklist).

| Finder | `agentType` | Run | Gate (changed-file glob / hunk) |
|---|---|---|---|
| Correctness / Performance / Maintainability / Best-Practices+Conventions | none (general-purpose; seed with the matching Review Criteria slice, incl. the "no agent-specific code outside `adapters/`" rule, `any`, shorthand, external-parser fixture) | ALWAYS | - |
| Cross-file integration (signatures only) | none (general-purpose; special prompt below) | ALWAYS when `changedFiles > 1` | - |
| IPC consistency | `ipc-auditor` | GATED | `ipc-channels.ts`, `types.ts`, `preload.ts`, `src/main/ipc/handlers/**`, `tests/ui/mock-electron-api.js`, `src/renderer/stores/*-store.ts` |
| HMR parity | `hmr-parity` | GATED | `src/renderer/stores/**`, `src/renderer/utils/**`, `src/renderer/App.tsx`, or any hunk with `<DndContext`/`import.meta.hot`/a new top-level renderer `let` |
| Cross-platform | `platform-guard` | GATED | `src/main/pty/**`, `src/main/agent/**`, `src/main/git/**`, `shell-resolver.ts`, `command-builder.ts`, `worktree-manager.ts`, `paths.ts`, `useTerminal.ts`, or any hunk using `path.join`/`fs.rmSync`/`child_process`/an em-dash |
| Session/PTY lifecycle | `session-debugger` | GATED | `session-manager.ts`, `session-queue.ts`, `transition-engine.ts`, `tasks.ts` (handleTaskMove), `session-store.ts`, `TerminalPanel.tsx`, `TaskDetailDialog.tsx` |
| Migration/schema | `migration-safety` | GATED | `src/main/db/migrations.ts`, `src/main/db/repositories/**`, `src/shared/types.ts` (schema interfaces), `src/main/db/database.ts` |

**Explicit, falsifiable criteria (this is the point of splitting).** Each finder prompt must enumerate concrete, falsifiable criteria - never a vague lens like "review for performance." Embed the matching Review Criteria sub-bullets verbatim for the universal finders; the gated finders inherit their auditor's explicit checklist. Every finding must carry a specific `location` (`file:line`) and a concrete `recommendation`. **Correctness / Critical findings must supply the falsifiable triple:** `triggeringInput` (the specific input that triggers the failure), `codePath` (the failing path), and `testGap` (why existing tests miss it). A finding that cannot be stated falsifiably should not be raised.

**Cross-file integration pass - signatures only (stays cheap).** The single-file finders cannot see interactions. The driver computes a compact "diff interface delta" from `git diff` alone - **no file bodies** - and passes only that to the integration finder:

- `changedExports` - added/changed/removed exported signatures
- `typeDeltas` - interface/type member changes (e.g. a field becoming required)
- `newIpcChannels` - new channel constants in `ipc-channels.ts`
- `importChanges` - added/removed import edges between changed files
- `storeShapeMutations` - new/removed Zustand store fields

It answers questions the per-file finders structurally cannot: a new IPC channel constant with no handler/preload/mock layer touched (7-layer drift); `Task` gained a required field but no migration changed; an export's signature changed but a caller in another changed file still passes the old shape. Input is O(signatures) - a few hundred tokens regardless of diff size - so this pass is roughly constant cost and does not reintroduce long-context degradation.

### Workflow script

The driver passes this script to the `Workflow` tool. `gate(changedFiles, GLOBS, diffText)` returns true when any changed file matches a glob (or the diff text matches a hunk pattern). The prompt builders (`correctnessPrompt`, `ipcPrompt`, ...) embed the explicit criteria above.

```javascript
export const meta = {
  name: "code-review-heavy",
  description: "Parallel multi-dimension review for large diffs: gated finders + cross-file integration -> adversarial verification -> dedup",
  phases: ["finders", "verify", "synthesize"],
};

const findingSchema = {
  type: "object",
  required: ["severity", "category", "location", "finding", "recommendation"],
  properties: {
    severity: { enum: ["Critical", "High", "Medium", "Low"] },
    category: { enum: ["Correctness","Performance","Maintainability","Best Practices",
                        "Project Conventions","IPC","HMR","Cross-platform","Session","Migration","Integration"] },
    location: { type: "string" },          // file:line (matches the Findings Table)
    finding: { type: "string" },
    recommendation: { type: "string" },    // "**Must fix** - ..." phrasing
    autoFixable: { type: "boolean" },       // hint for the Apply Phase
    triggeringInput: { type: "string" },    // falsifiable triple (required for Correctness/Critical)
    codePath: { type: "string" },
    testGap: { type: "string" },
  },
};
const findingsSchema = { type: "object", required: ["findings"],
  properties: { findings: { type: "array", items: findingSchema } } };
const verdictSchema = { type: "object", required: ["verdict", "confidence", "reason"],
  properties: {
    verdict: { enum: ["confirmed", "refuted", "uncertain"] },
    confidence: { enum: ["high", "medium", "low"] },
    reason: { type: "string" },
    revisedSeverity: { enum: ["Critical","High","Medium","Low"] },
  },
};

// Inputs the driver passes in: diffText, changedFiles[], signatureDelta{}, ARGUMENTS
phase("finders");
const always = [
  () => agent(correctnessPrompt(diffText),     { label: "correctness",     phase: "finders", schema: findingsSchema }),
  () => agent(performancePrompt(diffText),      { label: "performance",     phase: "finders", schema: findingsSchema }),
  () => agent(maintainabilityPrompt(diffText),  { label: "maintainability", phase: "finders", schema: findingsSchema }),
  () => agent(conventionsPrompt(diffText),      { label: "conventions",     phase: "finders", schema: findingsSchema }),
];
const gated = [];
if (gate(changedFiles, IPC_GLOBS))             gated.push(() => agent(ipcPrompt(changedFiles),      { label: "ipc",       phase: "finders", agentType: "ipc-auditor",      schema: findingsSchema }));
if (gate(changedFiles, HMR_GLOBS, diffText))   gated.push(() => agent(hmrPrompt(changedFiles),       { label: "hmr",       phase: "finders", agentType: "hmr-parity",       schema: findingsSchema }));
if (gate(changedFiles, PLATFORM_GLOBS, diffText)) gated.push(() => agent(platformPrompt(changedFiles), { label: "platform", phase: "finders", agentType: "platform-guard",  schema: findingsSchema }));
if (gate(changedFiles, SESSION_GLOBS))         gated.push(() => agent(sessionPrompt(changedFiles),   { label: "session",   phase: "finders", agentType: "session-debugger", schema: findingsSchema }));
if (gate(changedFiles, MIGRATION_GLOBS))       gated.push(() => agent(migrationPrompt(changedFiles), { label: "migration", phase: "finders", agentType: "migration-safety", schema: findingsSchema }));
const integration = changedFiles.length > 1
  ? [() => agent(integrationPrompt(signatureDelta), { label: "integration", phase: "finders", schema: findingsSchema })]
  : [];

const finderResults = await parallel([...always, ...gated, ...integration]);  // barrier
const rawFindings = finderResults.filter(Boolean).flatMap((r) => r.findings);

phase("verify");  // one skeptic per finding; DEFAULTS TO REFUTING when uncertain
const verified = await parallel(rawFindings.map((f) => async () => {
  const v = await agent(skepticPrompt(f, diffText), { label: "verify", phase: "verify", schema: verdictSchema });
  if (!v || v.verdict === "refuted") return null;
  if (v.verdict === "uncertain" && v.confidence !== "high") return null;
  return v.revisedSeverity ? { ...f, severity: v.revisedSeverity } : f;
}));

phase("synthesize");  // dedup needs ALL survivors -> barrier
const deduped = await agent(dedupPrompt(verified.filter(Boolean)), { label: "dedup", phase: "synthesize", schema: findingsSchema });
return deduped.findings;  // -> driver runs the existing Apply Phase + Re-typecheck + Output Format
```

The skeptic prompt instructs each verifier to independently re-derive the finding from the diff and to **refute when uncertain** (reviewer independence). Dedup collapses the same issue surfaced by multiple dimensions (e.g. an `any` cast flagged by both `correctness` and `conventions`). If a finder agent fails, `parallel` resolves it to `null` and `.filter(Boolean)` drops it - the review completes on the surviving dimensions; note any dropped dimension in the Summary.

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
- Step 2 hmr-resync vitest FAILS -> the failure output is itself a Critical finding. Include the failing assertion's message verbatim in the findings table, attempt the auto-fix in the Apply Phase (e.g. add the missing store re-sync call to `App.tsx`, add the missing `key={hmrGeneration}` to the new `<DndContext>`, add a `// hmr-safe:` directive or `dispose` block to the new module-scope state), then re-run the vitest in addition to typecheck during the Re-typecheck step. If the test still fails after the fix attempt, mark Verdict as **Needs revision**.

### Review-only-mode footer

When `review-only` is in `$ARGUMENTS`, skip the Apply Phase and emit the legacy footer:

- **Files reviewed:** N
- **Findings:** N critical, N high, N medium, N low
- **Verdict:** one of:
  - **Ship it** - no findings, or only low-severity items
  - **Minor issues** - medium findings worth addressing, no blockers
  - **Needs revision** - critical or high-severity findings that should be resolved

## Allowed Tools

The driver uses `Bash` (git/npm/npx only) for pre-flight + diff measurement, `Agent` to delegate the small-path single-pass review, and `Workflow` to run the Heavy Path. It owns `Read`, `Edit`, `Write`, `Glob`, `Grep` for the Apply Phase. `review-only` mode performs no edits (the delegated agent and all Heavy Path agents stay read-only). Always run commands from the project root - no chained commands (`&&`, `||`, `|`, `;`).

**No headless `claude`.** All orchestration is in-session via `Agent` and `Workflow`. Never invoke `claude -p`, `claude --print`, `git diff | claude ...`, or any other headless `claude` shell pipeline.

**CRITICAL: Use `git -C <path>` for all git commands in other directories.** Never use `cd <path> && git ...` - the `cd && git` pattern triggers an unbypasable Claude Code security prompt.

**Do not commit.** The skill applies fixes to the working tree only. The user runs `/merge-back` to commit and push.
