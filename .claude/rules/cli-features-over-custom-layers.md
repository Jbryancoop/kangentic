---
paths:
  - "src/main/agent/**"
---
# Rule: prefer an agent CLI's native features over Kangentic custom layers

When an agent CLI already exposes its own controls for model selection, permission / autonomy
mode, or default settings, do not shadow them with Kangentic-side flags or per-spawn settings
injection. Spawn the binary with the minimum needed and let the CLI's native UX handle the rest.
Adding a Kangentic-managed layer on top of working CLI features is wasted code and a maintenance
burden.

## The rule

- For a new agent adapter, prefer a thin command builder: spawn with `cwd`, resume id, and
  prompt only. Inject custom config ONLY when the CLI cannot be configured interactively at all
  (e.g. Claude's hook system, which is genuinely required for activity tracking and has no in-TUI
  alternative).
- Do not pin `model` via per-spawn settings if the CLI has its own model picker with
  default-pinning. Tell the user to set the default in the CLI once.
- For permissions, when an agent manages autonomy in its TUI, expose at most a single "Default"
  entry and document that the user controls it via the agent's own controls.
- For BYOK or env config, rely on the CLI's documented config file rather than duplicating it
  through Kangentic-managed overrides.

## Enforcement (self-maintaining)

- **Review:** `/code-review` and the `migration-safety` agent flag new per-spawn settings
  injection that duplicates a CLI's native control. No dedicated mechanical test.

## Scope

Agent adapters and command builders under `src/main/agent/`. Complements
`agent-adapters-boundary.md` (where agent-specific code lives); this rule is about not adding a
custom layer in the first place.
