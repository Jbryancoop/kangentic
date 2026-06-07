---
paths:
  - "src/renderer/components/board/**"
  - "src/renderer/hooks/useBoardDragDrop.ts"
  - "src/renderer/stores/board-store/done-drop-confirm-slice.ts"
  - "src/renderer/stores/board-store/task-completion-slice.ts"
---
# Rule: hide in-flight (completing) tasks at the single lane chokepoint

A Done drop does not persist immediately. It removes the task from `tasks`, holds its id in the
store-level `completingTaskIds` Set, and flies a `FlyingCard` into the dropzone for ~700ms;
`finalizeCompletion -> moveTask` writes the DB (move + archive) only at the end. For that whole
flight the backend still has the task at its **source** lane, so any `loadBoard()` racing the
fly (an agent-driven `onUpdatedByAgent` / `onAutoMoved` reload, an HMR re-sync) re-injects the
task into `tasks` at its source `swimlane_id`. If a lane renders straight from its `tasks` prop,
the card flashes back in its source column for a frame before vanishing into Done. This bug
shipped and regressed 5+ times because the guard was applied per-lane (only `DoneSwimlane`
filtered `completingTaskIds`, which protected the wrong lane) instead of at the one place every
lane's task list is produced.

There is a second, earlier flash window with the same shape: a worktree-backed task awaits
`git.checkPendingChanges(...)` (~100ms) in `handleDragEnd` *before* `setCompletingTask` runs. On
release dnd-kit restores the original sortable card to full opacity in its source lane, so during
that await the card sits fully visible there. A task with no worktree skips the await and never
flashed, which is why `/preview` fixtures (`worktree_path: null`) looked clean while real tasks
janked. The guard therefore has to be populated the instant a Done drop is detected, not after
the probe resolves.

## The rule

There is exactly one place a completing task is excluded from the board:
`KanbanBoard`'s `tasksPerLane` memo, the single chokepoint that buckets `tasks` into per-lane
arrays. It reads `completingTaskIds` and skips any task whose id is in it, so a completing task
renders in **no** lane (source or Done) for the entire flight, reconciliation-proof against any
mid-flight reload.

- Individual lane components (`Swimlane`, `DoneSwimlane`, any future lane renderer under
  `src/renderer/components/board/`) MUST NOT read `completingTaskIds` to re-filter their own
  task list. They receive an already-filtered `tasks` prop from `tasksPerLane`; a second
  per-lane filter is redundant at best and reopens the source-lane gap at worst (it only ever
  guards the lane that implements it).
- The producer side is unaffected: the store actions `addCompletingTaskId` /
  `removeCompletingTaskId` and the `completingTaskIds` definition live in the board store
  (`src/renderer/stores/board-store/`) and are the source of truth the chokepoint reads.
- Populate the guard synchronously the moment a Done drop is detected, BEFORE any `await` in
  `handleDragEnd` (the `checkPendingChanges` probe). `handleDragEnd` calls `addCompletingTaskId`
  immediately so the card is filtered out the same tick dnd-kit restores it; releasing happens in
  `moveTask`'s `finally` (success) or `cancelPendingDone` (the user declines the worktree-delete
  confirm). Adding it only at `setCompletingTask` (after the probe) is too late and reopens the
  flash for worktree tasks.
- Do not "fix" a recurrence by tuning the drop animation, the `DragOverlay` `dropAnimation`, or
  the `FlyingCard` again. Those are settled; the durable guard is the chokepoint filter.

## Enforcement (self-maintaining)

- **Test (mechanical):** `tests/unit/board-completing-task-chokepoint.test.ts` scans
  `src/renderer/components/board/` and fails if any file other than `KanbanBoard.tsx` references
  `completingTaskIds`. Runs in CI via `npm run test:unit`.
- **Test (behavioral):** `tests/ui/move-to-done-reload-no-source-flash.spec.ts` drags a task to
  Done, fires a `loadBoard()` mid-flight, and asserts the card never reappears in its source
  lane (parametrized across multiple source columns). It goes red the moment the chokepoint
  guard is removed. `tests/ui/move-to-done-worktree-await-no-source-flash.spec.ts` covers the
  second window: a worktree task with a slowed `checkPendingChanges` probe must never return to
  full opacity in its source lane during the await. It goes red if the synchronous
  `addCompletingTaskId` on drop is removed.
- **Review:** `/code-review` flags per-lane completing-task filtering on board changes.

## Scope

Board lane rendering under `src/renderer/components/board/`, plus the completing-task lifecycle in
`useBoardDragDrop.ts` (where the guard is populated on drop) and `done-drop-confirm-slice.ts`
(where it is released on cancel). The mechanical no-per-lane-filter scan is scoped to
`src/renderer/components/board/`; the synchronous-hide timing is covered by the behavioral specs.
The singular `completingTask` field (which drives the `FlyingCard` animation in `KanbanBoard`) is
a different concern and is not governed by this rule.
