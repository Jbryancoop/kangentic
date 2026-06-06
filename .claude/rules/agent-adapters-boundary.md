---
paths:
  - "src/**"
---
# Rule: no agent-specific branching outside `src/main/agent/adapters/`

Per-agent behavior (Claude vs Codex vs Droid vs others) belongs in the adapter for that agent.
Branching on an agent's name elsewhere (`agent === 'droid'`, `agentType === 'codex'`) scatters
agent knowledge across the codebase and breaks the adapter abstraction: adding an agent then
means hunting down conditionals instead of writing one adapter.

## The rule

Never branch on a specific agent's name or id outside `src/main/agent/adapters/`. Instead:

1. Declare a capability or value on the `AgentAdapter` (e.g. `supportsSummarize`, `promptVia`,
   or a method).
2. Surface it through a generic shape (a flag on the agent's config or IPC payload).
3. Have the renderer and IPC read the generic flag, never the agent name.

Example: auto-name support is exposed via the optional `summarize?()` method on `AgentAdapter`;
the renderer gates the button on a generic `supportsSummarize` flag, not on `agent === 'claude'`.

## Enforcement (self-maintaining)

- **Review:** `/code-review` and the `migration-safety` agent flag agent-name branching outside
  the adapters folder.
- No dedicated mechanical test yet. A scan for agent-name string comparisons outside
  `src/main/agent/adapters/` is a candidate future test.

## Scope

Agent adapters (`src/main/agent/adapters/`). The parallel board-adapter system
(`src/main/boards/adapters/`) follows the same principle for board providers.
