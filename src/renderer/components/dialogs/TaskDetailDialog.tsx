import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Check, Copy, Pencil, Trash2 } from 'lucide-react';
import { useBoardStore } from '../../stores/board-store';
import { useSessionStore } from '../../stores/session-store';
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';
import { resolveShortcutCommand } from '../../../shared/template-vars';
import { PriorityBadge } from '../backlog/PriorityBadge';
import { BaseDialog } from './BaseDialog';
import { ConfirmDialog } from './ConfirmDialog';
import {
  TaskDetailHeader,
  TaskDetailEditForm,
  TaskDetailBody,
  ImagePreviewOverlay,
  useAttachments,
  useBranchConfig,
  useCopyDisplayId,
  useTaskSessionState,
  useTaskActions,
} from './task-detail';
import type { Task, ShortcutConfig } from '../../../shared/types';

interface TaskDetailDialogProps {
  task: Task;
  onClose: () => void;
  initialEdit?: boolean;
}

export function TaskDetailDialog({ task, onClose, initialEdit }: TaskDetailDialogProps) {
  const updateTask = useBoardStore((s) => s.updateTask);
  const deleteTask = useBoardStore((s) => s.deleteTask);
  const moveTask = useBoardStore((s) => s.moveTask);
  const unarchiveTask = useBoardStore((s) => s.unarchiveTask);
  const updateAttachmentCount = useBoardStore((s) => s.updateAttachmentCount);
  const swimlanes = useBoardStore((s) => s.swimlanes);
  const shortcuts = useBoardStore((s) => s.shortcuts);
  const projectPath = useProjectStore((s) => s.currentProject?.path ?? null);
  const killSession = useSessionStore((s) => s.killSession);
  const suspendSession = useSessionStore((s) => s.suspendSession);
  const resumeSession = useSessionStore((s) => s.resumeSession);
  const pendingCommandLabel = useSessionStore((s) => s.pendingCommandLabel[task.id] ?? null);
  const loadBoard = useBoardStore((s) => s.loadBoard);
  const archiveTask = useBoardStore((s) => s.archiveTask);
  const skipDeleteConfirm = useConfigStore((s) => s.config.skipDeleteConfirm);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const browserEnabledConfig = useConfigStore((s) => s.config.browser?.enabled);

  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [prUrl, setPrUrl] = useState(task.pr_url ?? '');
  const [labels, setLabels] = useState<string[]>(task.labels ?? []);
  const [priority, setPriority] = useState(task.priority ?? 0);
  // Per-task agent/model/effort overrides. Empty string represents "use
  // column default" in the form; converts to null on save. Initialized from
  // the persisted task row so re-opening edit shows the current state.
  const [agentOverride, setAgentOverride] = useState(task.agent_override ?? '');
  const [modelOverride, setModelOverride] = useState(task.model_override ?? '');
  const [effortOverride, setEffortOverride] = useState(task.effort_override ?? '');
  const [isEditing, setIsEditing] = useState(!!initialEdit);
  const changesOpen = useSessionStore((s) => s.changesOpenTasks.has(task.id));
  const toggleChangesOpen = useSessionStore((s) => s.toggleChangesOpen);
  // Browser pane toggle persists across dialog open/close, mirroring the
  // Changes panel's per-task state. Mutually exclusive with changes.
  const browserOpen = useSessionStore((s) => s.browserOpenTasks.has(task.id));
  const toggleBrowserOpen = useSessionStore((s) => s.toggleBrowserOpen);
  // Maximize toggle persists across dialog open/close, mirroring the
  // Changes/Browser per-task state.
  const isMaximized = useSessionStore((s) => s.maximizedTasks.has(task.id));
  const toggleMaximized = useSessionStore((s) => s.toggleMaximized);

  const isArchived = task.archived_at !== null;
  const currentSwimlane = swimlanes.find((s) => s.id === task.swimlane_id);
  const isInTodo = currentSwimlane?.role === 'todo';

  const attachments = useAttachments(task.id, updateAttachmentCount);
  const branchConfig = useBranchConfig(task, title, isInTodo);

  // Session state + related side effects live in a dedicated hook.
  const sessionState = useTaskSessionState({
    task,
    isEditing,
    isArchived,
    isInTodo: isInTodo ?? false,
    currentSwimlaneRole: currentSwimlane?.role,
  });

  // Action handlers + their transient state (pendingAction, confirmations,
  // pendingSaveRef) are split into a hook to keep this file focused on
  // layout. The hook uses the session state we computed above, and the
  // dialog then ORs `toggling` with `hasSessionContext` below to keep
  // the large layout active during a suspend/resume transition.
  const actions = useTaskActions({
    task,
    onClose,
    initialEdit,
    title,
    description,
    prUrl,
    labels,
    priority,
    agentOverride,
    modelOverride,
    effortOverride,
    setTitle,
    setDescription,
    setPrUrl,
    setLabels,
    setPriority,
    setAgentOverride,
    setModelOverride,
    setEffortOverride,
    setIsEditing,
    branchConfig,
    session: sessionState.session,
    isSessionActive: sessionState.isSessionActive,
    hasSessionContext: sessionState.hasSessionContext,
    isSuspended: sessionState.isSuspended,
    canToggle: sessionState.canToggle,
    displayState: sessionState.displayState,
    isArchived,
    isInTodo: isInTodo ?? false,
    swimlanes,
    updateTask,
    deleteTask,
    moveTask,
    unarchiveTask,
    archiveTask,
    loadBoard,
    killSession,
    suspendSession,
    resumeSession,
    skipDeleteConfirm,
    updateConfig,
  });

  // Keep the dialog in large mode during a pending suspend/resume
  // transition even if displayState briefly reports 'exited'.
  const hasSessionContext = sessionState.hasSessionContext || actions.toggling;

  // Dialog sizing depends on session/edit/maximize state. Maximize only
  // applies in the view header (edit mode uses the small standard header,
  // which has no maximize button).
  const needsLargeDialog = hasSessionContext || changesOpen || browserOpen;
  const isDialogMaximized = !isEditing && isMaximized;
  const dialogSizeClass = isDialogMaximized
    ? 'w-full h-full'
    : isEditing || !needsLargeDialog
      ? (sessionState.isQueued ? 'w-[520px] h-[320px]' : 'w-[700px]')
      : 'w-[90vw] h-[85vh]';
  // When maximized, inset the backdrop to the content area between the title
  // bar (h-10 = 40px) and status bar (h-9 = 36px) so the app's window
  // controls and live stats stay visible and clickable. Drop the backdrop
  // padding so the dialog fills that region.
  const backdropPositionClass = isDialogMaximized ? 'inset-x-0 top-10 bottom-9' : 'inset-0';
  const backdropPadding = isDialogMaximized ? '' : 'p-6';
  // Square the corners when maximized so the border meets the screen edges flush.
  const contentRadiusClass = isDialogMaximized ? 'rounded-none' : 'rounded-lg';

  const handleToggleMaximized = useCallback(() => toggleMaximized(task.id), [toggleMaximized, task.id]);

  const handleToggleBrowser = useCallback(() => {
    // Mutually exclusive with the changes panel for the 2-col layout.
    if (!browserOpen && changesOpen) toggleChangesOpen(task.id);
    toggleBrowserOpen(task.id);
  }, [browserOpen, changesOpen, toggleBrowserOpen, toggleChangesOpen, task.id]);

  const handleToggleChanges = useCallback(() => {
    if (!changesOpen && browserOpen) toggleBrowserOpen(task.id);
    toggleChangesOpen(task.id);
  }, [browserOpen, changesOpen, toggleBrowserOpen, toggleChangesOpen, task.id]);
  // Browser pane only renders inside the body's active-session branch, which
  // requires a live (non-queued, non-suspended) session. Match that here so
  // the toggle pill doesn't appear when clicking it would do nothing. Also
  // gate on the project-level `browser.enabled` setting so security-sensitive
  // projects can disable the pane entirely.
  const browserEnabled = browserEnabledConfig !== false;
  const canShowBrowser = browserEnabled
    && !!sessionState.session?.id
    && sessionState.displayState.kind !== 'queued'
    && sessionState.displayState.kind !== 'suspended';

  const { copied: displayIdCopied, copy: copyDisplayId } = useCopyDisplayId(task.display_id);

  // Columns available as move targets: exclude current column and Done column (for archived tasks)
  const moveTargets = useMemo(() =>
    swimlanes.filter((candidate) => {
      if (candidate.id === task.swimlane_id) return false;
      if (isArchived && candidate.role === 'done') return false;
      return true;
    }),
    [swimlanes, task.swimlane_id, isArchived],
  );

  const headerShortcuts = useMemo(
    () => shortcuts.filter((action) => action.command && (!action.display || action.display === 'header' || action.display === 'both')),
    [shortcuts],
  );

  const menuShortcuts = useMemo(
    () => shortcuts.filter((action) => action.command && (!action.display || action.display === 'menu' || action.display === 'both')),
    [shortcuts],
  );

  const executeShortcut = useCallback((action: ShortcutConfig) => {
    const cwd = task.worktree_path ?? projectPath ?? '';
    const resolved = resolveShortcutCommand(action.command, {
      cwd,
      branchName: task.branch_name ?? '',
      taskTitle: task.title,
      projectPath: projectPath ?? '',
    });
    window.electronAPI.shell.exec(resolved, cwd);
  }, [task, projectPath]);

  // Auto-save and exit edit mode when a session appears
  const hadSessionContext = useRef(hasSessionContext);
  const editingRef = useRef(isEditing);
  const titleRef = useRef(title);
  const descriptionRef = useRef(description);
  const labelsRef = useRef(labels);
  const priorityRef = useRef(priority);
  editingRef.current = isEditing;
  titleRef.current = title;
  descriptionRef.current = description;
  labelsRef.current = labels;
  priorityRef.current = priority;
  useEffect(() => {
    if (!hadSessionContext.current && hasSessionContext && editingRef.current) {
      updateTask({
        id: task.id,
        title: titleRef.current,
        description: descriptionRef.current,
        labels: labelsRef.current,
        priority: priorityRef.current,
      });
      setIsEditing(false);
    }
    hadSessionContext.current = hasSessionContext;
  }, [hasSessionContext, task.id, updateTask]);

  // Task-detail hotkeys. All are Ctrl/Cmd+Shift combos. We listen in CAPTURE
  // phase so we intercept before the embedded xterm consumes the Ctrl-letter
  // control chars (Ctrl+X = 0x18, Ctrl+B = 0x02, Ctrl+M = CR); a bubble-phase
  // listener never fires for those while the terminal has focus. We deliberately
  // do NOT bind Escape in this handler; BaseDialog keeps its own document-level
  // Escape-to-close listener (we never pass preventBackdropClose), which still
  // dismisses the dialog when focus is outside the terminal. A focused xterm
  // consumes Escape first, so it stays available to the Claude TUI.
  //   Ctrl/Cmd+Shift+M - toggle maximize (view mode only, matching the button)
  //   Ctrl/Cmd+Shift+W - close the dialog (works in every mode)
  //   Ctrl/Cmd+Shift+B - toggle the Browser pane (when available); while the
  //                      dialog is open it shadows the global board/backlog toggle
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === 'm' && !isEditing) {
        event.preventDefault();
        event.stopPropagation();
        toggleMaximized(task.id);
        return;
      }
      if (key === 'w') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (key === 'b' && canShowBrowser) {
        event.preventDefault();
        event.stopPropagation();
        handleToggleBrowser();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isEditing, toggleMaximized, task.id, onClose, canShowBrowser, handleToggleBrowser]);

  // Maximizing resizes the dialog container, so nudge the embedded terminal to
  // refit through the fast (50ms) terminal-panel-resize path, mirroring the
  // edit-mode refit in useTaskSessionState. Without this the terminal only
  // reflows on TerminalTab's slower 200ms ResizeObserver fallback, lagging the
  // equivalent refit CommandBarOverlay performs on its own maximize toggle.
  useEffect(() => {
    if (!hasSessionContext) return;
    const refitTimer = setTimeout(() => {
      window.dispatchEvent(new Event('terminal-panel-resize'));
    }, 100);
    return () => clearTimeout(refitTimer);
  }, [isDialogMaximized, hasSessionContext]);

  // -- Render --

  if (actions.confirmSendToBacklog) {
    return (
      <ConfirmDialog
        title="Send to Backlog"
        message={<>
          <p>This will move &quot;{task.title}&quot; to the backlog and clean up its session and worktree.</p>
          <p className="text-fg-muted mt-1">You can move it back to the board later.</p>
        </>}
        confirmLabel="Send to Backlog"
        showDontAskAgain
        onConfirm={(dontAskAgain) => {
          if (dontAskAgain) updateConfig({ skipDeleteConfirm: true });
          actions.executeSendToBacklog();
        }}
        onCancel={() => actions.setConfirmSendToBacklog(false)}
      />
    );
  }

  if (actions.confirmDelete) {
    return (
      <ConfirmDialog
        title="Delete task"
        message={<>
          <p>This will permanently delete the task, its session history, and any associated worktree.</p>
          <p className="text-red-400 font-medium">This action cannot be undone.</p>
        </>}
        confirmLabel="Delete"
        variant="danger"
        showDontAskAgain
        onConfirm={actions.handleDelete}
        onCancel={() => actions.setConfirmDelete(false)}
      />
    );
  }

  const customHeader = (
    <TaskDetailHeader
      task={task}
      onClose={onClose}
      isEditing={isEditing}
      setIsEditing={setIsEditing}
      canToggle={sessionState.canToggle}
      isSessionActive={sessionState.isSessionActive}
      isQueued={sessionState.isQueued}
      isArchived={isArchived}
      isIsolated={currentSwimlane?.session_target === 'isolated'}
      toggling={actions.toggling}
      onToggle={actions.handleToggle}
      onCommandSelect={actions.handleCommandSelect}
      onArchive={actions.handleArchive}
      onSendToBacklog={actions.handleSendToBacklog}
      onDelete={() => skipDeleteConfirm ? actions.handleDelete(false) : actions.setConfirmDelete(true)}
      onMoveTo={actions.handleMoveTo}
      moveTargets={moveTargets}
      headerShortcuts={headerShortcuts}
      menuShortcuts={menuShortcuts}
      executeShortcut={executeShortcut}
      projectPath={projectPath}
      canShowChanges={sessionState.canShowChanges}
      changesOpen={changesOpen}
      onToggleChanges={handleToggleChanges}
      canShowBrowser={canShowBrowser}
      browserOpen={browserOpen}
      onToggleBrowser={handleToggleBrowser}
      isMaximized={isDialogMaximized}
      onToggleMaximized={handleToggleMaximized}
    />
  );

  return (
    <>
      <BaseDialog
        onClose={onClose}
        {...(isEditing
          ? {
            title: (
              <span className="flex items-center gap-2">
                Edit Task
                <button
                  type="button"
                  className="flex items-center gap-1 text-sm font-mono text-fg-muted hover:text-fg-secondary transition-colors font-normal"
                  title={`Click to copy: ${task.display_id}`}
                  data-testid="task-display-id"
                  onClick={copyDisplayId}
                >
                  {displayIdCopied
                    ? <Check size={12} className="text-green-400" />
                    : <Copy size={12} className="text-fg-disabled" />
                  }
                  #{task.display_id}
                </button>
                <PriorityBadge priority={task.priority ?? 0} />
              </span>
            ),
            icon: <Pencil size={14} className="text-fg-muted" />,
          }
          : { header: customHeader, rawBody: true }
        )}
        className={dialogSizeClass}
        backdropClassName={backdropPadding}
        backdropPositionClass={backdropPositionClass}
        contentRadiusClass={contentRadiusClass}
        testId="task-detail-dialog"
        footer={isEditing ? (
          <div className={`flex ${isInTodo ? 'justify-between' : 'justify-end'} items-center`}>
            {isInTodo && (
              <button
                onClick={() => skipDeleteConfirm ? actions.handleDelete(false) : actions.setConfirmDelete(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-fg-faint hover:text-red-400 hover:bg-red-400/10 rounded transition-colors"
              >
                <Trash2 size={14} />
                Delete
              </button>
            )}
            <div className="flex items-center gap-2">
              <button
                onClick={actions.handleCancel}
                className="px-3 py-1.5 text-xs text-fg-muted hover:text-fg-secondary border border-edge-input hover:border-fg-faint rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={actions.handleSave}
                disabled={!!branchConfig.branchNameError}
                className={`px-3 py-1.5 text-xs rounded transition-colors ${
                  branchConfig.branchNameError
                    ? 'bg-accent-emphasis/50 text-accent-on/50 cursor-not-allowed'
                    : 'bg-accent-emphasis hover:bg-accent text-accent-on'
                }`}
              >
                Save
              </button>
            </div>
          </div>
        ) : undefined}
      >
        {isEditing && (
          <TaskDetailEditForm
            task={task}
            title={title}
            setTitle={setTitle}
            description={description}
            setDescription={setDescription}
            prUrl={prUrl}
            setPrUrl={setPrUrl}
            labels={labels}
            setLabels={setLabels}
            priority={priority}
            setPriority={setPriority}
            agentOverride={agentOverride}
            setAgentOverride={setAgentOverride}
            modelOverride={modelOverride}
            setModelOverride={setModelOverride}
            effortOverride={effortOverride}
            setEffortOverride={setEffortOverride}
            attachments={attachments}
            branchConfig={branchConfig}
            isSessionActive={sessionState.isSessionActive}
            isArchived={isArchived}
            isInTodo={isInTodo}
          />
        )}

        {!isEditing && (
          <TaskDetailBody
            task={task}
            isArchived={isArchived}
            isInTodo={isInTodo}
            hasSessionContext={hasSessionContext}
            sessionId={sessionState.session?.id ?? null}
            displayKind={sessionState.displayState.kind}
            isSuspended={sessionState.isSuspended}
            toggling={actions.toggling}
            pendingAction={actions.pendingAction}
            pendingCommandLabel={pendingCommandLabel}
            savedAttachments={attachments.savedAttachments}
            handlePreview={attachments.handlePreview}
            handleOpenExternal={attachments.handleOpenExternal}
            removeAttachment={attachments.removeAttachment}
            handleToggle={actions.handleToggle}
            changesOpen={changesOpen}
            projectPath={projectPath ?? ''}
            resumeFailed={actions.resumeFailed}
            resumeError={actions.resumeError}
            onResetSession={actions.handleResetSession}
            browserOpen={browserOpen}
          />
        )}
      </BaseDialog>

      {/* Enable worktree confirmation */}
      {actions.showEnableWorktreeConfirm && (
        <ConfirmDialog
          title="Enable worktree?"
          message="This will create an isolated worktree for this task. Your session history will be preserved and the agent will continue from where it left off in the new worktree."
          confirmLabel="Enable"
          variant="default"
          onConfirm={async () => {
            actions.setShowEnableWorktreeConfirm(false);
            if (actions.pendingSaveRef.current) {
              await actions.pendingSaveRef.current();
              actions.pendingSaveRef.current = null;
            }
          }}
          onCancel={() => {
            actions.setShowEnableWorktreeConfirm(false);
            actions.pendingSaveRef.current = null;
          }}
        />
      )}

      {/* Full-size preview overlay */}
      {attachments.previewAttachment && (
        <ImagePreviewOverlay
          url={attachments.previewAttachment.url}
          filename={attachments.previewAttachment.filename}
          onClose={attachments.closePreview}
        />
      )}
    </>
  );
}
