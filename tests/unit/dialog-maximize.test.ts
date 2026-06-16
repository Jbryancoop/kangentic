import { describe, it, expect } from 'vitest';

/**
 * Unit coverage for the pure `maximizedDialogLayout` function in
 * src/renderer/components/dialogs/dialog-maximize.tsx.
 *
 * The module also exports MaximizeToggleButton (a React component that imports
 * useKeybinding), but importing the whole module under the Node vitest env would
 * pull in React/hook dependencies that cannot resolve here. We import the
 * function via a named re-import from the path; vitest transforms the TypeScript
 * on-the-fly and the function itself has no DOM or React deps, so the import
 * works cleanly.
 */
import { maximizedDialogLayout } from '../../src/renderer/components/dialogs/dialog-maximize';

describe('maximizedDialogLayout', () => {
  const WINDOWED_CLASS = 'w-[840px] max-w-[90vw]';

  describe('windowed state (isMaximized = false)', () => {
    it('returns the caller-supplied windowedClassName as dialogClassName', () => {
      const result = maximizedDialogLayout(false, WINDOWED_CLASS);
      expect(result.dialogClassName).toBe(`${WINDOWED_CLASS} dialog-maximize-anim`);
    });

    it('uses full-window backdrop position (inset-0)', () => {
      const result = maximizedDialogLayout(false, WINDOWED_CLASS);
      expect(result.backdropPositionClass).toBe('inset-0');
    });

    it('adds backdrop padding (p-6)', () => {
      const result = maximizedDialogLayout(false, WINDOWED_CLASS);
      expect(result.backdropClassName).toBe('p-6');
    });

    it('rounds the dialog corners (rounded-lg)', () => {
      const result = maximizedDialogLayout(false, WINDOWED_CLASS);
      expect(result.contentRadiusClass).toBe('rounded-lg');
    });

    it('returns the full expected shape for windowed state', () => {
      const result = maximizedDialogLayout(false, WINDOWED_CLASS);
      expect(result).toEqual({
        dialogClassName: 'w-[840px] max-w-[90vw] dialog-maximize-anim',
        backdropPositionClass: 'inset-0',
        backdropClassName: 'p-6',
        contentRadiusClass: 'rounded-lg',
      });
    });
  });

  describe('maximized state (isMaximized = true)', () => {
    it('ignores windowedClassName and fills the available area (w-full h-full)', () => {
      const result = maximizedDialogLayout(true, WINDOWED_CLASS);
      expect(result.dialogClassName).toBe('w-full h-full dialog-maximize-anim');
    });

    it('insets the backdrop to clear the title bar and status bar', () => {
      const result = maximizedDialogLayout(true, WINDOWED_CLASS);
      // inset-x-0 top-10 bottom-9 keeps the app title bar (h-10) and status bar
      // (h-9) uncovered and clickable.
      expect(result.backdropPositionClass).toBe('inset-x-0 top-10 bottom-9');
    });

    it('removes backdrop padding so the dialog fills the inset area', () => {
      const result = maximizedDialogLayout(true, WINDOWED_CLASS);
      expect(result.backdropClassName).toBe('');
    });

    it('squares the content corners (rounded-none) so the border meets the edges flush', () => {
      const result = maximizedDialogLayout(true, WINDOWED_CLASS);
      expect(result.contentRadiusClass).toBe('rounded-none');
    });

    it('returns the full expected shape for maximized state', () => {
      const result = maximizedDialogLayout(true, WINDOWED_CLASS);
      expect(result).toEqual({
        dialogClassName: 'w-full h-full dialog-maximize-anim',
        backdropPositionClass: 'inset-x-0 top-10 bottom-9',
        backdropClassName: '',
        contentRadiusClass: 'rounded-none',
      });
    });

    it('ignores the windowedClassName value entirely when maximized', () => {
      const alternativeClass = 'w-[500px]';
      const result = maximizedDialogLayout(true, alternativeClass);
      expect(result.dialogClassName).toBe('w-full h-full dialog-maximize-anim');
      expect(result.dialogClassName).not.toContain(alternativeClass);
    });
  });

  describe('toggle invariant', () => {
    it('toggling twice (false -> true -> false) round-trips back to the windowed shape', () => {
      const windowed = maximizedDialogLayout(false, WINDOWED_CLASS);
      const maximized = maximizedDialogLayout(true, WINDOWED_CLASS);
      const restoredWindowed = maximizedDialogLayout(false, WINDOWED_CLASS);

      // The two windowed results must be identical.
      expect(restoredWindowed).toEqual(windowed);
      // And different from the maximized result.
      expect(maximized.dialogClassName).not.toBe(windowed.dialogClassName);
    });
  });
});
