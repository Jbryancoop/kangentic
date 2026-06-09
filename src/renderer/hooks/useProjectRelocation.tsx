import { useCallback, useState } from 'react';
import { useProjectStore } from '../stores/project-store';
import { useToastStore } from '../stores/toast-store';
import { ConfirmDialog } from '../components/dialogs/ConfirmDialog';
import type { Project } from '../../shared/types';

interface PendingRelocation {
  project: Project;
  newPath: string;
}

/**
 * Shared "Change Directory..." flow: pick a folder, confirm, then re-point
 * the project at it via the relocate IPC endpoint. Used by the project
 * context menu and the Project settings tab. The caller renders
 * `relocationDialog` so the ConfirmDialog mounts in its own subtree.
 */
export function useProjectRelocation(onRelocated?: (project: Project) => void) {
  const relocateProject = useProjectStore((state) => state.relocateProject);
  const [pendingRelocation, setPendingRelocation] = useState<PendingRelocation | null>(null);

  const requestRelocate = useCallback(async (project: Project) => {
    const selectedPath = await window.electronAPI.dialog.selectFolder();
    if (!selectedPath) return;
    setPendingRelocation({ project, newPath: selectedPath });
  }, []);

  const handleConfirm = useCallback(async () => {
    if (!pendingRelocation) return;
    const { project, newPath } = pendingRelocation;
    setPendingRelocation(null);
    try {
      const updated = await relocateProject(project.id, newPath);
      useToastStore.getState().addToast({
        message: `Project "${updated.name}" now points at ${updated.path}`,
        variant: 'success',
      });
      onRelocated?.(updated);
    } catch (err) {
      useToastStore.getState().addToast({
        message: err instanceof Error ? err.message : 'Failed to change project directory',
        variant: 'error',
      });
    }
  }, [pendingRelocation, relocateProject, onRelocated]);

  const relocationDialog = pendingRelocation ? (
    <ConfirmDialog
      title="Change Project Directory"
      message={
        <div className="space-y-2">
          <p>
            Point <strong>&quot;{pendingRelocation.project.name}&quot;</strong> at the new folder?
          </p>
          <p className="text-xs break-all">
            <span className="text-fg-faint">From: </span>{pendingRelocation.project.path}
          </p>
          <p className="text-xs break-all">
            <span className="text-fg-faint">To: </span>{pendingRelocation.newPath}
          </p>
          <p>
            All tasks and board history are preserved. Running sessions are
            suspended and resumed at the new location.
          </p>
        </div>
      }
      confirmLabel="Change Directory"
      onConfirm={handleConfirm}
      onCancel={() => setPendingRelocation(null)}
    />
  ) : null;

  return { requestRelocate, relocationDialog };
}
