import React from 'react';

type IsolatedBadgeProps = React.HTMLAttributes<HTMLSpanElement>;

/**
 * Text-only "Isolated" status badge. Neutral chip with the label in the theme
 * accent (text-accent-fg) so it re-colors across all themes (see index.css)
 * instead of a fixed purple. Shared by the bottom-panel session tab and the
 * task detail header so both stay visually identical.
 */
export const IsolatedBadge = React.memo(function IsolatedBadge({ className, title, ...rest }: IsolatedBadgeProps) {
  return (
    <span
      title={title ?? 'Isolated session - separate context from the main conversation'}
      className={['inline-flex items-center text-[11px] text-accent-fg bg-surface-hover/60 border border-edge/50 rounded px-1.5 py-0.5 leading-none flex-shrink-0', className].filter(Boolean).join(' ')}
      {...rest}
    >
      Isolated
    </span>
  );
});
