import { useState, useEffect, useCallback } from 'react';

/** Preserved across HMR so the search palette stays mounted during hot
 *  module replacement instead of resetting to closed. */
// @ts-expect-error -- Vite handles import.meta.hot
const hmrSearchPaletteOpen: boolean = import.meta.hot?.data?.searchPaletteOpen ?? false;

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    data.searchPaletteOpen = _lastIsOpen;
  });
}

let _lastIsOpen = hmrSearchPaletteOpen;

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Registers Ctrl+Shift+F / Cmd+Shift+F (and plain Ctrl+F / Cmd+F when not
 * typing in an editable element) to toggle the global search palette.
 * The plain Ctrl+F binding is the recycled board-search shortcut now that
 * the inline board filter has been removed.
 */
export function useSearchPalette() {
  const [isOpen, setIsOpen] = useState(hmrSearchPaletteOpen);

  useEffect(() => {
    _lastIsOpen = isOpen;
  }, [isOpen]);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isCtrlOrMeta = event.ctrlKey || event.metaKey;
      if (!isCtrlOrMeta) return;
      const isFKey = event.key === 'f' || event.key === 'F';
      if (!isFKey) return;
      if (event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        if (isOpen) close(); else open();
        return;
      }
      // Plain Ctrl+F: only swallow when we're not in an editable region. This
      // keeps in-input "find selection" muscle memory unbroken (browsers
      // don't expose a built-in find inside an input, but textareas can
      // benefit from native browser handling and xterm scrollback search
      // is a future feature).
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      if (isOpen) close(); else open();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, open, close]);

  return { isOpen, open, close };
}
