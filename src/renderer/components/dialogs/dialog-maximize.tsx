import { Maximize2, Minimize2 } from 'lucide-react';
import { useFormattedCombo } from '../../hooks/useKeybinding';

/**
 * Shared layout + control for the dialog maximize toggle (#184). Used by the
 * Task Detail dialog (view and edit modes) and the create dialogs (New Task,
 * New Backlog Task). Maximize state is tracked in the session store's
 * `maximizedTasks` set, keyed by task id for the detail dialog and by a
 * non-task sentinel id for the create dialogs (mirroring the command
 * terminal's `COMMAND_TERMINAL_ENTITY_ID`).
 */

export interface MaximizedDialogLayout {
  /** Sizing class for the dialog content (BaseDialog `className`). */
  dialogClassName: string;
  /** Backdrop position class (BaseDialog `backdropPositionClass`). */
  backdropPositionClass: string;
  /** Backdrop padding class (BaseDialog `backdropClassName`). */
  backdropClassName: string;
  /** Content corner-radius class (BaseDialog `contentRadiusClass`). */
  contentRadiusClass: string;
}

/**
 * Resolve the BaseDialog sizing/backdrop/radius props for the maximize toggle.
 * When maximized, the content fills the area between the app title bar (h-10 =
 * 40px) and status bar (h-9 = 36px) so the window controls and live stats stay
 * visible and clickable, the backdrop padding is dropped so the dialog fills
 * that region, and the corners are squared so the border meets the screen edges
 * flush. When windowed, the caller's `windowedClassName` is used with the
 * default full-window backdrop and rounded corners.
 */
export function maximizedDialogLayout(isMaximized: boolean, windowedClassName: string): MaximizedDialogLayout {
  if (isMaximized) {
    return {
      dialogClassName: 'w-full h-full',
      backdropPositionClass: 'inset-x-0 top-10 bottom-9',
      backdropClassName: '',
      contentRadiusClass: 'rounded-none',
    };
  }
  return {
    dialogClassName: windowedClassName,
    backdropPositionClass: 'inset-0',
    backdropClassName: 'p-6',
    contentRadiusClass: 'rounded-lg',
  };
}

interface MaximizeToggleButtonProps {
  isMaximized: boolean;
  onToggle: () => void;
  testId?: string;
}

/** Header maximize/restore button shared by the dialogs above. */
export function MaximizeToggleButton({ isMaximized, onToggle, testId = 'dialog-maximize' }: MaximizeToggleButtonProps) {
  const maximizeCombo = useFormattedCombo('panel.maximize');
  return (
    <button
      type="button"
      onClick={onToggle}
      data-testid={testId}
      aria-label={isMaximized ? 'Restore dialog' : 'Maximize dialog'}
      title={`${isMaximized ? 'Restore' : 'Maximize'} (${maximizeCombo})`}
      className="p-1.5 text-fg-faint hover:text-fg-tertiary hover:bg-surface-hover rounded transition-colors flex-shrink-0"
    >
      {isMaximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
    </button>
  );
}
