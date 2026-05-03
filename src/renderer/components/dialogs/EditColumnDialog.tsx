import { useState, useRef, useEffect } from 'react';
import { Pencil, Plus, Lock, Trash2, Palette, ChevronRight, Info, RotateCcw } from 'lucide-react';
import { HexColorPicker } from 'react-colorful';
import { useBoardStore } from '../../stores/board-store';
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';
import { useToastStore } from '../../stores/toast-store';
import { BaseDialog } from './BaseDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { IconPickerDialog } from './IconPickerDialog';
import { ModelCombobox } from './ModelCombobox';
import { ICON_REGISTRY, ROLE_DEFAULTS, getUsedIcons } from '../../utils/swimlane-icons';
import { Select } from '../settings/shared';
import { getPermissionLabel, DEFAULT_PERMISSIONS, DEFAULT_AGENT, getAgentDefaultPermission, resolvePermissionForAgent } from '../../../shared/types';
import type { Swimlane, PermissionMode, AgentDetectionInfo } from '../../../shared/types';

const DIALOG_SELECT_CLASS = 'w-full appearance-none bg-surface border border-edge-input rounded pl-3 pr-10 py-1.5 text-sm text-fg focus:outline-none focus:border-accent';

const PRESET_COLORS = [
  '#6b7280', '#ef4444', '#f43f5e', '#f97316',
  '#f59e0b', '#10b981', '#06b6d4', '#3b82f6',
  '#8b5cf6', '#ec4899',
];

interface EditColumnDialogProps {
  swimlane: Swimlane;
  mode?: never;
  onClose: () => void;
}

interface CreateColumnDialogProps {
  swimlane?: never;
  mode: 'create';
  onClose: () => void;
}

const DEFAULT_COLOR = '#3b82f6';

export function EditColumnDialog({ swimlane, mode, onClose }: EditColumnDialogProps | CreateColumnDialogProps) {
  const isCreateMode = mode === 'create';
  const updateSwimlane = useBoardStore((s) => s.updateSwimlane);
  const createSwimlane = useBoardStore((s) => s.createSwimlane);
  const reorderSwimlanes = useBoardStore((s) => s.reorderSwimlanes);
  const deleteSwimlane = useBoardStore((s) => s.deleteSwimlane);
  const tasks = useBoardStore((s) => s.tasks);
  const globalPermissionMode = useConfigStore((s) => s.config.agent.permissionMode);
  const currentProject = useProjectStore((state) => state.currentProject);

  const swimlanes = useBoardStore((s) => s.swimlanes);

  const [name, setName] = useState(swimlane?.name ?? '');
  const [color, setColor] = useState((swimlane?.color ?? DEFAULT_COLOR).toLowerCase());
  const [icon, setIcon] = useState<string | null>(swimlane?.icon ?? null);
  const [showCustomPicker, setShowCustomPicker] = useState(false);
  const [showIconPicker, setShowIconPicker] = useState(false);
  const [hexInput, setHexInput] = useState((swimlane?.color ?? DEFAULT_COLOR).toLowerCase());
  const [permissionMode, setPermissionMode] = useState<PermissionMode | null>(swimlane?.permission_mode ?? null);
  const [autoSpawn, setAutoSpawn] = useState(swimlane?.auto_spawn ?? true);
  const [autoCommand, setAutoCommand] = useState(swimlane?.auto_command || '');
  const [planExitTargetId, setPlanExitTargetId] = useState<string | null>(swimlane?.plan_exit_target_id ?? null);
  const [agentOverride, setAgentOverride] = useState<string | null>(swimlane?.agent_override ?? null);
  const [modelOverride, setModelOverride] = useState(swimlane?.model_override ?? '');
  const [effortOverride, setEffortOverride] = useState<string | null>(swimlane?.effort_override ?? null);
  const [handoffContext, setHandoffContext] = useState(swimlane?.handoff_context ?? false);
  const [agentList, setAgentList] = useState<AgentDetectionInfo[]>(() => useConfigStore.getState().agentList);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const taskCount = swimlane ? tasks.filter((t) => t.swimlane_id === swimlane.id).length : 0;
  const isLocked = swimlane?.role !== null && swimlane?.role !== undefined;

  const isTodoOrDone = swimlane?.role === 'todo' || swimlane?.role === 'done';
  const isPlanMode = permissionMode === 'plan';

  const projectDefaultAgent = currentProject?.default_agent ?? DEFAULT_AGENT;
  const projectDefaultAgentLabel = agentList.find((agent) => agent.name === projectDefaultAgent)?.displayName ?? projectDefaultAgent;
  const effectiveAgent = agentOverride ?? projectDefaultAgent;
  const effectiveAgentInfo = agentList.find((agent) => agent.name === effectiveAgent);
  const agentPermissions = effectiveAgentInfo?.permissions ?? DEFAULT_PERMISSIONS;
  // Capability gates: each control only renders when the active agent's
  // CLI advertises support (discovered at detect time, not hardcoded).
  const effortLevels = effectiveAgentInfo?.capabilities?.effortLevels ?? [];
  const supportsModelOverride = effectiveAgentInfo?.capabilities?.supportsModelOverride ?? false;
  // When the agent ships a curated list (e.g. Claude's `availableModels`),
  // we render a dropdown for nicer UX. Otherwise fall back to a free-form
  // input so the user can type any value the CLI accepts.
  //
  // Session-level cache: merge in any `model_override` values currently saved
  // on other columns for the same effective agent. The CLI capability rescan
  // only sees models that have been written to the agent's session JSONL,
  // which may lag behind a model the user just typed into another column's
  // EditColumnDialog. Pulling from the live swimlanes table closes that gap
  // so the dropdown reflects every model in use across the board.
  const discoveredModels = (() => {
    const merged = new Set(effectiveAgentInfo?.capabilities?.models ?? []);
    for (const lane of swimlanes) {
      if (!lane.model_override) continue;
      const laneAgent = lane.agent_override ?? projectDefaultAgent;
      if (laneAgent !== effectiveAgent) continue;
      merged.add(lane.model_override);
    }
    // Ascending alphabetical: groups by family naturally (the family prefix
    // is shared across versions, e.g. all `claude-opus-*` cluster together)
    // and keeps versions within a family in increasing order.
    return Array.from(merged).sort((a, b) => a.localeCompare(b));
  })();

  const isCustomColor = !PRESET_COLORS.includes(color);
  const usedIcons = getUsedIcons(swimlanes, swimlane?.id);

  useEffect(() => {
    if (isCreateMode) {
      inputRef.current?.focus();
    } else {
      inputRef.current?.select();
    }
    window.electronAPI.agents.list().then(setAgentList).catch(() => {});
  }, [isCreateMode]);

  const handleSave = async () => {
    if (!name.trim()) return;
    if (isCreateMode) {
      const created = await createSwimlane({
        name: name.trim(),
        color,
        icon,
        permission_mode: permissionMode,
        auto_spawn: autoSpawn,
        auto_command: autoCommand.trim() || null,
        plan_exit_target_id: isPlanMode ? (planExitTargetId || null) : undefined,
        agent_override: agentOverride || null,
        model_override: supportsModelOverride && modelOverride.trim() ? modelOverride.trim() : null,
        effort_override: effortLevels.length > 0 ? (effortOverride || null) : null,
        handoff_context: handoffContext,
      });
      // Reorder to place before the Done column (use fresh store state after create)
      const currentSwimlanes = useBoardStore.getState().swimlanes;
      const doneIndex = currentSwimlanes.findIndex((lane) => lane.role === 'done');
      if (doneIndex >= 0) {
        const reordered = currentSwimlanes.filter((lane) => lane.id !== created.id);
        reordered.splice(doneIndex, 0, created);
        await reorderSwimlanes(reordered.map((lane) => lane.id));
      }
      useToastStore.getState().addToast({
        message: `Created column "${created.name}"`,
        variant: 'info',
      });
    } else {
      await updateSwimlane({
        id: swimlane!.id,
        name: name.trim(),
        color,
        icon,
        permission_mode: isTodoOrDone ? undefined : permissionMode,
        auto_spawn: isTodoOrDone ? undefined : autoSpawn,
        auto_command: isTodoOrDone ? undefined : (autoCommand.trim() || null),
        plan_exit_target_id: isPlanMode ? (planExitTargetId || null) : undefined,
        agent_override: isTodoOrDone ? undefined : (agentOverride || null),
        model_override: isTodoOrDone ? undefined : (supportsModelOverride && modelOverride.trim() ? modelOverride.trim() : null),
        effort_override: isTodoOrDone ? undefined : (effortLevels.length > 0 ? (effortOverride || null) : null),
        handoff_context: isTodoOrDone ? undefined : handoffContext,
      });
    }
    onClose();
  };

  const handleDelete = async (_dontAskAgain: boolean) => {
    if (!swimlane) return;
    if (taskCount > 0) {
      useToastStore.getState().addToast({
        message: `Cannot delete "${swimlane.name}". Move or delete all ${taskCount} task${taskCount > 1 ? 's' : ''} first.`,
        variant: 'error',
      });
      onClose();
      return;
    }
    try {
      const colName = swimlane.name;
      await deleteSwimlane(swimlane.id);
      useToastStore.getState().addToast({
        message: `Deleted column "${colName}"`,
        variant: 'info',
      });
      onClose();
    } catch (err: unknown) {
      useToastStore.getState().addToast({
        message: err instanceof Error ? err.message : 'Failed to delete column.',
        variant: 'error',
      });
      onClose();
    }
  };

  if (confirmDelete) {
    return (
      <ConfirmDialog
        title="Delete column"
        message={<>
          <p>Are you sure you want to delete this column?</p>
          <p className="text-fg-secondary bg-surface rounded px-3 py-2 truncate" title={swimlane?.name}>{swimlane?.name}</p>
        </>}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    );
  }

  return (
    <BaseDialog
      onClose={onClose}
      title={isCreateMode ? 'New Column' : 'Edit Column'}
        icon={isCreateMode ? <Plus size={14} className="text-fg-muted" /> : <Pencil size={14} className="text-fg-muted" />}
        headerRight={isLocked ? (
          <span className="text-xs text-fg-faint flex items-center gap-1 flex-shrink-0">
            <Lock size={12} />
            System
          </span>
        ) : undefined}
        footer={
          <div className="flex items-center">
            <div className="flex-1">
              {!isCreateMode && !isLocked && (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-red-400 border border-red-400/40 hover:text-red-300 hover:border-red-300/50 hover:bg-red-400/10 rounded transition-colors"
                >
                  <Trash2 size={13} />
                  Delete
                </button>
              )}
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-1.5 text-xs text-fg-muted hover:text-fg-secondary border border-edge-input hover:border-fg-faint rounded transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={!name.trim()}
                className="px-4 py-1.5 text-xs bg-accent-emphasis hover:bg-accent text-accent-on rounded transition-colors disabled:opacity-50"
              >
                {isCreateMode ? 'Create' : 'Save'}
              </button>
            </div>
          </div>
        }
      >
        <div className="space-y-4">
          {/* Name input */}
          <div>
            <label className="text-xs text-fg-muted mb-1.5 block">Name</label>
            <input
              ref={inputRef}
              type="text"
              placeholder="Column name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
              className="w-full bg-surface border border-edge-input rounded px-3 py-2 text-sm text-fg placeholder-fg-faint focus:outline-none focus:border-accent"
            />
          </div>

          {/* Icon picker */}
          <div>
            <label className="text-xs text-fg-muted mb-1.5 block">Icon</label>
            <button
              type="button"
              onClick={() => setShowIconPicker(true)}
              aria-label={`Choose icon${icon ? `: ${icon}` : ''}`}
              className="w-full flex items-center gap-2.5 bg-surface border border-edge-input hover:border-fg-faint rounded px-3 py-2 transition-colors group"
            >
              <div className="flex-shrink-0">
                {(() => {
                  if (icon) {
                    const IconComp = ICON_REGISTRY.get(icon);
                    if (IconComp) return <IconComp size={14} strokeWidth={1.75} style={{ color }} />;
                  }
                  if (swimlane?.role) {
                    const RoleIcon = ROLE_DEFAULTS[swimlane.role];
                    return <RoleIcon size={14} strokeWidth={1.75} style={{ color }} />;
                  }
                  return (
                    <div
                      className="w-2.5 h-2.5 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                  );
                })()}
              </div>
              <span className="text-xs text-fg-tertiary flex-1 text-left truncate">
                {icon ?? (swimlane?.role ? `Default (${swimlane.role})` : 'None')}
              </span>
              <ChevronRight size={14} className="text-fg-faint group-hover:text-fg-muted flex-shrink-0" />
            </button>
          </div>

          {showIconPicker && (
            <IconPickerDialog
              selectedIcon={icon}
              accentColor={color}
              usedIcons={usedIcons}
              onSelect={(name) => { setIcon(name); setShowIconPicker(false); }}
              onClose={() => setShowIconPicker(false)}
            />
          )}

          {/* Color picker */}
          <div>
            <label className="text-xs text-fg-muted mb-1.5 block">Color</label>
            <div className="flex gap-2 flex-wrap items-center">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => {
                    setColor(c);
                    setHexInput(c);
                    setShowCustomPicker(false);
                  }}
                  aria-label={`Color ${c}${color === c ? ' (selected)' : ''}`}
                  className={`w-6 h-6 rounded-full border-2 transition-all ${
                    color === c ? 'border-white/60 scale-110' : 'border-transparent hover:border-fg-faint'
                  }`}
                  style={{ backgroundColor: c }}
                />
              ))}
              <button
                type="button"
                onClick={() => setShowCustomPicker(!showCustomPicker)}
                className={`w-7 h-7 rounded-full border-2 flex items-center justify-center transition-all ${
                  isCustomColor
                    ? 'border-white/60 scale-110'
                    : showCustomPicker
                      ? 'border-white/60 bg-surface-hover'
                      : 'border-edge-input hover:border-fg-muted bg-surface-raised'
                }`}
                style={isCustomColor ? { backgroundColor: color } : undefined}
                title={isCustomColor ? `Custom color ${color}` : 'Custom color'}
                aria-label={isCustomColor ? `Custom color ${color}` : 'Custom color'}
              >
                <Palette size={12} className={isCustomColor ? 'text-white' : 'text-fg-muted'} />
              </button>
            </div>

            {showCustomPicker && (
              <div className="mt-3 space-y-2">
                <HexColorPicker
                  color={color}
                  onChange={(c) => { setColor(c); setHexInput(c); }}
                  className="!w-full"
                />
                <input
                  type="text"
                  value={hexInput}
                  onChange={(e) => {
                    const v = e.target.value;
                    setHexInput(v);
                    if (/^#[0-9a-fA-F]{6}$/.test(v)) setColor(v.toLowerCase());
                  }}
                  onBlur={() => {
                    if (!/^#[0-9a-fA-F]{6}$/.test(hexInput)) setHexInput(color);
                  }}
                  aria-label="Hex color value"
                  className="w-full bg-surface border border-edge-input rounded px-3 py-1.5 text-sm text-fg font-mono focus:outline-none focus:border-accent"
                  placeholder="#000000"
                  maxLength={7}
                />
              </div>
            )}
          </div>

          {!isTodoOrDone && (<>
            {/* Agent section divider */}
            <div className="flex items-center gap-2 pt-1">
              <span className="text-[11px] text-fg-faint uppercase tracking-wider">Agent</span>
              <div className="flex-1 border-t border-edge-subtle" />
            </div>

            {/* Auto-spawn toggle */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-fg-muted">Auto-spawn</label>
                <button
                  type="button"
                  role="switch"
                  aria-checked={autoSpawn}
                  aria-label="Auto-spawn"
                  onClick={() => setAutoSpawn(!autoSpawn)}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                    autoSpawn ? 'bg-accent' : 'bg-edge-input'
                  }`}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                      autoSpawn ? 'translate-x-[18px]' : 'translate-x-[3px]'
                    }`}
                  />
                </button>
              </div>
              <p className="text-[11px] text-fg-faint mt-1">
                Start an agent when a task enters this column.
              </p>
            </div>

            {/* Agent override dropdown */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs text-fg-muted">Agent</label>
                {agentOverride && (
                  <button
                    type="button"
                    onClick={() => {
                      setAgentOverride(null);
                      // Reset permission to the project default agent's recommended default
                      if (permissionMode) {
                        const newDefault = getAgentDefaultPermission(agentList, projectDefaultAgent);
                        if (newDefault !== permissionMode) setPermissionMode(newDefault);
                      }
                    }}
                    className="flex items-center gap-1 text-[11px] text-fg-faint hover:text-fg-muted transition-colors"
                    title="Reset to project setting"
                  >
                    <RotateCcw size={11} />
                    Reset
                  </button>
                )}
              </div>
              <Select
                value={agentOverride ?? ''}
                onChange={(event) => {
                  const newAgent = event.target.value || null;
                  setAgentOverride(newAgent);
                  // Preserve permission if supported by new agent, otherwise use agent's default
                  if (permissionMode) {
                    const resolved = resolvePermissionForAgent(agentList, newAgent ?? projectDefaultAgent, permissionMode);
                    if (resolved !== permissionMode) setPermissionMode(resolved);
                  }
                }}
                className={DIALOG_SELECT_CLASS}
                data-testid="column-agent-override"
              >
                <option value="">{projectDefaultAgentLabel}</option>
                {agentList
                  .filter((agent) => agent.found && agent.name !== projectDefaultAgent)
                  .map((agent) => (
                    <option key={agent.name} value={agent.name}>
                      {agent.displayName ?? agent.name}
                    </option>
                  ))}
              </Select>
              <p className="text-[11px] text-fg-faint mt-1">
                Override the project default agent for this column.
              </p>
            </div>

            {/* Model override - capability-gated. Combobox supports both
                autocomplete from discovered models and free-form input for
                any model ID the CLI accepts. */}
            {supportsModelOverride && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs text-fg-muted">Model</label>
                  {modelOverride && (
                    <button
                      type="button"
                      onClick={() => setModelOverride('')}
                      className="flex items-center gap-1 text-[11px] text-fg-faint hover:text-fg-muted transition-colors"
                      title="Reset to agent default"
                    >
                      <RotateCcw size={11} />
                      Reset
                    </button>
                  )}
                </div>
                <ModelCombobox
                  value={modelOverride}
                  onChange={setModelOverride}
                  availableModels={discoveredModels}
                  placeholder="Default"
                  testId="column-model-override"
                />
                <p className="text-[11px] text-fg-faint mt-1">
                  Override the model for sessions spawned in this column. Valid values are agent-specific.
                </p>
              </div>
            )}

            {/* Effort override - capability-gated. Options come from the
                live `--help` output of the agent CLI; nothing is hardcoded
                in Kangentic. */}
            {effortLevels.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs text-fg-muted">Effort</label>
                  {effortOverride && (
                    <button
                      type="button"
                      onClick={() => setEffortOverride(null)}
                      className="flex items-center gap-1 text-[11px] text-fg-faint hover:text-fg-muted transition-colors"
                      title="Reset to agent default"
                    >
                      <RotateCcw size={11} />
                      Reset
                    </button>
                  )}
                </div>
                <Select
                  value={effortOverride ?? ''}
                  onChange={(event) => setEffortOverride(event.target.value || null)}
                  className={DIALOG_SELECT_CLASS}
                  data-testid="column-effort-override"
                >
                  <option value="">Default</option>
                  {effortLevels.map((level) => (
                    <option key={level} value={level}>{level}</option>
                  ))}
                </Select>
                <p className="text-[11px] text-fg-faint mt-1">
                  Override the effort/reasoning level for sessions spawned in this column.
                </p>
              </div>
            )}

            {/* Session history passthrough toggle */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-fg-muted">Session history passthrough</label>
                <button
                  type="button"
                  role="switch"
                  aria-checked={handoffContext}
                  aria-label="Session history passthrough"
                  onClick={() => setHandoffContext(!handoffContext)}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                    handoffContext ? 'bg-accent' : 'bg-edge-input'
                  }`}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                      handoffContext ? 'translate-x-[18px]' : 'translate-x-[3px]'
                    }`}
                  />
                </button>
              </div>
              <p className="text-[11px] text-fg-faint mt-1">
                When a task arrives from a different agent, pass the prior agent's session history file to the new agent.
              </p>
            </div>

            {/* Permissions dropdown */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs text-fg-muted">Permissions</label>
                {permissionMode && (
                  <button
                    type="button"
                    onClick={() => setPermissionMode(null)}
                    className="flex items-center gap-1 text-[11px] text-fg-faint hover:text-fg-muted transition-colors"
                    title="Reset to project setting"
                  >
                    <RotateCcw size={11} />
                    Reset
                  </button>
                )}
              </div>
              <Select
                value={permissionMode ?? ''}
                onChange={(event) => setPermissionMode(event.target.value ? event.target.value as PermissionMode : null)}
                className={DIALOG_SELECT_CLASS}
                data-testid="column-permission-mode"
              >
                <option value="">{getPermissionLabel(agentPermissions, globalPermissionMode)}</option>
                {agentPermissions
                  .filter((entry) => entry.mode !== globalPermissionMode)
                  .map((entry) => (
                    <option key={entry.mode} value={entry.mode}>{entry.label}</option>
                  ))}
              </Select>
              <p className="text-[11px] text-fg-faint mt-1">
                Override the project permission mode for this column.
              </p>
            </div>
          </>)}

          {/* After planning dropdown (only for plan-mode columns) */}
          {isPlanMode && (
            <div>
              <label className="text-xs text-fg-muted mb-1.5 block">After Plan Mode</label>
              <Select
                value={planExitTargetId ?? ''}
                onChange={(event) => setPlanExitTargetId(event.target.value || null)}
                className={DIALOG_SELECT_CLASS}
                data-testid="plan-exit-target"
              >
                <option value="">Nowhere (stay in column)</option>
                {swimlanes
                  .filter((lane) => lane.id !== swimlane?.id && lane.role !== 'todo' && lane.role !== 'done')
                  .map((lane) => (
                    <option key={lane.id} value={lane.id}>{lane.name}</option>
                  ))
                }
              </Select>
              <p className="text-[11px] text-fg-faint mt-1">
                Automatically moves the task when the agent exits Plan mode.
              </p>
            </div>
          )}

          {/* Auto-command textarea (hidden for backlog/done -- sessions don't run there) */}
          {!isTodoOrDone && (
            <div>
              <label className="text-xs text-fg-muted mb-1.5 block">Auto-command</label>
              <textarea
                value={autoCommand}
                onChange={(e) => setAutoCommand(e.target.value)}
                rows={2}
                placeholder="/test, /review, or a prompt..."
                className="w-full bg-surface border border-edge-input rounded px-3 py-2 text-sm text-fg font-mono placeholder-fg-faint focus:outline-none focus:border-accent resize-y"
                data-testid="auto-command-input"
              />
              <p className="text-[11px] text-fg-faint mt-1 flex items-center gap-1">
                Runs automatically when a task moves into this column
                <span
                  title="Supports variables: {{title}}, {{description}}, {{branchName}}"
                  className="inline-flex cursor-help text-fg-faint hover:text-fg-muted"
                >
                  <Info size={12} />
                </span>
              </p>
            </div>
          )}

        </div>
      </BaseDialog>
  );
}
