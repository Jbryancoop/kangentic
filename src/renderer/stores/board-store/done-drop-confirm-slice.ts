import { type StateCreator } from 'zustand';
import type { GitPendingChangesResult, Task, TaskMoveInput } from '../../../shared/types';
import type { BoardStore, CompletingTask, PendingDoneConfirm } from './types';

export type PendingChangesInfo = Pick<GitPendingChangesResult, 'hasPendingChanges' | 'uncommittedFileCount' | 'unpushedCommitCount'>;

export interface DoneDropConfirmSlice {
  pendingDoneConfirm: PendingDoneConfirm | null;
  requestDoneConfirmAnimated: (completing: CompletingTask, pendingChanges: PendingChangesInfo) => void;
  requestDoneConfirmDirect: (task: Task, input: TaskMoveInput, pendingChanges: PendingChangesInfo) => void;
  confirmPendingDone: () => Promise<void>;
  cancelPendingDone: () => void;
}

export const createDoneDropConfirmSlice: StateCreator<BoardStore, [], [], DoneDropConfirmSlice> = (set, get) => ({
  pendingDoneConfirm: null,
  requestDoneConfirmAnimated: (completing, pendingChanges) => {
    set({
      pendingDoneConfirm: {
        kind: 'animated',
        task: completing.task,
        completing,
        hasPendingChanges: pendingChanges.hasPendingChanges,
        uncommittedFileCount: pendingChanges.uncommittedFileCount,
        unpushedCommitCount: pendingChanges.unpushedCommitCount,
      },
    });
  },
  requestDoneConfirmDirect: (task, input, pendingChanges) => {
    set({
      pendingDoneConfirm: {
        kind: 'direct',
        task,
        input,
        hasPendingChanges: pendingChanges.hasPendingChanges,
        uncommittedFileCount: pendingChanges.uncommittedFileCount,
        unpushedCommitCount: pendingChanges.unpushedCommitCount,
      },
    });
  },
  confirmPendingDone: async () => {
    const pending = get().pendingDoneConfirm;
    if (!pending) return;
    set({ pendingDoneConfirm: null });
    if (pending.kind === 'animated') {
      // Hand off to the existing fly-into-Done animation, which calls
      // moveTask via finalizeCompletion on transition end.
      get().setCompletingTask(pending.completing);
    } else {
      // Drop-fallback path: skip the animation and move directly.
      await get().moveTask(pending.input);
    }
  },
  cancelPendingDone: () => {
    const pending = get().pendingDoneConfirm;
    set({ pendingDoneConfirm: null });
    // The card was hidden synchronously on drop (addCompletingTaskId in
    // useBoardDragDrop) so it never flashed in its source column during the git
    // probe. The move was never committed, so release the guard to restore the
    // card to its original column.
    if (pending) get().removeCompletingTaskId(pending.task.id);
  },
});
