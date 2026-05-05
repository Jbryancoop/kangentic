import { type StateCreator } from 'zustand';
import type { BoardStore } from './types';

export interface BoardManagerSlice {
  boardManagerOpen: boolean;
  /** Lane id to preselect as the active tab. Null when opened via "Add column". */
  boardManagerInitialId: string | null;
  /** When true, the manager seeds a fresh new-draft tab on open. */
  boardManagerSeedNew: boolean;
  /** Monotonic counter incremented every time the manager is asked to add a draft.
   *  The dialog watches it via useEffect to insert a new tab when already open. */
  boardManagerAddDraftRequest: number;

  openBoardManager: (initialId?: string | null, addNew?: boolean) => void;
  closeBoardManager: () => void;
}

export const createBoardManagerSlice: StateCreator<BoardStore, [], [], BoardManagerSlice> = (set) => ({
  boardManagerOpen: false,
  boardManagerInitialId: null,
  boardManagerSeedNew: false,
  boardManagerAddDraftRequest: 0,

  openBoardManager: (initialId = null, addNew = false) => set((state) => ({
    boardManagerOpen: true,
    boardManagerInitialId: initialId,
    boardManagerSeedNew: addNew,
    boardManagerAddDraftRequest: state.boardManagerOpen && addNew
      ? state.boardManagerAddDraftRequest + 1
      : state.boardManagerAddDraftRequest,
  })),

  closeBoardManager: () => set({
    boardManagerOpen: false,
    boardManagerInitialId: null,
    boardManagerSeedNew: false,
  }),
});
