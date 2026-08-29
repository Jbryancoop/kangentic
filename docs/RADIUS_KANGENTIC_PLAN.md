# Radius Kangentic Agent Command Center Plan

Date: 2026-08-29

## Decision

Adopt Kangentic as the first Radius agent command center. Start with NAUMS CMS, prove the workflow on real work, then add additional projects.

Use GitHub Codespaces as the cloud development environment for this fork. Kangentic remains a desktop Electron application for the board UI in phase 1; Codespaces handles source editing, builds, tests, and pull requests.

## Architecture

- `Jbryancoop/kangentic` — Radius-maintained Kangentic fork. Keep changes small and upstream-friendly.
- `Radius-Group-Systems/naumsCMS` — first managed project. Its board workflow belongs in a committed `kangentic.json` at repo root.
- Future Radius intake service — email intake, routing, deduplication, cross-project policy, and 24/7 automation. Keep this outside Kangentic core when practical.

## License boundary

Kangentic is AGPL-3.0-only. Treat modifications to this fork as AGPL work. Avoid putting proprietary Radius business logic, customer-specific routing, credentials, or private orchestration into this repository. Prefer a separate integration service that communicates through GitHub and supported Kangentic integration surfaces.

## Phase 0 — Baseline the fork

1. Keep `main` synchronized with `Kangentic/kangentic` upstream.
2. Avoid rebranding or broad product changes until the NAUMS pilot proves the workflow.
3. Record the upstream baseline before Radius-specific modifications.
4. Run the untouched upstream gates before substantive changes:
   - `npm run typecheck`
   - `npm run lint`
   - `npm run test:unit`
   - relevant Playwright/Electron tests

Acceptance: dependency install and baseline gates pass in a clean environment.

## Phase 1 — Cloud development

Use `.devcontainer/` in this fork for GitHub Codespaces.

Purpose:
- reproducible Node 22 environment;
- native dependencies required by Electron modules;
- GitHub CLI;
- Xvfb/headless test support;
- no credentials stored in Git.

Important: do not convert Kangentic to a web app during this phase. The desktop application remains the operator UI. Codespaces is the development/build/test environment.

Acceptance:
- Codespace opens successfully;
- `npm install` completes;
- typecheck, lint, and unit tests execute;
- no secrets are committed.

## Phase 2 — NAUMS pilot without Kangentic core changes

Add `/kangentic.json` to `Radius-Group-Systems/naumsCMS`.

Initial workflow:

`Inbox → To Fix → Fixing → Code Review → Testing → Ready to Merge → Done`

Behavior:
- **Inbox:** new work; no automatic agent execution.
- **To Fix:** human execution gate. Moving a card here starts Codex planning.
- **Fixing:** Codex implements only the card in an isolated worktree and follows the repo's `AGENTS.md` and journal/session protocol.
- **Code Review:** review the task diff for correctness, security, permissions, regressions, and unwanted scope changes.
- **Testing:** run the relevant NAUMS build/test gates required by `AGENTS.md`.
- **Ready to Merge:** human gate. No automatic production merge or deployment.
- **Done:** merged and verified.

NAUMS safety rule: a board transition must never deploy production. Existing branch and deployment protections remain authoritative.

Acceptance:
1. Open NAUMS in Kangentic.
2. Create one low-risk real task.
3. Move Inbox → To Fix.
4. Agent plans, works in an isolated worktree, commits, reviews, and tests.
5. Human reviews the final PR/handoff and merges through the normal GitHub process.

## Phase 3 — GitHub Issues as durable intake

Use GitHub Issues as the durable external task record before building direct email ingestion into Kangentic.

Flow:

`support/human signal → GitHub Issue → Kangentic backlog → human moves to To Fix → agent worktree → PR → issue closed`

Suggested labels:
- `agent:intake`
- `agent:ready`
- `agent:blocked`
- `source:email`
- `source:github`
- `priority:high`

Do not automatically execute every imported issue. Human promotion into `To Fix` remains the execution gate during the pilot.

## Phase 4 — Email intake

Build a separate Radius intake worker rather than modifying Kangentic core.

Initial behavior:
1. Read messages only from approved support sources.
2. Determine whether the message represents actionable work.
3. Map it to a repository/project.
4. Search for a matching existing open issue.
5. Create or update a GitHub Issue with source metadata.
6. Leave the issue in intake; do not automatically start a coding agent initially.

Later, trusted categories can be promoted automatically after we have measured false positives and agent completion quality.

## Phase 5 — Multi-project rollout

Once NAUMS is stable, add projects one at a time. Each repository owns its own `kangentic.json` so workflows can differ by project.

Measure for each project:
- tasks completed without intervention;
- tasks blocked or escalated;
- review defects found;
- failed test runs;
- cycle time from `To Fix` to `Ready to Merge`;
- percentage of agent changes accepted without major rework.

Do not generalize the workflow until NAUMS has produced enough real tasks to expose failure modes.

## Phase 6 — Executive command center

Only after the local multi-project workflow is proven, evaluate the missing centralized features:
- persistent cross-project dashboard;
- remote/mobile board access;
- centralized agent activity/health;
- 24/7 intake while developer workstations are offline;
- priority/SLA views;
- approval queue;
- cost and completion metrics.

At that point choose between extending Kangentic, adding a separate web command center over the same task records, or adopting a centralized tracker while retaining Kangentic as the execution client.

## Immediate next actions

1. Merge the Codespaces bootstrap after verification.
2. Open a Codespace and run the baseline gates.
3. Add the initial `kangentic.json` to NAUMS in a separate PR.
4. Install/run the Kangentic fork on the development Mac.
5. Execute one low-risk NAUMS task end-to-end.
6. Adjust the workflow based on that real run before automating email intake.
