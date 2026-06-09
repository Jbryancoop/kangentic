import { useBoardStore } from '../stores/board-store';
import { useProjectStore } from '../stores/project-store';
import { useKeybinding } from './useKeybinding';

/**
 * Global keyboard shortcut (default Ctrl/Cmd+Shift+B) toggling between the Board
 * and Backlog views. Combo is read from the central keybinding registry.
 *
 * Guards:
 * - Only fires when a project is open.
 */
export function useViewToggle() {
  const activeView = useBoardStore((state) => state.activeView);
  const setActiveView = useBoardStore((state) => state.setActiveView);
  const currentProject = useProjectStore((state) => state.currentProject);

  // Preserve the original behavior of preventDefault without stopPropagation.
  useKeybinding(
    'view.toggleBoardBacklog',
    () => setActiveView(activeView === 'board' ? 'backlog' : 'board'),
    { enabled: !!currentProject, stopPropagation: false },
  );
}
