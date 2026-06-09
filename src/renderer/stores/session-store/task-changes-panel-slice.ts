import { type StateCreator } from 'zustand';
import type { SessionStore } from './types';

export interface TaskChangesPanelSlice {
  /** Task IDs whose Changes panel is open (persists across dialog open/close). */
  changesOpenTasks: Set<string>;
  /** Last selected file in the Changes panel, keyed by task ID. */
  changesSelectedFile: Record<string, string>;
  /** View mode for the task-detail Changes panel, keyed by task ID (default 'split'). */
  changesViewMode: Record<string, 'split' | 'expanded'>;
  /**
   * Divider ratio for the task-detail terminal / right-panel split, keyed by
   * task ID. The value is the fraction of horizontal space given to the LEFT
   * (terminal) pane; absent means the 50/50 default. One shared ratio per task
   * across both the Browser and Changes views (persists across dialog
   * open/close).
   */
  dividerRatio: Record<string, number>;
  /** Task IDs whose Browser pane is open (persists across dialog open/close). */
  browserOpenTasks: Set<string>;
  /** Task IDs whose detail dialog is maximized (persists across dialog open/close). */
  maximizedTasks: Set<string>;
  toggleChangesOpen: (taskId: string) => void;
  setChangesSelectedFile: (taskId: string, filePath: string | null) => void;
  setChangesViewMode: (taskId: string, mode: 'split' | 'expanded') => void;
  setDividerRatio: (taskId: string, ratio: number) => void;
  toggleBrowserOpen: (taskId: string) => void;
  toggleMaximized: (taskId: string) => void;
}

/**
 * UI state for the Task Detail dialog's terminal / right-panel area, keyed by
 * task ID. Tracks which tasks have the Changes panel open, the selected file
 * inside it, the split-vs-expanded view mode, the draggable divider ratio, which
 * tasks have the Browser pane open, and which tasks are maximized. State persists
 * across dialog open/close so reopening a task shows the same panel state.
 */
export const createTaskChangesPanelSlice: StateCreator<SessionStore, [], [], TaskChangesPanelSlice> = (set, get) => ({
  changesOpenTasks: new Set<string>(),
  changesSelectedFile: {},
  changesViewMode: {},
  dividerRatio: {},
  browserOpenTasks: new Set<string>(),
  maximizedTasks: new Set<string>(),

  toggleChangesOpen: (taskId) => {
    const next = new Set(get().changesOpenTasks);
    const viewMode = { ...get().changesViewMode };
    if (next.has(taskId)) {
      next.delete(taskId);
      delete viewMode[taskId];
    } else {
      next.add(taskId);
      viewMode[taskId] = 'split';
    }
    set({ changesOpenTasks: next, changesViewMode: viewMode });
  },

  toggleBrowserOpen: (taskId) => {
    const next = new Set(get().browserOpenTasks);
    if (next.has(taskId)) {
      next.delete(taskId);
    } else {
      next.add(taskId);
    }
    set({ browserOpenTasks: next });
  },

  toggleMaximized: (taskId) => {
    const next = new Set(get().maximizedTasks);
    if (next.has(taskId)) {
      next.delete(taskId);
    } else {
      next.add(taskId);
    }
    set({ maximizedTasks: next });
  },

  setChangesViewMode: (taskId, mode) => {
    set({ changesViewMode: { ...get().changesViewMode, [taskId]: mode } });
  },

  setDividerRatio: (taskId, ratio) => {
    set({ dividerRatio: { ...get().dividerRatio, [taskId]: ratio } });
  },

  setChangesSelectedFile: (taskId, filePath) => {
    const current = get().changesSelectedFile;
    if (filePath === null) {
      if (!(taskId in current)) return;
      const { [taskId]: _removed, ...rest } = current;
      set({ changesSelectedFile: rest });
    } else {
      set({ changesSelectedFile: { ...current, [taskId]: filePath } });
    }
  },
});
