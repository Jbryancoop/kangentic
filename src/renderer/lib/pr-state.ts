import type { PRState } from '../../shared/types';

/**
 * Shared presentation for a PR state, so the board card badge and the task
 * detail pill stay visually consistent: open=green, draft=gray, merged=purple,
 * closed=red. `null` (linked before state tracking, or unknown) falls back to
 * the neutral accent treatment used for plain PR links.
 */
export function prStatePresentation(state: PRState | null | undefined): { label: string; textClass: string } {
  switch (state) {
    case 'open':
      return { label: 'open', textClass: 'text-emerald-400' };
    case 'draft':
      return { label: 'draft', textClass: 'text-fg-muted' };
    case 'merged':
      return { label: 'merged', textClass: 'text-purple-400' };
    case 'closed':
      return { label: 'closed', textClass: 'text-red-400' };
    default:
      return { label: '', textClass: 'text-accent-fg' };
  }
}
