import { Suspense, lazy } from 'react';
import { Loader2, Play, RotateCcw } from 'lucide-react';
import { TerminalTab } from '../../terminal/TerminalTab';
import { ContextBar } from '../../terminal/ContextBar';
import { PreSpawnContextBar } from '../../terminal/PreSpawnContextBar';
import { ShimmerOverlay } from '../../ShimmerOverlay';
import { SessionSummaryPanel } from '../SessionSummaryPanel';
import { BrowserPane } from '../../browser/BrowserPane';
import { PriorityBadge } from '../../backlog/PriorityBadge';
import { LabelPills } from '../../Pill';
import { useConfigStore } from '../../../stores/config-store';
import { QueuedPlaceholder } from './QueuedPlaceholder';
import { AttachmentThumbnails } from './AttachmentThumbnails';
import type { AttachmentWithPreview } from './useAttachments';
import { MarkdownRenderer } from '../../MarkdownRenderer';
import type { Task, SessionDisplayState } from '../../../../shared/types';
import { useSessionStore } from '../../../stores/session-store';

const ChangesPanel = lazy(() => import('./changes/ChangesPanel').then((module) => ({ default: module.ChangesPanel })));

interface TaskDetailBodyProps {
  task: Task;
  isArchived: boolean;
  isInTodo: boolean;
  hasSessionContext: boolean;
  sessionId: string | null;
  displayKind: SessionDisplayState['kind'];
  isSuspended: boolean;
  toggling: boolean;
  pendingAction: null | 'pausing' | 'resuming';
  pendingCommandLabel: string | null;
  savedAttachments: AttachmentWithPreview[];
  handlePreview: (attachment: AttachmentWithPreview) => void;
  handleOpenExternal: (attachment: AttachmentWithPreview) => void;
  removeAttachment: (id: string) => void;
  handleToggle: () => void;
  changesOpen: boolean;
  projectPath: string;
  resumeFailed?: boolean;
  resumeError?: string;
  onResetSession?: () => void;
  browserOpen: boolean;
}

export function TaskDetailBody({
  task,
  isArchived,
  isInTodo,
  hasSessionContext,
  sessionId,
  displayKind,
  isSuspended,
  toggling,
  pendingAction,
  pendingCommandLabel,
  savedAttachments,
  handlePreview,
  handleOpenExternal,
  removeAttachment,
  handleToggle,
  changesOpen,
  projectPath,
  resumeFailed,
  resumeError,
  onResetSession,
  browserOpen,
}: TaskDetailBodyProps) {
  const labelColors = useConfigStore((state) => state.config.backlog?.labelColors) ?? {};
  const defaultBaseBranch = useConfigStore((state) => state.config.git.defaultBaseBranch);
  const changesViewMode = useSessionStore((state) => state.changesViewMode[task.id] ?? 'split');
  const setChangesViewMode = useSessionStore((state) => state.setChangesViewMode);
  const toggleChangesOpen = useSessionStore((state) => state.toggleChangesOpen);
  const changesExpanded = changesOpen && changesViewMode === 'expanded';
  const handleChangesExpand = () => setChangesViewMode(task.id, 'expanded');
  const handleChangesCollapse = () => setChangesViewMode(task.id, 'split');
  const handleChangesClose = () => toggleChangesOpen(task.id);
  const taskLabels = task.labels ?? [];
  const taskPriority = task.priority ?? 0;
  const hasLabelsOrPriority = taskPriority > 0 || taskLabels.length > 0;

  const labelsAndPriorityRow = hasLabelsOrPriority && (
    <div className="flex flex-wrap items-center gap-1.5">
      <PriorityBadge priority={taskPriority} />
      <LabelPills labels={taskLabels} labelColors={labelColors} />
    </div>
  );

  const thumbnailStrip = (
    <AttachmentThumbnails
      attachments={savedAttachments}
      isEditing={false}
      onPreview={handlePreview}
      onOpenExternal={handleOpenExternal}
      onRemove={removeAttachment}
    />
  );

  // Description view mode with attachment thumbnails (non-archived, non-session)
  const descriptionBar = !isArchived && (task.description || savedAttachments.length > 0 || hasLabelsOrPriority) && !hasSessionContext && (
    <div className="px-4 py-3 border-b border-edge flex-shrink-0 space-y-2">
      {task.description && (
        <MarkdownRenderer content={task.description} />
      )}
      {labelsAndPriorityRow}
      {thumbnailStrip}
    </div>
  );

  // Archived task: description + attachments as scrollable body, summary bar as footer
  if (isArchived) {
    return (
      <>
        <div className="flex-1 min-h-0 overflow-y-auto">
          {(task.description || savedAttachments.length > 0 || hasLabelsOrPriority) ? (
            <div className="px-4 py-4 space-y-3 max-h-[40vh] overflow-y-auto">
              {task.description && (
                <MarkdownRenderer content={task.description} />
              )}
              {labelsAndPriorityRow}
              {thumbnailStrip}
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-fg-disabled text-sm p-8 h-full">
              No description
            </div>
          )}
          <SessionSummaryPanel taskId={task.id} />
        </div>
      </>
    );
  }

  const changesPanelElement = changesOpen && (
    <div
      className={`${changesExpanded ? 'flex-1' : 'w-1/2 border-l border-edge'} min-h-0 flex-shrink-0`}
    >
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-full">
            <Loader2 size={20} className="animate-spin text-fg-muted" />
          </div>
        }
      >
        <ChangesPanel
          entityId={task.id}
          projectPath={projectPath}
          worktreePath={task.worktree_path ?? undefined}
          baseBranch={task.base_branch || defaultBaseBranch || 'main'}
          panelMode={changesViewMode}
          onExpand={handleChangesExpand}
          onCollapse={handleChangesCollapse}
          onClose={handleChangesClose}
        />
      </Suspense>
    </div>
  );

  // Active terminal session
  if (sessionId && displayKind !== 'queued' && displayKind !== 'suspended') {
    // Browser pane takes the right half when toggled on, and is mutually
    // exclusive with the changes panel.
    const terminalWidthClass = (browserOpen || changesOpen) ? 'w-1/2' : 'flex-1';
    const browserPaneElement = browserOpen && (
      <div className="w-1/2 min-h-0 flex-shrink-0 border-l border-edge">
        <BrowserPane
          sessionId={sessionId}
          taskId={task.id}
          cwd={task.worktree_path ?? projectPath}
        />
      </div>
    );

    return (
      <>
        {descriptionBar}
        <div className="flex-1 min-h-0 flex">
          {!changesExpanded && (
            <div className={`${terminalWidthClass} min-h-0 relative`}>
              <div className="absolute inset-0">
                <TerminalTab
                  key={sessionId}
                  sessionId={sessionId}
                  taskId={task.id}
                  active={true}
                />
              </div>
            </div>
          )}
          {browserOpen ? browserPaneElement : changesPanelElement}
        </div>
        <ContextBar sessionId={sessionId} />
      </>
    );
  }

  // Queued
  if (displayKind === 'queued') {
    return <QueuedPlaceholder sessionId={sessionId} />;
  }

  // Suspended or toggling
  if ((isSuspended || toggling) && !isArchived && !isInTodo) {
    if (pendingCommandLabel) {
      return (
        <>
          <div className="flex-1 min-h-0 flex">
            {!changesExpanded && (
              <div className={`${changesOpen ? 'w-1/2' : 'flex-1'} min-h-0 relative`}>
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-surface">
                  <ShimmerOverlay label={pendingCommandLabel} />
                </div>
              </div>
            )}
            {changesPanelElement}
          </div>
          <PreSpawnContextBar taskId={task.id} />
        </>
      );
    }
    // When not toggling, we're in this branch only because isSuspended is true,
    // so the resting state is always "Resume session" with a Play icon. While
    // toggling, the direction depends on the current session status.
    const toggleIcon = toggling
      ? <Loader2 size={16} className="animate-spin" />
      : <Play size={16} />;
    const toggleLabel = !toggling
      ? 'Resume session'
      : pendingAction === 'pausing'
        ? 'Pausing agent...'
        : 'Resuming agent...';
    return (
      <>
        <div className="flex-1 min-h-0 flex">
          {!changesExpanded && (
            <div className={`${changesOpen ? 'w-1/2' : 'flex-1'} flex flex-col items-center justify-center gap-3 bg-surface/50`}>
              <button
                onClick={handleToggle}
                disabled={toggling}
                className="flex items-center gap-2.5 px-6 py-3 rounded-lg bg-accent/20 border border-accent/40 text-base text-accent-fg hover:bg-accent/30 transition-colors disabled:opacity-50"
              >
                {toggleIcon}
                {toggleLabel}
              </button>
              {resumeFailed && onResetSession && (
                <div className="flex flex-col items-center gap-2 mt-1">
                  <p className="text-xs text-fg-muted text-center max-w-sm">
                    {resumeError || 'Session could not be resumed.'}
                  </p>
                  <button
                    onClick={onResetSession}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs text-fg-muted hover:text-fg hover:bg-surface-hover border border-edge-input transition-colors"
                  >
                    <RotateCcw size={14} />
                    Reset session
                  </button>
                </div>
              )}
            </div>
          )}
          {changesPanelElement}
        </div>
        <PreSpawnContextBar taskId={task.id} />
      </>
    );
  }

  // Changes-only view (no session but changes panel open)
  if (changesOpen) {
    return (
      <>
        <div className="flex-1 min-h-0 flex">
          {!changesExpanded && (
            <div className="w-1/2 min-h-0 overflow-y-auto">
              {task.description ? (
                <div className="px-4 py-4 space-y-2">
                  <MarkdownRenderer content={task.description} />
                  {labelsAndPriorityRow}
                  {thumbnailStrip}
                </div>
              ) : (
                <div className="flex items-center justify-center h-full text-fg-disabled text-sm p-8">
                  No active session
                </div>
              )}
            </div>
          )}
          {changesPanelElement}
        </div>
        <PreSpawnContextBar taskId={task.id} />
      </>
    );
  }

  // Empty state
  if (!task.description && savedAttachments.length === 0) {
    return (
      <>
        <div className="flex-1 flex items-center justify-center text-fg-disabled text-sm p-8">
          No active session. Drag this task to a column with a transition to start one.
        </div>
        <PreSpawnContextBar taskId={task.id} />
      </>
    );
  }

  // Description-only view (no session). All earlier branches return, so
  // descriptionBar is truthy here in practice; the conditional spacer keeps
  // the layout consistent if that ever changes (no orphan flex spacer + bar
  // when there's nothing above).
  if (!descriptionBar) {
    return <PreSpawnContextBar taskId={task.id} />;
  }
  return (
    <>
      {descriptionBar}
      <div className="flex-1" />
      <PreSpawnContextBar taskId={task.id} />
    </>
  );
}
