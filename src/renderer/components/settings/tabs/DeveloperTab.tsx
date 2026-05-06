import { Bug } from 'lucide-react';
import type { AppConfig } from '../../../../shared/types';
import { SectionHeader, ToggleSwitch, useScopedUpdate } from '../shared';

/**
 * Global developer / diagnostic settings. Lives below the
 * shared-settings separator in `AppSettingsPanel.APP_TABS`. The debug
 * overlay is a per-machine dev affordance, not something that varies
 * per project.
 *
 * Layout mirrors McpServerTab: header card with primary toggle, then
 * "What it shows" and "How it works" sections explaining the feature.
 */
export function DeveloperTab({ globalConfig }: { globalConfig: AppConfig }) {
  const updateGlobal = useScopedUpdate('global');
  const developerConfig = globalConfig.developer ?? {};
  const overlayEnabled = developerConfig.activityDebugOverlay === true;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 rounded-lg bg-surface-hover px-4 py-3">
        <Bug className="size-5 text-fg-muted shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-fg-primary">Activity Engine Debug Overlay</div>
          <div className="text-xs text-fg-muted">Floating panel with live state for every running session</div>
        </div>
        <ToggleSwitch
          checked={overlayEnabled}
          onChange={(value) => updateGlobal({ developer: { activityDebugOverlay: value } })}
        />
      </div>

      <div className="flex items-center gap-2 text-xs text-fg-muted px-1">
        <span>Toggle anywhere with</span>
        <kbd className="px-1.5 py-0.5 bg-surface-raised border border-edge rounded text-[10px] font-mono">Ctrl</kbd>
        <span className="text-fg-disabled">+</span>
        <kbd className="px-1.5 py-0.5 bg-surface-raised border border-edge rounded text-[10px] font-mono">Shift</kbd>
        <span className="text-fg-disabled">+</span>
        <kbd className="px-1.5 py-0.5 bg-surface-raised border border-edge rounded text-[10px] font-mono">D</kbd>
      </div>

      <div className={overlayEnabled ? '' : 'opacity-40 pointer-events-none'}>
        <SectionHeader label="What It Shows" searchIds={['developer.activityDebugOverlay']} />
        <ul className="list-disc list-inside text-sm text-fg-muted space-y-1 ml-1">
          <li><strong className="text-fg-secondary">Activity state</strong> - thinking / idle / permission badge per session</li>
          <li><strong className="text-fg-secondary">Dominant reason</strong> - which counter is keeping the session non-idle (tool, subagent, background-shell, turn-active)</li>
          <li><strong className="text-fg-secondary">Counters</strong> - pending tool count, subagent depth, tracked + anonymous bg-shell counts, turn flag, permission flag</li>
          <li><strong className="text-fg-secondary">Pending idle</strong> - whether the 400ms stability window is currently armed</li>
          <li><strong className="text-fg-secondary">Recent transitions</strong> - last 10 from→to changes with relative time, reason kind, and the trigger that caused them (event, timer, force path)</li>
        </ul>

        <SectionHeader label="How It Works" searchIds={['developer.activityDebugOverlay']} />
        <p className="text-sm text-fg-muted leading-relaxed">
          The overlay subscribes to the main process's activity engine via IPC and polls every 2 seconds while open.
          It does not consume engine resources when the toggle is off. Use it to diagnose &quot;stuck thinking&quot; or &quot;missed idle&quot; reports:
          look at the dominant reason and counters to see what is keeping the predicate non-idle, then read the recent
          transitions to trace which event or timer drove the most recent change. The trigger label distinguishes hook events
          (<code className="text-[11px] bg-surface-raised px-1 py-0.5 rounded">event:tool_start</code>) from timer-driven changes
          (<code className="text-[11px] bg-surface-raised px-1 py-0.5 rounded">timer:stability</code>) and force paths
          (<code className="text-[11px] bg-surface-raised px-1 py-0.5 rounded">force-thinking</code>).
        </p>

        <SectionHeader label="Filing a Bug" searchIds={['developer.activityDebugOverlay']} />
        <p className="text-sm text-fg-muted leading-relaxed">
          When reporting an activity-detection bug, screenshot the overlay alongside the agent&apos;s TUI so the engine&apos;s
          view of the world can be compared against what the agent actually shows. Mismatches between the two are the
          most useful diagnostic signal.
        </p>
      </div>
    </div>
  );
}
