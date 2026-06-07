---
description: Run tests, audit coverage, or write missing tests
allowed-tools: Read, Glob, Grep, Task, Workflow, Bash(npm:*), Bash(npx:*), Bash(git:*)
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

After all tests complete and results are reported, analyze changed files for coverage gaps. Do not attempt to classify or recommend tests independently - that is `test-builder`'s job.

**Size gate first.** If this change is **sprawling** - the Layer 4 mixed-domain signal tripped (`distinctOverrides >= 3` OR `totalSourceFiles >= 5`) - run the **Heavy Path** audit fan-out (see "## Heavy Path", phases 1-2: parallel per-tier auditors -> dedup + adversarial gap verification) and relay its consolidated, verified Coverage Gaps report. Otherwise (the common case), **launch a single `test-builder` agent** exactly as below.

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

Audit coverage without running tests. Do not attempt any classification or recommendation yourself - that is `test-builder`'s job.

1. Gather context locally:
   - `git diff --staged`
   - `git diff`
   - `git status`
2. **Size gate.** Count changed source files (`src/**`, excluding `tests/`, `docs/`, `.claude/`, config). If the change is **sprawling** (`changedSourceFiles >= 5`, the same mixed-domain signal), run the **Heavy Path** audit fan-out (see "## Heavy Path", phases 1-2) and relay its consolidated, verified Coverage Gaps report. Otherwise **launch a single `test-builder` agent in audit-only mode** with:
   - `subagent_type: "test-builder"`
   - `description: "Coverage audit for current changes"`
   - `prompt`: include the full git diff output and an explicit instruction: **"Audit-only mode. Read each changed file, apply your tier decision tree, and return the standard Coverage Gaps report. Do NOT write, modify, or validate any tests."**
3. Relay the report verbatim.

---

## Mode: Write Tests (`/test write`)

**Audit AND implement the missing tests via the `test-builder` agent.** This skill does not write tests inline.

1. Gather context locally:
   - `git diff --staged`
   - `git diff`
   - `git status`
2. **Size gate.** Count changed source files (`src/**`, excluding `tests/`, `docs/`, `.claude/`, config). If the change is **sprawling** (`changedSourceFiles >= 5`), run the **Heavy Path** (see "## Heavy Path", phases 1-3: parallel per-tier auditors -> dedup + adversarial gap verification -> serial `test-builder` write, with red-green enforced inside the write phase). Otherwise **launch a single `test-builder` agent** with:
   - `subagent_type: "test-builder"`
   - `description: "Write missing tests for current changes"`
   - `prompt`: include the full git diff output, any extra arguments the user passed to `/test write`, and an explicit instruction: **"Write mode. Audit coverage, then implement the missing tests following your tier rules, anti-flake patterns, and the 10-second E2E gate. Derive expected behavior from the task/PR intent, not the implementation, and red-green verify each new test (it must fail for the right reason), then validate with multi-run stability checks. Report back with: tier chosen per file, files modified, helpers reused vs added, red-green result and stability run count, and any anti-patterns you noticed in neighboring tests."**
3. When the agent (or Heavy Path) returns, relay its summary. If any gaps remain (e.g. a test could not be written due to missing mock support or ambiguous requirements), flag them clearly so the user can resolve and retry.

---

## Heavy Path (sprawling changes)

The coverage **audit** and **write** operations normally run as a single `test-builder` pass. On a **sprawling change** they auto-scale to an in-session `Workflow` fan-out, so no single context has to audit every changed surface at once (the same "lost in the middle" failure a single-pass review hits on a large diff). Test **execution** never fans out - running tests is deterministic, so the run modes above are unchanged.

**Size gate:** reuse `/test`'s own mixed-domain signal. A change is sprawling when `distinctOverrides >= 3` OR the changed source-file count hits the mixed-domain threshold (`>= 5`, Layer 4's `mixedDomainThreshold`). Smart Run knows this from Step 2; `/test audit` and `/test write` evaluate it from their own `git diff` (count `src/**` files, excluding tests/docs/config). Below the gate: the single `test-builder` pass, exactly as today. At or above it: the Heavy Path.

**Hard rule:** orchestrate only in-session via the `Workflow` tool and `test-builder` subagents. **Never** use `claude -p` or any headless `claude` shell invocation.

### Phases

1. **Audit fan-out (read-only, parallel) - phase `audit`.** Instead of one `test-builder` audit pass, spawn parallel coverage auditors grouped by tier (Unit / UI / E2E), each in `agentType: "test-builder"` audit-only mode (so the tier decision tree and anti-flake catalogue are not duplicated here) against its slice, applying explicit, **falsifiable** gap criteria:
   - a changed exported function or new branch / early-return with no covering assertion = gap;
   - a new IPC channel with no `tests/ui/mock-electron-api.js` entry exercised by a UI test = gap;
   - an external-input parser (`JSON.parse` of file/IPC/stdout that dispatches on string-literal fields) with no real-shape fixture = gap (the `codex-rollout` pattern);
   - a new user-facing flow with no UI-tier assertion = gap.
   Each returns the standard Coverage Gaps rows (`{file, whatToTest, tier, existingCoverage}`).
2. **Dedup + adversarial gap verification - phase `verify`.** Dedup gaps across auditors (plain code, needs all audits -> barrier). A skeptic per gap confirms the gap is **real** (genuinely unexercised, not already covered by a sibling or unit test) and **worth a test** under the 10-second-E2E rule and the "wasteful E2E tests are not the goal" philosophy. The skeptic **defaults to "already covered / not worth it" when uncertain** - conservative on purpose, matching test-builder's delete-aggressively, never-double-cover stance.
3. **Write (write mode only, serial) - phase `write`.** Hand the verified gap list to `test-builder` in write mode. **Writing stays serial through one `test-builder`** - it owns the tier rules, anti-flake patterns, shared-file edits (`tests/ui/mock-electron-api.js`, `tests/e2e/helpers.ts`), and suite-wide validation; parallel writers would conflict on those shared files. The fan-out is for the read-only audit + verification, not the mutation. The **red-green guard** (each new test must fail for the right reason, with expected behavior derived from the task/PR intent rather than the implementation) is enforced by `test-builder` inside this phase - see its red-green + spec-derived-expectation rules. Today's stability runs catch flake; red-green catches self-review bias.

`/test audit` and Smart Run Step 5 run phases 1-2 (return the consolidated, verified Coverage Gaps report). `/test write` runs phases 1-3.

### Workflow script

The driver passes this script to the `Workflow` tool. It **inlines** the gathered context (changed files, diff, test results, write-mode flag) as literal `const`s when authoring the script, or reads them **defensively** from `args` as shown below - never a bare injected global. `auditPromptForTier`, `gapSkepticPrompt`, and `writePrompt` embed the criteria above; `dedupeGaps` is plain JS.

```javascript
export const meta = {
  name: "test-coverage-heavy",
  description: "Parallel coverage audit for sprawling changes: per-tier auditors -> dedup + adversarial gap verification (-> serial write + red-green)",
  phases: ["audit", "verify", "write"],
};

const gapSchema = {
  type: "object",
  required: ["file", "whatToTest", "tier"],
  properties: {
    file: { type: "string" },
    whatToTest: { type: "string" },
    tier: { enum: ["Unit", "UI", "E2E"] },
    existingCoverage: { type: "string" },
  },
};
const gapsSchema = { type: "object", required: ["gaps"],
  properties: { gaps: { type: "array", items: gapSchema } } };
const gapVerdictSchema = { type: "object", required: ["worthTesting", "confidence", "reason"],
  properties: {
    worthTesting: { type: "boolean" },   // false when already covered / not worth a (esp. E2E) test
    confidence: { enum: ["high", "medium", "low"] },
    reason: { type: "string" },
  },
};

// --- Inputs (defensive: a dynamic workflow must NEVER fail on input plumbing) ---
// PREFER inlining the driver-gathered context as literal consts when authoring this
// script (deterministic, the pattern that survives). A structured object passed via the
// Workflow `args` input does NOT reliably reach the script's `args` global, and a
// top-level `args.foo.join(...)` throws BEFORE any phase runs, failing the whole run.
// So never call a method on an injected field at top level: read `args` only behind a
// guard, default every field, and bail soft when there is nothing to audit.
const input = (typeof args === "object" && args !== null) ? args : {};
const changedFiles = Array.isArray(input.changedFiles) ? input.changedFiles : [];
const diffText = typeof input.diffText === "string" ? input.diffText : "";
const testResults = typeof input.testResults === "string" ? input.testResults : "";
const writeMode = input.writeMode === true;
if (changedFiles.length === 0 && diffText === "") {
  log("test-coverage-heavy: no changed files or diff to audit; returning no gaps.");
  return { gaps: [] };
}

phase("audit");
const TIERS = ["Unit", "UI", "E2E"];
// Model selection (see "## Rules"): auditors, skeptics, and the writer run on Sonnet, not
// the session's top-tier model. Test authoring and gap judgment are well within Sonnet's
// range; the saving compounds across per-tier auditors plus one skeptic per gap.
const audits = await parallel(TIERS.map((tier) => () =>
  agent(auditPromptForTier(tier, diffText, changedFiles), {
    label: `audit:${tier}`, phase: "audit", agentType: "test-builder", model: "sonnet", schema: gapsSchema,
  })
));
const rawGaps = dedupeGaps(audits.filter(Boolean).flatMap((a) => a.gaps));  // barrier: needs all audits

phase("verify");  // one skeptic per gap; DEFAULTS to "not worth it" when uncertain
const verified = await parallel(rawGaps.map((g) => async () => {
  const v = await agent(gapSkepticPrompt(g, diffText), { label: "verify", phase: "verify", model: "sonnet", schema: gapVerdictSchema });
  if (!v || !v.worthTesting) return null;
  if (v.confidence === "low") return null;
  return g;
}));
const gaps = verified.filter(Boolean);

if (!writeMode) return { gaps };   // /test audit + Smart Run Step 5 stop here

phase("write");  // SERIAL through one test-builder: owns shared-file edits, red-green, suite validation
const writeReport = await agent(writePrompt(gaps, diffText), {
  label: "write", phase: "write", agentType: "test-builder", model: "sonnet",
});
return { gaps, writeReport };
```

If a tier auditor fails, `parallel` resolves it to `null` and `.filter(Boolean)` drops it; the audit completes on the surviving tiers (note any dropped tier in the report). The driver relays `gaps` as the Coverage Gaps report (and, in write mode, `writeReport` as the write summary).

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

- **Model selection.** The `test-builder` agent and the Heavy Path fan-out run on **Sonnet** (`model: sonnet` in `.claude/agents/test-builder.md` frontmatter and in the workflow `agent()` calls), not the session's top-tier model. Test authoring, gap auditing, and the skeptic verification are well within Sonnet's range, and the saving compounds across per-tier auditors plus one skeptic per gap. Run `/test` at medium reasoning effort. Test **execution** is model-independent. For a no-expense-spared pass on genuinely hard test design, override the spawn with `model: opus`.
- **Test implementation is delegated to the `test-builder` agent.** This skill runs tests and presents results. It does not write tests inline. The only exception is trivial, single-line additions to *existing* passing tests (e.g. an extra `expect` assertion in a stable spec). Any new file, new describe block, or >3-line change MUST go through the agent so the tier rules, anti-flake patterns, and 10-second gate are applied consistently.
- **Coverage gap analysis is delegated to the `test-builder` agent.** In Smart Run Step 5 and in `/test audit` mode, the skill's job is to gather git diff context and pass it to the agent. The skill does not duplicate the agent's tier decision tree.
- **No chained commands.** Do not use `&&`, `||`, `|`, `;`, or stderr redirection. Each command runs in its own Bash tool call.
- **No `cd && git`.** Never use `cd <path> && git ...` - this triggers an unbypassable Claude Code security prompt. All git commands run from the current working directory (which is already the correct repo/worktree). If you must target a different directory, use `git -C <path>`.
- **Parallel execution.** Launch independent tiers concurrently using parallel tool calls or background tasks. Unit and UI tests never depend on the build step.
- **Build only when needed.** Only run `npm run build` when E2E tests are selected.
- **Typecheck is a gate.** Always typecheck first. If it fails, stop immediately.
- **Domain map is best-effort, not a safety contract.** CI runs the full suite as the backstop. If you suspect a missed mapping, run `/test broad` or `/test all`.
- **A dynamic workflow must never fail on input plumbing.** The Heavy Path script must not perform top-level work that can throw on missing or misshaped input - that aborts the whole run before any phase executes (a structured object passed via the `Workflow` `args` input does not reliably reach the script's `args` global, so a top-level `args.foo.join(...)` throws). Inline the driver-gathered context as literal `const`s, or read `args` only behind a `typeof`/`Array.isArray` guard with a default for every field, and `log()` + early-`return { gaps: [] }` when there is nothing to audit. A coverage audit is advisory; it degrades to "no gaps", it never crashes the run.
- **Use dedicated tools.** Use `Read`, `Glob`, `Grep` for file operations. Reserve `Bash` for `npm`, `npx`, and `git` commands only.

## Allowed Tools

- `Read`, `Glob`, `Grep` - for file exploration (changed-file detection, domain map loading, spec filesystem expansion)
- `Bash` - for `npm`, `npx`, and `git` commands only
- `Task` - for delegating to the `test-builder` agent in audit / write / Smart Run Step 5 modes (small-change default)
- `Workflow` - for the Heavy Path fan-out on sprawling changes (parallel per-tier auditors + adversarial gap verification + serial write). Orchestrate only in-session - **never** `claude -p` or any headless `claude` shell invocation.
