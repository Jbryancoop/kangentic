import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, X, Loader2, Archive } from 'lucide-react';
import { useProjectStore } from '../../stores/project-store';
import { useSessionStore } from '../../stores/session-store';
import { useBoardStore } from '../../stores/board-store';
import { useBacklogStore } from '../../stores/backlog-store';
import { useToastStore } from '../../stores/toast-store';
import { formatRelativeTime } from '../../lib/datetime';
import { useOverlayPhase } from '../../hooks/useOverlayPhase';
import type { SearchHit, SearchHitKind } from '../../../shared/types';

const SEARCH_DEBOUNCE_MS = 200;

type Scope = 'current' | 'all';

interface SearchPaletteProps {
  onClose: () => void;
}

/** Render order - projects float above tasks for fast nav. Each label is
 *  shown exactly once even if there are zero hits in that group. */
const KIND_ORDER: SearchHitKind[] = ['project', 'task', 'backlog', 'session_event'];

const KIND_LABEL: Record<SearchHitKind, string> = {
  project: 'Projects',
  task: 'Tasks',
  backlog: 'Backlog',
  session_event: 'Session events',
};

export function SearchPalette({ onClose }: SearchPaletteProps) {
  const { requestClose, backdropClassName, contentClassName, onAnimationEnd } = useOverlayPhase(
    onClose,
    { variant: 'command-bar', skipEnterOnHmr: true },
  );
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [scope, setScope] = useState<Scope>('current');
  const [results, setResults] = useState<SearchHit[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const backdropMouseDown = useRef(false);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSeq = useRef(0);

  const currentProjectId = useProjectStore((state) => state.currentProject?.id ?? null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      debounceTimer.current = null;
      setDebouncedQuery(query);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceTimer.current !== null) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
    };
  }, [query]);

  useEffect(() => {
    const trimmed = debouncedQuery.trim();
    if (!trimmed) {
      setResults([]);
      setIsSearching(false);
      setSelectedIndex(0);
      return;
    }
    if (!currentProjectId) {
      setResults([]);
      setIsSearching(false);
      return;
    }
    const seq = ++requestSeq.current;
    setIsSearching(true);
    window.electronAPI.search
      .everything({ query: trimmed, scope, currentProjectId })
      .then((hits) => {
        if (seq !== requestSeq.current) return;
        setResults(hits);
        setSelectedIndex(0);
        setIsSearching(false);
      })
      .catch((error) => {
        if (seq !== requestSeq.current) return;
        const message = error instanceof Error ? error.message : String(error);
        useToastStore.getState().addToast({ message, variant: 'error' });
        setResults([]);
        setIsSearching(false);
      });
  }, [debouncedQuery, scope, currentProjectId]);

  const grouped = useMemo(() => {
    const buckets: Partial<Record<SearchHitKind, SearchHit[]>> = {};
    for (const hit of results) {
      (buckets[hit.kind] ??= []).push(hit);
    }
    const flat: SearchHit[] = [];
    const headings: { index: number; label: string; count: number }[] = [];
    for (const kind of KIND_ORDER) {
      const bucket = buckets[kind];
      if (!bucket || bucket.length === 0) continue;
      headings.push({ index: flat.length, label: KIND_LABEL[kind], count: bucket.length });
      flat.push(...bucket);
    }
    return { flat, headings };
  }, [results]);

  const activate = useCallback(async (hit: SearchHit) => {
    const sessionStore = useSessionStore.getState();
    const projectStore = useProjectStore.getState();
    const boardStore = useBoardStore.getState();
    const isCrossProject = hit.projectId !== projectStore.currentProject?.id;

    const switchProjectIfNeeded = async (): Promise<boolean> => {
      if (!isCrossProject) return true;
      try {
        await projectStore.openProject(hit.projectId);
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        useToastStore.getState().addToast({ message, variant: 'error' });
        return false;
      }
    };

    switch (hit.kind) {
      case 'project': {
        if (hit.projectId !== projectStore.currentProject?.id) {
          await switchProjectIfNeeded();
        }
        break;
      }
      case 'task': {
        sessionStore.setPendingOpenTaskId(null);
        if (isCrossProject) {
          sessionStore.setPendingOpenTaskId(hit.taskId);
          if (!(await switchProjectIfNeeded())) {
            sessionStore.setPendingOpenTaskId(null);
            return;
          }
        } else {
          sessionStore.setDetailTaskId(hit.taskId);
        }
        break;
      }
      case 'session_event': {
        sessionStore.setScrollToEventKey(hit.eventKey);
        if (isCrossProject) {
          sessionStore.setPendingOpenTaskId(hit.taskId);
          if (!(await switchProjectIfNeeded())) {
            sessionStore.setPendingOpenTaskId(null);
            sessionStore.setScrollToEventKey(null);
            return;
          }
        } else {
          sessionStore.setDetailTaskId(hit.taskId);
        }
        break;
      }
      case 'backlog': {
        if (isCrossProject && !(await switchProjectIfNeeded())) return;
        boardStore.setActiveView('backlog');
        useBacklogStore.getState().setScrollToBacklogId(hit.backlogId);
        break;
      }
    }
    requestClose();
  }, [requestClose]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      requestClose();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedIndex((currentIndex) =>
        grouped.flat.length === 0 ? 0 : Math.min(currentIndex + 1, grouped.flat.length - 1),
      );
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIndex((currentIndex) => Math.max(currentIndex - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const hit = grouped.flat[selectedIndex];
      if (hit) activate(hit);
    }
  }, [grouped.flat, selectedIndex, activate, requestClose]);

  // Scroll selected row into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const row = list.querySelector<HTMLElement>(`[data-row-index="${selectedIndex}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, results]);

  const trimmedQuery = query.trim();
  const hasQuery = trimmedQuery.length > 0;
  const showEmpty = !hasQuery;
  const showNoMatches = hasQuery && !isSearching && grouped.flat.length === 0;

  return (
    <div
      className={`fixed inset-0 bg-black/60 z-50 ${backdropClassName}`}
      onMouseDown={(event) => { backdropMouseDown.current = event.target === event.currentTarget; }}
      onMouseUp={(event) => {
        if (event.target === event.currentTarget && backdropMouseDown.current) requestClose();
        backdropMouseDown.current = false;
      }}
      onKeyDown={handleKeyDown}
      data-testid="search-palette"
    >
      <div
        className={`absolute top-20 left-1/2 -translate-x-1/2 w-[70%] max-w-3xl ${contentClassName}`}
        onAnimationEnd={onAnimationEnd}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="bg-surface-raised border border-edge rounded-lg shadow-2xl overflow-hidden flex flex-col">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-edge">
            <Search size={16} className="flex-shrink-0 text-fg-disabled" />
            <input
              ref={inputRef}
              data-testid="search-palette-input"
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search tasks, backlog, session events, projects..."
              className="flex-1 min-w-0 bg-transparent text-sm text-fg placeholder-fg-disabled outline-none"
            />
            {isSearching ? (
              <Loader2 size={14} className="text-fg-muted animate-spin flex-shrink-0" />
            ) : null}
            <ScopeToggle scope={scope} onChange={setScope} />
            <button
              type="button"
              onClick={requestClose}
              className="p-1 text-fg-muted hover:text-fg transition-colors rounded hover:bg-surface-hover/60"
              aria-label="Close search"
              data-testid="search-palette-close"
            >
              <X size={14} />
            </button>
          </div>

          <div ref={listRef} className="max-h-[60vh] overflow-y-auto">
            {showEmpty ? (
              <EmptyState />
            ) : showNoMatches ? (
              <div className="px-4 py-6 text-sm text-fg-muted text-center">
                No matches in {scope === 'all' ? 'any project' : 'this project'}.
              </div>
            ) : (
              <ul className="py-1" data-testid="search-palette-results">
                {grouped.headings.map((heading) => (
                  <RenderGroup
                    key={heading.label}
                    heading={heading}
                    flat={grouped.flat}
                    selectedIndex={selectedIndex}
                    onHover={setSelectedIndex}
                    onActivate={activate}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

interface RenderGroupProps {
  heading: { index: number; label: string; count: number };
  flat: SearchHit[];
  selectedIndex: number;
  onHover: (index: number) => void;
  onActivate: (hit: SearchHit) => void;
}

function RenderGroup({ heading, flat, selectedIndex, onHover, onActivate }: RenderGroupProps) {
  // Render rows belonging to this group: indices [heading.index, heading.index + heading.count)
  const rows: { hit: SearchHit; flatIndex: number }[] = [];
  for (let offset = 0; offset < heading.count; offset++) {
    const flatIndex = heading.index + offset;
    rows.push({ hit: flat[flatIndex], flatIndex });
  }
  return (
    <>
      <li className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-fg-disabled">
        {heading.label}
        <span className="ml-2 text-fg-disabled normal-case font-normal">{heading.count}</span>
      </li>
      {rows.map(({ hit, flatIndex }) => (
        <ResultRow
          key={`${hit.kind}-${flatIndex}`}
          hit={hit}
          rowIndex={flatIndex}
          isSelected={flatIndex === selectedIndex}
          onHover={() => onHover(flatIndex)}
          onClick={() => onActivate(hit)}
        />
      ))}
    </>
  );
}

interface ScopeToggleProps {
  scope: Scope;
  onChange: (scope: Scope) => void;
}

function ScopeToggle({ scope, onChange }: ScopeToggleProps) {
  return (
    <div className="flex items-center gap-0.5 rounded-md bg-surface-hover/50 p-0.5 flex-shrink-0">
      <ScopeButton label="This project" active={scope === 'current'} onClick={() => onChange('current')} />
      <ScopeButton label="All projects" active={scope === 'all'} onClick={() => onChange('all')} />
    </div>
  );
}

function ScopeButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'px-2 py-0.5 text-xs rounded transition-colors ' +
        (active ? 'bg-surface-raised text-fg shadow-sm' : 'text-fg-muted hover:text-fg')
      }
    >
      {label}
    </button>
  );
}

function EmptyState() {
  return (
    <div className="px-4 py-8 text-sm text-fg-muted text-center space-y-1">
      <div>Search across tasks, backlog, session events, and projects.</div>
      <div className="text-xs text-fg-disabled">
        Type to find by title, description, or tool call.
      </div>
    </div>
  );
}

interface ResultRowProps {
  hit: SearchHit;
  rowIndex: number;
  isSelected: boolean;
  onHover: () => void;
  onClick: () => void;
}

function ResultRow({ hit, rowIndex, isSelected, onHover, onClick }: ResultRowProps) {
  const before = hit.snippet.slice(0, hit.matchStart);
  const matched = hit.snippet.slice(hit.matchStart, hit.matchEnd);
  const after = hit.snippet.slice(hit.matchEnd);
  return (
    <li>
      <button
        type="button"
        data-row-index={rowIndex}
        data-testid="search-palette-result"
        data-result-kind={hit.kind}
        onClick={onClick}
        onMouseEnter={onHover}
        className={
          'w-full text-left px-3 py-2 flex flex-col gap-1 transition-colors ' +
          (isSelected ? 'bg-surface-hover' : 'hover:bg-surface-hover/60')
        }
      >
        <ResultRowHeader hit={hit} />
        <div className="text-xs text-fg-muted truncate">
          <span>{before}</span>
          <mark className="bg-amber-400/30 text-fg rounded px-0.5">{matched}</mark>
          <span>{after}</span>
        </div>
      </button>
    </li>
  );
}

function ResultRowHeader({ hit }: { hit: SearchHit }) {
  switch (hit.kind) {
    case 'task':
      return (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-fg-muted">{hit.projectName}</span>
          <span className="text-fg-disabled">/</span>
          <span className="text-fg-disabled tabular-nums">#{hit.displayId}</span>
          <span className="text-fg truncate">{hit.taskTitle}</span>
          {hit.archived ? (
            <span className="ml-1 inline-flex items-center gap-1 text-[11px] text-fg-disabled">
              <Archive size={10} /> archived
            </span>
          ) : null}
        </div>
      );
    case 'backlog':
      return (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-fg-muted">{hit.projectName}</span>
          <span className="text-fg-disabled">/</span>
          <span className="text-fg-disabled">Backlog</span>
          <span className="text-fg truncate">{hit.backlogTitle}</span>
        </div>
      );
    case 'session_event':
      return (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-fg-muted">{hit.projectName}</span>
          <span className="text-fg-disabled">/</span>
          <span className="text-fg truncate">{hit.taskTitle}</span>
          <span className="ml-auto text-fg-disabled tabular-nums whitespace-nowrap">
            {formatRelativeTime(new Date(hit.eventTs))}
          </span>
        </div>
      );
    case 'project':
      return (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-fg truncate">{hit.projectName}</span>
          <span className="ml-auto text-fg-disabled truncate">{hit.projectPath}</span>
        </div>
      );
  }
}
