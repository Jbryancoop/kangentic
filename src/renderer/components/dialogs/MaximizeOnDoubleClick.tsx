import React, { useRef } from 'react';

interface MaximizeOnDoubleClickProps {
  /**
   * Toggle-maximize handler. When omitted the double-click does nothing, so a
   * non-maximizable dialog can use this wrapper without special-casing.
   */
  onToggle?: () => void;
  /** Layout classes for the header row (the wrapper renders a plain div). */
  className?: string;
  children: React.ReactNode;
}

// Two clicks closer together than this (in ms) count as a double-click.
const DOUBLE_CLICK_WINDOW_MS = 400;

// Controls whose own behavior must win over a maximize toggle.
const INTERACTIVE_SELECTOR =
  'button, a, input, textarea, select, [role="button"], [contenteditable="true"]';

/**
 * A dialog header region that toggles maximize/restore when double-clicked,
 * mirroring the desktop title-bar convention. Double-clicks that land on an
 * interactive control (buttons, the maximize/close icons, inputs, the branch
 * picker) are ignored so those keep their own behavior, and `select-none` keeps
 * the gesture from selecting the title text.
 *
 * We detect the double-click from raw `click` timing rather than the browser's
 * native `dblclick`: a plain `click` always fires and is observable, so we
 * measure the gap between two consecutive clicks on non-interactive header
 * space ourselves. `event.timeStamp` is monotonic, so this needs no wall-clock.
 *
 * Shared by BaseDialog's standard and custom headers and the command terminal
 * header, so the behavior stays identical everywhere.
 */
export function MaximizeOnDoubleClick({ onToggle, className = '', children }: MaximizeOnDoubleClickProps) {
  // Timestamp of the last qualifying click; null means "no pending click". A
  // null sentinel (not 0) so a legitimately-zero event.timeStamp still pairs.
  const lastClickRef = useRef<number | null>(null);

  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!onToggle) return;
    // Ignore clicks that land on a real control INSIDE this header. The
    // `contains` check scopes the match to the header: a task-detail dialog
    // renders inside the board card's role="button" wrapper, so a bare
    // closest() would match that ancestor and suppress every header click.
    // Only an interactive element within the header counts.
    const interactive = (event.target as HTMLElement).closest(INTERACTIVE_SELECTOR);
    if (interactive && event.currentTarget.contains(interactive)) {
      lastClickRef.current = null;
      return;
    }
    const now = event.timeStamp;
    const previous = lastClickRef.current;
    if (previous !== null && now - previous <= DOUBLE_CLICK_WINDOW_MS) {
      lastClickRef.current = null;
      onToggle();
    } else {
      lastClickRef.current = now;
    }
  };

  return (
    <div className={`${onToggle ? 'select-none ' : ''}${className}`} onClick={handleClick}>
      {children}
    </div>
  );
}
