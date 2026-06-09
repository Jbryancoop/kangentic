import { useState, useEffect, useCallback } from 'react';
import { useProjectStore } from '../stores/project-store';
import { useSessionStore } from '../stores/session-store';
import { useToastStore } from '../stores/toast-store';
import { useKeybinding } from './useKeybinding';

/** Preserved across HMR so the command bar overlay stays mounted during
 *  hot module replacement instead of resetting to closed. */
// @ts-expect-error -- Vite handles import.meta.hot
const hmrCommandBarOpen: boolean = import.meta.hot?.data?.commandBarOpen ?? false;

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    data.commandBarOpen = _lastIsOpen;
  });
}

/** Tracks the latest isOpen value so dispose() can snapshot it. */
let _lastIsOpen = hmrCommandBarOpen;

/**
 * Registers Ctrl+Shift+P / Cmd+Shift+P to open the command bar overlay.
 * Returns open/close state and handlers.
 */
export function useCommandBar() {
  const [isOpen, setIsOpen] = useState(hmrCommandBarOpen);
  const currentProjectId = useProjectStore((s) => s.currentProject?.id);
  const pendingOpenCommandTerminal = useSessionStore((s) => s._pendingOpenCommandTerminal);

  // Keep module-scoped tracker in sync for HMR dispose()
  useEffect(() => {
    _lastIsOpen = isOpen;
    // Sync store so TerminalPanel can include transient session in focus priority
    useSessionStore.getState().setCommandBarVisible(isOpen);
  }, [isOpen]);

  // Close command bar when project changes - it will reattach on next open
  useEffect(() => {
    setIsOpen(false);
  }, [currentProjectId]);

  const open = useCallback(() => {
    const currentProject = useProjectStore.getState().currentProject;
    if (!currentProject) {
      useToastStore.getState().addToast({
        message: 'Open a project first',
        variant: 'warning',
      });
      return;
    }
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
  }, []);

  // Consume pending-open flag set by notification clicks for transient sessions.
  // Runs after currentProjectId settles, so cross-project notification clicks
  // (which call openProject first) reopen the overlay on the correct project.
  useEffect(() => {
    if (!pendingOpenCommandTerminal) return;
    if (!currentProjectId) return;
    useSessionStore.getState().setPendingOpenCommandTerminal(false);
    setIsOpen(true);
  }, [pendingOpenCommandTerminal, currentProjectId]);

  useKeybinding('commandBar.toggle', () => {
    if (isOpen) close();
    else open();
  });

  return { isOpen, open, close };
}
