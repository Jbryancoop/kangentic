---
description: Run tests, audit coverage, or write missing tests
allowed-tools: Read, Glob, Grep, Task, Bash(npm:*), Bash(npx:*), Bash(git:*)
argument-hint: [all|broad|audit|write|unit|ui|e2e|verify-map]
---

# Test - Unified Smart Test Runner

Thin driver for test execution and coverage audit. **The skill runs tests
directly but delegates all test-writing and coverage analysis to the
`test-builder` agent** (`.claude/agents/test-builder.md`). The agent is the
single source of truth for tier classification, anti-flake patterns, the
10-second E2E rule, and canonical helpers - this skill does not re-implement
any of that knowledge inline.

**Usage:** `/test [mode]`

| Argument | Mode | Description |
|----------|------|-------------|
| *(none)* | **Smart Run** | Detect branch, select affected tests via import-graph + small static map, typecheck, build (if needed), run, then delegate coverage-gap analysis to `test-builder` |
| `all` | **Full Run** | Run all 3 tiers unconditionally |
| `broad` | **Broad Run** | Skip the affected-test selection - use today's whole-tier mapping. Escape hatch when the domain map is suspected stale. |
| `audit` | **Coverage Audit** | Delegate to `test-builder` agent in audit-only mode - no test execution |
| `write` | **Write Tests** | Delegate to `test-builder` agent to audit and implement missing tests |
| `unit` | **Unit Only** | Run unit tests only |
| `ui` | **UI Only** | Run UI tests only |
| `e2e` | **E2E Only** | Build + run E2E tests only |
| `verify-map` | **Verify Map** | Audit `test-domain-map.jsonc` for orphan specs and unmapped source dirs. No tests executed. |

**Selected mode:** $ARGUMENTS

---

## Mode: Smart Run (`/test`)

Affected-test selection runs in four layers. Layers 2 + 4 are zero-maintenance (the import graph self-updates). Layers 1 + 3 are a small static config in `.claude/skills/test/test-domain-map.jsonc` that mostly self-resolves via filename conventions.

### Step 1 - Detect branch and changed files

All git commands below run from the **current working directory** (no `cd` needed). If the CWD is already a worktree, git will operate on it automatically.

1. Run `git rev-parse --abbrev-ref HEAD` to get the current branch.
2. If the branch is `main`, treat as **Full Run** (all tiers, no selection).
3. Otherwise, determine the base branch:
   - Run `git config kangentic.baseBranch` to get the stored base branch.
   - If not set, default to `main`.
4. Collect changed files (union of all three):
   - `git diff --name-only <base>...HEAD` (committed changes on branch)
   - `git diff --name-only` (unstaged changes)
   - `git diff --name-only --staged` (staged changes)

### Step 2 - Apply the 4-layer selection algorithm

Read `.claude/skills/test/test-domain-map.jsonc`. Comments are stripped at parse time (Claude reads the file as JSONC; this is a markdown reading task, not an actual JSON.parse).

#### Layer 1 - Tripwires (short-circuit)

If any changed file matches any glob in `tripwires`, the change touches globally-imported infrastructure. Run **all three tiers** in full (typecheck → build → unit + ui + e2e). Skip the rest of this algorithm.

#### Layer 2 - Import-graph filters (zero-maintenance)

These are commands the skill runs directly. They use Vitest's and Playwright's built-in graph analysis:

- **Unit:** `npx vitest related --run <changed source files> tests/unit/`
  - The trailing `tests/unit/` is a positional path filter that excludes `tests/integration/` from the run (mirrors `npm run test:unit` behavior).
  - Pass only `src/**`, `src/preload/**`, `src/shared/**` (non-tripwire) files. Drop test files and docs.
- **UI:** include `--only-changed=<base>` in the playwright invocation (Step 4 below).
- **E2E:** include `--only-changed=<base>` in the playwright invocation (Step 4 below).

Vitest `--related` and Playwright `--only-changed` together cover changes the import graph can see (helpers, utility modules, anything specs import directly). They miss backend code that no spec imports - Layer 3 fills that gap.

#### Layer 3 - Backend-impact + conventions + alwaysInclude

For each changed file in `sourceFiles ∪ fixtureFiles`:

**3a. backendOverrides:** for each entry whose `match` glob matches the file, expand its `specGlobs` against the actual filesystem (use the `Glob` tool) and add the resolved spec paths to the per-tier selection.

**3b. conventions:** for each rule in `conventions.fromPathSegment` whose `match` template fits (e.g. `src/main/agent/adapters/<name>/**` extracts `name=claude` from `src/main/agent/adapters/claude/foo.ts`), glob the filesystem for `tests/ui/<name>*.spec.ts`, `tests/ui/<name>.spec.ts`, `tests/e2e/<name>*.spec.ts`, and `tests/e2e/<name>.spec.ts`. Add resolved spec paths to the selection.

**3c. broadenOnUnmapped:** if a source file matched **no** override and **no** convention, look it up in `broadenOnUnmapped`. If it falls under `src/main/**` → mark e2e for broad fallback. `src/preload/**` → e2e. `src/renderer/**` → ui. Log the broaden reason in the Test Plan: `"no override or convention match for <file> → broadening to full <tier> (consider adding an override)"`.

**3d. alwaysInclude:** for each glob in `alwaysInclude` that matches a changed file, add the listed test files to the per-tier selection regardless of import-graph reachability.

#### Layer 4 - Mixed-domain fallback

After Layer 3, count how many distinct `backendOverrides` entries matched. If `distinctOverrides ≥ 3` OR `totalSourceFiles ≥ 5`, broaden any tier that has any selection to its full set. The change is too sprawling for curated subsets to be meaningful; safer to run the whole tier.

### Step 3 - Plan summary

Print before executing:

```
### Test Plan

Branch: <branch> | Base: <base> | Changed: N files (M src, K test)

| Tier | Selection                                          | Why                          |
|------|----------------------------------------------------|------------------------------|
| Unit | <N> source files via vitest --related              | direct                       |
| UI   | --only-changed=<base> + 2 specs from override      | renderer + activity override |
| E2E  | --only-changed=<base> + 8 activity-detection specs | event-bridge override        |

Tripwires: none.
Build will run: yes (E2E selected).
Mixed-domain fallback: no.
```

**Display rules:**
- **Unit:** `<N> source files via vitest --related` (resolved test count comes after, in Test Results).
- **UI / E2E:** show whether `--only-changed=<base>` is in play. List up to 3 explicit specs by basename; collapse the tail to `+N more`.
- **Full-tier (broad / tripwire / mixed-domain):** `all <N> specs (<reason>)` - count specs via `Glob` against `tests/{ui,e2e}/*.spec.ts`.
- **Tripwires line:** list any tripwire patterns that matched, or `none`.
- **Build line:** `yes (E2E selected)` or `no`.
- **Mixed-domain line:** `yes (<N> overrides matched, <M> source files)` or `no`.
- If `broadenOnUnmapped` fired, print one line per source file that triggered it, so the user can spot stale-map signals.

Proceed immediately - no need to wait for confirmation.

### Step 4 - Execute

1. **Typecheck first** - run `npm run typecheck`. If it fails, report and **stop**. Do not proceed.
2. Launch tiers in parallel, respecting dependencies. Each command runs in its own Bash tool call (no `&&`, no `;`, no piping):
   - **Unit:**
     - If only changed-test files: `npx vitest run <test-files>`
     - If only source files: `npx vitest related --run <source-files> tests/unit/`
     - If both: run two separate vitest invocations and report combined results.
     - If neither: skip unit tier.
   - **UI:**
     - If broad fallback: `npx playwright test --project=ui`
     - Else with explicit subset: `npx playwright test <ui-specs> --only-changed=<base> --project=ui`
     - Else: `npx playwright test --only-changed=<base> --project=ui`
   - **Build** (`npm run build`): start immediately, but **only if E2E is in the selected tiers**.
   - **E2E** (after build):
     - If broad fallback: `npx playwright test --project=electron`
     - Else with explicit subset: `npx playwright test <e2e-specs> --only-changed=<base> --project=electron`
     - Else: `npx playwright test --only-changed=<base> --project=electron`
3. If only unit and/or UI are selected, skip the build entirely.

> **Compatibility note:** `--only-changed=<base>` was added in Playwright 1.46. Kangentic uses 1.59+. If a future bump changes `--only-changed`'s semantics, fall back to running two playwright invocations and union-ing the results.

### Step 5 - Coverage gap analysis (delegate to agent)

After all tests complete and results are reported, **launch the `test-builder` agent** to analyze changed files for coverage gaps. Do not attempt to classify or recommend tests independently - that is the agent's job.

Launch the agent with:

- `subagent_type: "test-builder"`
- `description: "Audit coverage gaps for current changes"`
- `prompt`: include (a) the list of changed files from Step 1, (b) the current test results summary (pass/fail counts per tier), and (c) an explicit instruction: **"Audit-only mode. Do NOT write any tests. Return the standard Coverage Gaps report."**

Relay the agent's Coverage Gaps report verbatim to the user. If there are gaps, end the response with:

> Run `/test write` to spawn the `test-builder` agent and implement these.

If the agent reports no gaps, output: `No coverage gaps - all changes are tested or trivial.`

---

## Mode: Full Run (`/test all`)

Same as Smart Run but with all three tiers selected unconditionally. Always typecheck → build → run all three tiers. Then run the Step 5 coverage-gap delegation.

---

## Mode: Broad Run (`/test broad`)

Escape hatch for when the domain map is suspected stale. Uses the **previous whole-tier mapping** instead of the 4-layer algorithm:

| Changed file pattern | Tiers to run |
|---|---|
| `tests/unit/**` | unit |
| `tests/ui/**` | ui |
| `tests/e2e/**` | e2e |
| `src/main/**` | e2e |
| `src/preload/**` | e2e |
| `src/renderer/components/terminal/**`, `src/renderer/hooks/useTerminal*.ts`, `src/renderer/stores/session-store.ts` | ui + e2e |
| `src/renderer/**` (other) | ui |
| `src/shared/**` | grep imports → matching tier(s) |
| `package.json`, `tsconfig*.json`, `vite.*.ts`, `playwright.config.ts`, `vitest.config.ts`, `electron-builder.yml`, `scripts/**` | unit + ui + e2e |
| `.claude/**`, `*.md`, `.gitignore` | none |

Then typecheck → build → run selected tiers in full (no `--only-changed`, no per-spec subsetting). Step 5 coverage-gap delegation runs as normal.

---

## Mode: Unit Only (`/test unit`)

1. Run `npm run typecheck`. Stop on failure.
2. Run `npm run test:unit`.

## Mode: UI Only (`/test ui`)

1. Run `npm run typecheck`. Stop on failure.
2. Run `npx playwright test --project=ui`.

## Mode: E2E Only (`/test e2e`)

1. Run `npm run typecheck`. Stop on failure.
2. Run `npm run build`.
3. Run `npx playwright test --project=electron`.

---

## Mode: Coverage Audit (`/test audit`)

**Launch the `test-builder` agent in audit-only mode.** Do not run any tests, and do not attempt any classification or recommendation yourself.

1. Gather context locally:
   - `git diff --staged`
   - `git diff`
   - `git status`
2. Launch the agent with:
   - `subagent_type: "test-builder"`
   - `description: "Coverage audit for current changes"`
   - `prompt`: include the full git diff output and an explicit instruction: **"Audit-only mode. Read each changed file, apply your tier decision tree, and return the standard Coverage Gaps report. Do NOT write, modify, or validate any tests."**
3. Relay the agent's report verbatim.

---

## Mode: Write Tests (`/test write`)

**Launch the `test-builder` agent to audit AND implement the missing tests.** This skill does not write tests inline.

1. Gather context locally:
   - `git diff --staged`
   - `git diff`
   - `git status`
2. Launch the agent with:
   - `subagent_type: "test-builder"`
   - `description: "Write missing tests for current changes"`
   - `prompt`: include the full git diff output, any extra arguments the user passed to `/test write`, and an explicit instruction: **"Write mode. Audit coverage, then implement the missing tests following your tier rules, anti-flake patterns, and the 10-second E2E gate. Validate with multi-run stability checks. Report back with: tier chosen per file, files modified, helpers reused vs added, stability run count, and any anti-patterns you noticed in neighboring tests."**
3. When the agent returns, relay its summary. If any gaps remain (e.g. the agent could not write a test due to missing mock support or ambiguous requirements), flag them clearly so the user can resolve and retry.

---

## Mode: Verify Map (`/test verify-map`)

Audit `.claude/skills/test/test-domain-map.jsonc` against the actual filesystem. Surfaces drift before it causes silent miss-coverage.

1. Glob all specs: `tests/ui/*.spec.ts`, `tests/e2e/*.spec.ts`. Build the spec inventory.
2. **Orphan check:** for each spec, attempt reverse-mapping. Try every backendOverride, every convention rule, and every `alwaysInclude` entry. If no realistic source-path change would select this spec, it's an orphan candidate. Causes:
   - Spec was renamed off-convention (keyword no longer at filename prefix).
   - Spec exercises a subsystem that has no override entry yet.
3. **Unmapped source-dir check:** Glob top-level subdirs under `src/main/`, `src/renderer/components/`, `src/main/agent/adapters/`, `src/main/boards/adapters/`, `src/main/ipc/handlers/`. For each, predict the selection a representative file change would produce. If the prediction is `broadenOnUnmapped` (i.e. broad fallback every time), flag for a possible override entry.
4. **Tripwire sanity:** confirm every tripwire glob resolves to at least one real file. Stale tripwire entries are harmless but cluttered.
5. Report findings as a table:

```
### Domain Map Audit

| Concern | Item | Suggestion |
|---------|------|------------|
| Orphan spec | tests/e2e/foo-bar.spec.ts | No realistic source change selects this. Rename to follow `<keyword>-*.spec.ts` or add a backendOverride entry. |
| Unmapped dir | src/main/notifications/ | A change here would broaden to full e2e. Consider adding an override. |
| Stale tripwire | src/main/old-shutdown.ts | File no longer exists. Remove from tripwires. |
```

Do not modify the map automatically - surfacing the drift is the deliverable.

---

## Reporting Format (for test RUN modes only)

After test execution, present results in this format. **Never use emojis** - they render as broken boxes in the terminal. Use plain text only.

```
## Test Results

Branch: <branch-name> | Base: <base-branch> | Changed: N files (M src, K test)
Selected:
  Unit:  6 source files via vitest --related (resolved to 8 tests)
  UI:    --only-changed=main + 2 specs (board-config, drag-and-drop)
  E2E:   skipped (no main process changes)

| Tier | Status  | Passed | Failed | Duration |
|------|---------|--------|--------|----------|
| Unit | PASS    | 8      | 0      | 3.9s     |
| UI   | PASS    | 5      | 0      | 4.2s     |
| E2E  | skipped | -      | -      | -        |

All green. No regressions.
```

**Rules for the table:**
- Only include tiers that were selected or explicitly skipped. Use `PASS`, `FAIL`, or `skipped` in the Status column - never emojis.
- Skipped tiers show `-` for numeric columns.
- Omit the Skipped count column (Playwright skips are rare and noisy).
- The Passed count comes from the runner's stdout summary (`Test Files  N passed (N)` from vitest, `N passed (Xs)` from playwright).
- If all tiers pass, end with: `All green. No regressions.`

**On failures, add after the table:**

```
### Failures

1. tests/ui/app.spec.ts:42 - "can create a task in Backlog"
   Error: expected 'visible' but got 'hidden'
   Likely cause: TaskCard render change in src/renderer/components/TaskCard.tsx

### Recommendations
- Investigate <file> - <what the error indicates>
```

### Map drift signals + auto verify-map

Track during Step 2 selection:
- Each `broadenOnUnmapped` hit (a `src/**` file matched no tripwire, no override, and no convention rule, so the algorithm broadened to a full tier).
- Whether the `mixedDomainThreshold` was tripped (3+ overrides or 5+ source files). Note: this is a sprawl signal, not a drift signal.

**Why only `broadenOnUnmapped` counts as drift:** convention rules can match a file path template (e.g. extract `name=dialogs` from `src/renderer/components/dialogs/Foo.tsx`) and then glob zero specs because the test naming for that area doesn't follow the `<name>-*` prefix. That's a known limitation of the convention rules, not stale-map drift - using it as a signal would fire on routine renderer changes and pollute the output. The `broadenOnUnmapped` fallback is the authoritative signal that a path is genuinely uncovered by the map.

**Auto-trigger:** if `broadenOnUnmapped` fired at least once during selection, automatically run the verify-map analysis (`/test verify-map` mode logic) inline as part of this run. No re-invocation needed; do it before printing the final summary.

If `broadenOnUnmapped` did not fire, **skip** the auto verify-map (don't run audits when there's no signal - that's noise). Print `Map drift: none.` after the all-green line (passing run) or after the Recommendations section (failing run).

If drift signals fired, append two sections after the results table (and after the Failures + Recommendations sections, if any):

```
### Map drift signals (2)

- broadenOnUnmapped: src/main/updater.ts -> full e2e tier (no override or convention match)
- broadenOnUnmapped: src/main/analytics/aggregator.ts -> full e2e tier

### Map audit (auto-triggered by drift signals)

| Concern | Item | Suggestion |
|---------|------|------------|
| Unmapped dir | src/main/analytics/ | A change here broadens to full e2e. Add a backendOverrides entry or rename a spec to follow `analytics-*` convention. |
| Orphan spec | tests/e2e/legacy-foo.spec.ts | No realistic source change selects this. Rename to follow convention or add an override. |
| Stale tripwire | src/main/old-init.ts | File no longer exists. Remove from tripwires. |

To resolve: edit .claude/skills/test/test-domain-map.jsonc per suggestions above.
```

The audit reuses the `/test verify-map` algorithm (orphan check, unmapped-dir check, stale-tripwire check). It runs against the actual filesystem state at end-of-run rather than as a standalone invocation, so drift is addressable in-the-moment.

---

## Maintenance contract for `test-domain-map.jsonc`

The map self-maintains for the common cases. It needs human attention only when:

- **Tripwires:** a new globally-imported infra file appears (rare - once a quarter at most). Add to the `tripwires` array.
- **Cross-cutting non-conforming subsystem:** a new feature ships where the source dirname doesn't match the test naming prefix (e.g. `src/main/agent/event-bridge.js` → `*-activity-detection`). Add a `backendOverrides` entry.
- **Naming convention erosion:** if a test is renamed so that the source-dir keyword is no longer at the filename prefix, either rename it back (preferred) or add an override.

**You do NOT need to edit the map for:**
- New agent adapters (`src/main/agent/adapters/<name>/`) - convention auto-resolves.
- New IPC handlers (`src/main/ipc/handlers/<name>.ts`) - convention auto-resolves.
- New renderer component subdirs (`src/renderer/components/<name>/`) - convention auto-resolves.
- New mock binaries (`tests/fixtures/mock-<name>*`) - convention auto-resolves.
- New unit tests - vitest `--related` finds them via the import graph.
- New UI/E2E specs - playwright `--only-changed` finds them when they're modified or when they import changed files.

When `broadenOnUnmapped` fires repeatedly for the same source path, that's the signal to consider promoting it to a `backendOverrides` entry.

---

## Rules

- **Test implementation is delegated to the `test-builder` agent.** This skill runs tests and presents results. It does not write tests inline. The only exception is trivial, single-line additions to *existing* passing tests (e.g. an extra `expect` assertion in a stable spec). Any new file, new describe block, or >3-line change MUST go through the agent so the tier rules, anti-flake patterns, and 10-second gate are applied consistently.
- **Coverage gap analysis is delegated to the `test-builder` agent.** In Smart Run Step 5 and in `/test audit` mode, the skill's job is to gather git diff context and pass it to the agent. The skill does not duplicate the agent's tier decision tree.
- **No chained commands.** Do not use `&&`, `||`, `|`, `;`, or stderr redirection. Each command runs in its own Bash tool call.
- **No `cd && git`.** Never use `cd <path> && git ...` - this triggers an unbypassable Claude Code security prompt. All git commands run from the current working directory (which is already the correct repo/worktree). If you must target a different directory, use `git -C <path>`.
- **Parallel execution.** Launch independent tiers concurrently using parallel tool calls or background tasks. Unit and UI tests never depend on the build step.
- **Build only when needed.** Only run `npm run build` when E2E tests are selected.
- **Typecheck is a gate.** Always typecheck first. If it fails, stop immediately.
- **Domain map is best-effort, not a safety contract.** CI runs the full suite as the backstop. If you suspect a missed mapping, run `/test broad` or `/test all`.
- **Use dedicated tools.** Use `Read`, `Glob`, `Grep` for file operations. Reserve `Bash` for `npm`, `npx`, and `git` commands only.

## Allowed Tools

- `Read`, `Glob`, `Grep` - for file exploration (changed-file detection, domain map loading, spec filesystem expansion)
- `Bash` - for `npm`, `npx`, and `git` commands only
- `Task` - for delegating to the `test-builder` agent in audit / write / Smart Run Step 5 modes
