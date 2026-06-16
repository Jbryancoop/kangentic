import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import type { DiffOnMount, Monaco, MonacoDiffEditor } from '@monaco-editor/react';
import { Loader2, Columns2, Rows2, FileCode } from 'lucide-react';
import { useConfigStore } from '../../../../stores/config-store';
import { NAMED_THEMES } from '../../../../../shared/types';
import type { GitDiffStatus } from '../../../../../shared/types';
import {
  getSavedDiffScroll,
  makeDiffScrollKey,
  resolveDiffScrollAction,
  saveDiffScroll,
} from '../../../../utils/diff-scroll-memory';

interface DiffViewerProps {
  original: string;
  modified: string;
  language: string;
  filePath: string;
  /** Path the displayed `original`/`modified` were fetched for, or null before
   *  the first content arrives. When it does not equal `filePath`, the props
   *  belong to a previously selected file (the stale-content switch window). */
  contentFilePath: string | null;
  /** Task-scoped key under which this file's scroll position is remembered. */
  scrollKey: string;
  status: GitDiffStatus;
  viewMode: 'split' | 'inline';
  onViewModeChange: (mode: 'split' | 'inline') => void;
  binary: boolean;
  /** Extra controls rendered at the right edge of the toolbar, after a divider
   *  (e.g. the task-detail expand/collapse buttons). Omitted by the standalone
   *  TaskChangesDialog, which has no panel-layout controls. */
  trailingControls?: ReactNode;
}

const STATUS_LABELS: Record<GitDiffStatus, { label: string; colorClass: string }> = {
  A: { label: 'Added', colorClass: 'text-green-400' },
  M: { label: 'Modified', colorClass: 'text-yellow-400' },
  D: { label: 'Deleted', colorClass: 'text-red-400' },
  R: { label: 'Renamed', colorClass: 'text-blue-400' },
  C: { label: 'Copied', colorClass: 'text-blue-400' },
  U: { label: 'Untracked', colorClass: 'text-green-300' },
};

/** Last scroll position observed while the displayed content matched its file,
 *  tagged with the memory key it belongs to so a fast A->B->C switch never
 *  commits one file's scroll under another file's key. */
interface TrackedScroll {
  key: string;
  scrollTop: number;
  scrollLeft: number;
}

export function DiffViewer({
  original,
  modified,
  language,
  filePath,
  contentFilePath,
  scrollKey,
  status,
  viewMode,
  onViewModeChange,
  binary,
  trailingControls,
}: DiffViewerProps) {
  const theme = useConfigStore((state) => state.config.theme);
  const themeBase = NAMED_THEMES.find((namedTheme) => namedTheme.id === theme)?.base ?? 'dark';
  const monacoTheme = themeBase === 'dark' ? 'vs-dark' : 'vs';
  const statusConfig = STATUS_LABELS[status];

  const diffEditorRef = useRef<MonacoDiffEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);

  // Refs assigned during render so the once-subscribed Monaco event handlers
  // always read the current file's values, even for scroll events the child
  // DiffEditor fires synchronously while flushing new model content.
  const scrollMemoryKey = makeDiffScrollKey(scrollKey, filePath);
  const scrollMemoryKeyRef = useRef(scrollMemoryKey);
  scrollMemoryKeyRef.current = scrollMemoryKey;
  const contentMatchesRef = useRef(false);
  contentMatchesRef.current = contentFilePath !== null && contentFilePath === filePath && !binary;

  const lastScrollRef = useRef<TrackedScroll | null>(null);
  // Memory key still awaiting its initial positioning; null once consumed.
  const pendingRevealRef = useRef<string | null>(scrollMemoryKey);

  // Applies the saved-scroll restore or first-change reveal for the pending
  // key, once the editor exists and the displayed content matches the file.
  // `allowRevealFromLineChanges` gates reading getLineChanges(): true only from
  // onDidUpdateDiff / onMount, where the diff result is fresh; a plain effect
  // may see a stale (pre-recompute) result, so it restores saved positions only
  // and leaves first visits armed.
  const consumePendingReveal = useCallback((allowRevealFromLineChanges: boolean) => {
    const diffEditor = diffEditorRef.current;
    const memoryKey = scrollMemoryKeyRef.current;
    if (diffEditor === null) return;
    if (pendingRevealRef.current !== memoryKey) return;
    if (!contentMatchesRef.current) return;

    const saved = getSavedDiffScroll(memoryKey);
    if (saved === undefined && !allowRevealFromLineChanges) return;
    const lineChanges = saved === undefined ? diffEditor.getLineChanges() : null;
    const action = resolveDiffScrollAction(saved, lineChanges);
    // null means the diff is not computed yet: stay armed for the next event.
    if (action === null) return;

    const modifiedEditor = diffEditor.getModifiedEditor();
    pendingRevealRef.current = null;
    if (action.kind === 'restore') {
      modifiedEditor.setScrollTop(action.position.scrollTop);
      modifiedEditor.setScrollLeft(action.position.scrollLeft);
    } else if (action.kind === 'revealLineInCenter') {
      modifiedEditor.revealLineInCenter(action.lineNumber, monacoRef.current?.editor.ScrollType.Immediate);
    } else {
      modifiedEditor.setScrollTop(0);
      modifiedEditor.setScrollLeft(0);
    }
    // Seed the tracked position so leaving without further scrolling still
    // commits the position we just applied.
    lastScrollRef.current = {
      key: memoryKey,
      scrollTop: modifiedEditor.getScrollTop(),
      scrollLeft: modifiedEditor.getScrollLeft(),
    };
  }, []);

  const handleEditorMount: DiffOnMount = useCallback((diffEditor, monacoInstance) => {
    diffEditorRef.current = diffEditor;
    monacoRef.current = monacoInstance;
    const modifiedEditor = diffEditor.getModifiedEditor();
    modifiedEditor.onDidScrollChange(() => {
      // Ignore clamp noise: events fired while the displayed content belongs to
      // another file, or before this file has been positioned.
      if (!contentMatchesRef.current) return;
      if (pendingRevealRef.current === scrollMemoryKeyRef.current) return;
      lastScrollRef.current = {
        key: scrollMemoryKeyRef.current,
        scrollTop: modifiedEditor.getScrollTop(),
        scrollLeft: modifiedEditor.getScrollLeft(),
      };
    });
    // Diff recomputes asynchronously; reveal the first change only once it has
    // finished. Known imperfection: two file switches within one sub-second
    // recompute window can consume a reveal against the previous content's line
    // changes (the diff API offers no way to attribute a result to a content
    // version). It self-corrects on revisit.
    diffEditor.onDidUpdateDiff(() => consumePendingReveal(true));
    // The diff may have finished before onMount attached these listeners.
    consumePendingReveal(true);
  }, [consumePendingReveal]);

  // Arm on entering a file; on leaving, commit the tracked scroll under the
  // outgoing key. One cleanup path covers file switch, panel close, dialog
  // close, and ChangesPanel remount (expand/collapse).
  useEffect(() => {
    pendingRevealRef.current = scrollMemoryKey;
    return () => {
      const lastScroll = lastScrollRef.current;
      // Commit only a position tracked for this exact key and only after it was
      // positioned (pending consumed). A file switched away from before its
      // content/positioning arrived stays unvisited.
      if (
        lastScroll !== null &&
        lastScroll.key === scrollMemoryKey &&
        pendingRevealRef.current !== scrollMemoryKey
      ) {
        saveDiffScroll(scrollMemoryKey, {
          scrollTop: lastScroll.scrollTop,
          scrollLeft: lastScroll.scrollLeft,
        });
      }
    };
  }, [scrollMemoryKey]);

  // Fast-path restore: a saved scrollTop does not depend on the diff, so apply
  // it as soon as the displayed content matches instead of waiting a full diff
  // recompute cycle (avoids a visible top-of-file flash on revisit). First
  // visits stay armed until onDidUpdateDiff because getLineChanges() may be
  // stale here.
  useEffect(() => {
    consumePendingReveal(false);
  }, [scrollMemoryKey, contentFilePath, binary, consumePendingReveal]);

  // The binary placeholder unmounts the child DiffEditor, which disposes the
  // editor before this parent effect runs. Drop the stale ref so nothing
  // touches a disposed editor; onMount repopulates it on remount.
  useEffect(() => {
    if (binary) {
      diffEditorRef.current = null;
    }
  }, [binary]);

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-edge flex-shrink-0">
        <FileCode size={12} className="text-fg-muted flex-shrink-0" />
        <span className="text-xs text-fg-secondary truncate">{filePath}</span>
        <span className={`text-xs ${statusConfig.colorClass} flex-shrink-0`}>{statusConfig.label}</span>

        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => onViewModeChange('split')}
            className={`p-1.5 rounded transition-colors ${
              viewMode === 'split' ? 'bg-surface-raised text-fg' : 'text-fg-muted hover:text-fg'
            }`}
            title="Side by side"
            data-testid="diff-view-split"
          >
            <Columns2 size={16} />
          </button>
          <button
            onClick={() => onViewModeChange('inline')}
            className={`p-1.5 rounded transition-colors ${
              viewMode === 'inline' ? 'bg-surface-raised text-fg' : 'text-fg-muted hover:text-fg'
            }`}
            title="Inline"
            data-testid="diff-view-inline"
          >
            <Rows2 size={16} />
          </button>
          {trailingControls && (
            <>
              <div className="w-px h-4 bg-edge mx-1" aria-hidden="true" />
              {trailingControls}
            </>
          )}
        </div>
      </div>

      {/* Editor area - Monaco stays mounted to avoid expensive re-initialization */}
      <div className="flex-1 min-h-0 relative" data-testid="diff-editor-area">
        {binary ? (
          <div className="flex items-center justify-center h-full text-xs text-fg-disabled">
            Binary file - cannot display diff
          </div>
        ) : contentFilePath === null ? (
          // Wait for the first content before mounting Monaco, so the editor is
          // never created with empty placeholder models (whose empty diff would
          // be misread as "no changes" for the first real file).
          <div className="flex items-center justify-center h-full">
            <Loader2 size={20} className="animate-spin text-fg-muted" />
          </div>
        ) : (
          <DiffEditor
            height="100%"
            language={language}
            original={original}
            modified={modified}
            theme={monacoTheme}
            // Set the theme BEFORE the editor is created. Without this, Monaco
            // creates the editor under its default light theme and only swaps to
            // the prop theme afterwards, painting one white frame. A fade hid
            // that frame; the slide-in reveal does not, so we prevent it here.
            beforeMount={(monacoInstance) => monacoInstance.editor.setTheme(monacoTheme)}
            onMount={handleEditorMount}
            options={{
              readOnly: true,
              originalEditable: false,
              renderSideBySide: viewMode === 'split',
              automaticLayout: true,
              scrollBeyondLastLine: false,
              minimap: { enabled: false },
              renderWhitespace: 'boundary',
              fontSize: 12,
              lineHeight: 18,
            }}
            loading={
              <div className="flex items-center justify-center h-full">
                <Loader2 size={20} className="animate-spin text-fg-muted" />
              </div>
            }
          />
        )}
      </div>
    </div>
  );
}
