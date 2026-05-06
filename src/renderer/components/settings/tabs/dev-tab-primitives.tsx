import type { ElementType, ReactNode } from 'react';
import { ToggleSwitch } from '../shared';

/**
 * Compact row primitives shared by `DeveloperTab.tsx` (the always-shipped
 * developer/diagnostic settings) and `src/devtools/renderer/DevToolsSections.tsx`
 * (the dev-only inspection-bridge sub-section appended below it). Lives in
 * its own file because both surfaces consume the same components, and a
 * cross-import between them would create a circular module graph.
 *
 * Tuned for a dense list of toggles: smaller rhythm than `<ToggleCard>`,
 * single icon column, two-line title/subtitle. Not meant for general use
 * across other settings tabs.
 */

export function GroupHeading({ children }: { children: ReactNode }) {
  return (
    <div className="text-[11px] uppercase tracking-wider text-fg-muted px-1 font-semibold mt-2">
      {children}
    </div>
  );
}

export function ToggleRow({
  icon: Icon,
  title,
  subtitle,
  checked,
  onChange,
  disabled,
}: {
  icon: ElementType;
  title: string;
  subtitle: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  /**
   * Render the switch in a non-interactive state. Use for "always on" or
   * "always off" settings where visual consistency with neighbouring rows
   * matters but the user cannot change the value (e.g. crash capture).
   */
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg bg-surface-hover px-4 py-3">
      <Icon className="size-5 text-fg-muted shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-fg-primary">{title}</div>
        <div className="text-xs text-fg-muted">{subtitle}</div>
      </div>
      <ToggleSwitch checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  );
}

export function Description({ children }: { children: ReactNode }) {
  return <p className="text-xs text-fg-muted leading-relaxed px-1">{children}</p>;
}

export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="text-[11px] bg-surface-raised px-1 py-0.5 rounded font-mono">{children}</code>
  );
}
