import { useState, useEffect, useRef, useCallback } from 'react';
import { X } from 'lucide-react';
import type { Toast } from '../../stores/toast-store';

const variantStyles: Record<Toast['variant'], { border: string; accent: string }> = {
  info: { border: 'border-accent/50', accent: 'bg-accent' },
  success: { border: 'border-green-500/50', accent: 'bg-green-500' },
  warning: { border: 'border-yellow-500/50', accent: 'bg-yellow-500' },
  error: { border: 'border-red-500/50', accent: 'bg-red-500' },
};

interface ToastItemProps {
  toast: Toast;
  onDismiss: (id: string) => void;
}

export function ToastItem({ toast, onDismiss }: ToastItemProps) {
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Enter animation: mount hidden, then transition to visible
  useEffect(() => {
    const frame = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  // Auto-dismiss timer
  useEffect(() => {
    if (toast.duration <= 0) return;
    const timer = setTimeout(() => setExiting(true), toast.duration);
    return () => clearTimeout(timer);
  }, [toast.duration]);

  // Remove from store after exit transition completes
  const handleTransitionEnd = useCallback(() => {
    if (exiting) onDismiss(toast.id);
  }, [exiting, onDismiss, toast.id]);

  const handleDismissClick = useCallback(() => {
    setExiting(true);
  }, []);

  return (
    <div
      ref={ref}
      data-testid="toast"
      onTransitionEnd={handleTransitionEnd}
      className={`pointer-events-auto flex items-stretch overflow-hidden rounded-md border
        bg-surface shadow-xl shadow-black/40 text-sm
        transition-all duration-[var(--toast-duration)] ease-out
        ${variantStyles[toast.variant].border}
        ${visible && !exiting ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'}
      `}
    >
      <div className={`w-1 flex-shrink-0 ${variantStyles[toast.variant].accent}`} />
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-fg-secondary">{toast.message}</span>

        {toast.action && (
          <button
            onClick={toast.action.onClick}
            className="text-accent-fg underline underline-offset-2 hover:opacity-80 ml-1 flex-shrink-0"
          >
            {toast.action.label}
          </button>
        )}

        <button
          onClick={handleDismissClick}
          className="ml-1 p-0.5 text-fg-faint hover:text-fg-tertiary transition-colors flex-shrink-0"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
