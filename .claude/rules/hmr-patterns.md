---
paths:
  - "src/renderer/**"
---
# Rule: HMR dev-mode parity (patterns A-D)

The team dogfoods Kangentic from `npm start` daily, so a Vite Fast Refresh during a real
session must be visually and behaviourally indistinguishable from a fresh production boot. Four
primitives cover every HMR-sensitive surface; mixing them up causes flaky behavior that only
surfaces in dev, the exact failure mode this project cannot tolerate. Pick the right pattern up
front rather than reaching for ad-hoc fixes later.

## The rule

| Pattern | When to reach for it | How to apply | Example sites |
|---|---|---|---|
| **A. Preserve** | Module-scope state (timers, AbortControllers, caches, counters, scroll positions) that must survive a reload | `let x = import.meta.hot?.data?.x ?? <default>;` plus `import.meta.hot?.dispose((d) => { d.x = x; })` | `task-slice.ts` (`moveGeneration`), `session-store.ts` (`syncController`, transient sessions), `useTerminal.ts` (`savedScrollPositions`), `toast-store.ts`, `hmr-generation.ts`, `auto-name-scheduler.ts` |
| **B. Re-sync** | Zustand stores whose truth lives in the main process (IPC-backed) | Add a `load*` / `sync*` call to the `vite:afterUpdate` handler in `App.tsx` | `loadBoard()`, `loadBacklog()`, `loadConfig()`, `loadProjects()`, `syncSessions()` |
| **C. Re-key remount** | Stateful third-party React subtrees whose subscriptions go stale across Fast Refresh (every `<DndContext>`) | `const hmrGeneration = useHmrGeneration();` then `<DndContext key={hmrGeneration}>` | All 5 `<DndContext>` sites: `KanbanBoard`, `BacklogView`, `PrioritiesPopover`, `ProjectSidebar`, `ShortcutsTab` |
| **D. Cleanup** | Imperative DOM or global state no React component owns | Add the clear to the top of the `vite:afterUpdate` handler | `.drop-highlight` class removal in `App.tsx` |

**Decision tree:**

1. New IPC-backed Zustand store, or a new `load*` / `sync*` method on an existing one? Pattern
   B: add a call in `App.tsx`'s `vite:afterUpdate` handler.
2. New `<DndContext>` or other React component wrapping a third-party library with internal
   subscription state? Pattern C: pair it with `useHmrGeneration()` and `key={hmrGeneration}`.
3. New module-scope `let` / `const` mutable state (Maps, Sets, AbortControllers, counters) under
   `src/renderer/stores/` or `src/renderer/utils/`? Pattern A: preserve via
   `import.meta.hot.data`, or annotate the declaration with `// hmr-safe: <reason>` if
   reset-on-HMR is intentional.
4. Imperatively setting a class, attribute, or global handle React will not tear down? Pattern
   D: add the clear to the `vite:afterUpdate` handler.

**Anti-patterns:** do not combine A and C on the same state; do not add a fifth ad-hoc HMR
workaround (surface the gap and extend this catalog deliberately); do not gate Pattern A behind
`process.env.NODE_ENV` (`import.meta.hot` is `undefined` in production builds, so the guards
already collapse to no-ops).

## Enforcement (self-maintaining)

- **Test:** `tests/unit/hmr-resync.test.ts` enforces three things: every IPC-backed store's
  `load*` / `sync*` is called in `App.tsx`'s `vite:afterUpdate` (B); every module-scope mutable
  declaration under the watched dirs has `import.meta.hot.dispose(` or a `// hmr-safe:` opt-out
  (A); every `<DndContext>` has `key={hmrGeneration}` (C). Runs in CI via `npm run test:unit`.
- **Review:** the `hmr-parity` agent audits all four patterns; `hmr-integrity` is the narrow
  Pattern B store-registration check.

## Scope

Renderer code under `src/renderer/`. Main-process state is not subject to HMR (esbuild does not
Fast-Refresh the main process).
