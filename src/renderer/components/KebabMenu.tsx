import { useState, useRef, useEffect, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { usePopoverPosition } from '../hooks/usePopoverPosition';
import { OverlayPopover } from './OverlayPopover';

interface KebabMenuProps {
  /** Render menu items. Call `close` to dismiss the menu after an action. */
  children: (close: () => void) => ReactNode;
}

/**
 * Reusable kebab (three-dot) menu button with click-outside dismissal and
 * smart popover positioning. Used by TaskDetailHeader and CommandBarOverlay.
 */
export function KebabMenu({ children }: KebabMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const { style } = usePopoverPosition(containerRef, popoverRef, open, { mode: 'dropdown' });

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handleClick = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick, true);
    return () => document.removeEventListener('mousedown', handleClick, true);
  }, [open]);

  const close = () => setOpen(false);

  return (
    <div className="relative flex-shrink-0" ref={containerRef}>
      <button
        onClick={() => setOpen(!open)}
        className="p-1.5 text-fg-faint hover:text-fg-tertiary hover:bg-surface-hover rounded transition-colors"
        title="Actions"
      >
        <MoreHorizontal size={16} />
      </button>
      <OverlayPopover
        open={open}
        popoverRef={popoverRef}
        style={style}
        className="absolute min-w-[170px] bg-surface-raised border border-edge-input rounded-md shadow-xl z-50 py-1"
      >
        {children(close)}
      </OverlayPopover>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reusable menu item primitives
// ---------------------------------------------------------------------------

const ITEM_CLASS = 'w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center gap-2 text-fg-tertiary hover:bg-surface-hover hover:text-fg';
const DESTRUCTIVE_CLASS = 'w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center gap-2 text-red-400 hover:bg-red-400/10 hover:text-red-300';

interface MenuItemProps {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
  'data-testid'?: string;
}

export function KebabMenuItem({ icon, label, onClick, destructive, disabled, ...rest }: MenuItemProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`${destructive ? DESTRUCTIVE_CLASS : ITEM_CLASS}${disabled ? ' opacity-50' : ''}`}
      {...rest}
    >
      {icon}
      {label}
    </button>
  );
}

export function KebabMenuDivider() {
  return <div className="my-1 mx-2 border-t border-edge-input/50" />;
}
