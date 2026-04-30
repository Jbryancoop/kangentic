import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Crosshair, Eraser, Loader2, Pencil, Pin, RotateCcw, Send, Undo2 } from 'lucide-react';
import { useDrawingOverlay } from './useDrawingOverlay';
import { compositeCapture } from './captureComposite';
import { BrowserEmptyState } from './BrowserEmptyState';
import { useBrowserUrl } from './useBrowserUrl';
import { INSPECT_SCRIPT } from './inspectScript';
import { AttachmentChips } from './AttachmentChips';
import { useToastStore } from '../../stores/toast-store';
import type { BrowserPickedElement } from '../../../shared/types';
import type { WebviewElement } from './webview-types';

// Spike: side-pane in TaskDetailDialog that hosts an Electron <webview>, a
// free-draw annotation overlay, and a "Send to agent" button which composites
// the capture, grabs DOM HTML + selected text, and injects a text prompt
// (with @-mention to the saved PNG) into the task's running PTY.

interface BrowserPaneProps {
  sessionId: string;
  taskId: string;
  /**
   * Working directory of the agent's session - either task.worktree_path
   * or the project root. Captures are written under cwd/.kangentic/captures
   * so sandboxed file tools across all agents can read them.
   */
  cwd: string;
}

export function BrowserPane({ sessionId, taskId, cwd }: BrowserPaneProps) {
  const {
    loading: urlLoading,
    effectiveUrl,
    projectDefault,
    saveForProject,
    recordNavigation,
  } = useBrowserUrl(taskId);

  if (urlLoading) {
    return (
      <div className="flex items-center justify-center h-full bg-surface" data-testid="browser-pane-loading">
        <Loader2 size={20} className="animate-spin text-fg-muted" />
      </div>
    );
  }

  if (!effectiveUrl) {
    // Empty state submit goes through the same auto-save path as any other
    // navigation: webview loads -> did-navigate fires -> recordNavigation
    // auto-saves task URL and (since projectDefault is null here) also seeds
    // the project default with a toast.
    return (
      <BrowserEmptyState
        onSubmit={(url) => recordNavigation(url)}
      />
    );
  }

  return (
    <BrowserPaneActive
      sessionId={sessionId}
      taskId={taskId}
      cwd={cwd}
      effectiveUrl={effectiveUrl}
      projectDefault={projectDefault}
      saveForProject={saveForProject}
      recordNavigation={recordNavigation}
    />
  );
}

interface BrowserPaneActiveProps {
  sessionId: string;
  taskId: string;
  cwd: string;
  effectiveUrl: string;
  projectDefault: string | null;
  saveForProject: (url: string) => Promise<void>;
  recordNavigation: (url: string) => void;
}

function BrowserPaneActive({
  sessionId,
  taskId,
  cwd,
  effectiveUrl,
  projectDefault,
  saveForProject,
  recordNavigation,
}: BrowserPaneActiveProps) {
  const [urlInput, setUrlInput] = useState(effectiveUrl);
  const [currentUrl, setCurrentUrl] = useState(effectiveUrl);
  // Lock the initial `src` on first mount. Subsequent navigations go through
  // webview.loadURL() so the webview's internal history is preserved -
  // re-binding the `src` attribute on every render can collapse history to
  // a single step in some webview revisions.
  const [initialSrc] = useState(effectiveUrl);
  const [drawMode, setDrawMode] = useState(false);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pinning, setPinning] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [inspectActive, setInspectActive] = useState(false);
  const [pickedElement, setPickedElement] = useState<BrowserPickedElement | null>(null);

  const webviewRef = useRef<WebviewElement | null>(null);
  const overlayContainerRef = useRef<HTMLDivElement | null>(null);

  const { canvasRef, strokes, handlers, clear, undo } = useDrawingOverlay({ enabled: drawMode });

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    const onUrlChanged = () => {
      try {
        const current = webview.getURL();
        setUrlInput(current);
        setCurrentUrl(current);
        setCanGoBack(webview.canGoBack());
        setCanGoForward(webview.canGoForward());
        if (current && /^https?:/i.test(current)) {
          recordNavigation(current);
        }
      } catch {
        /* webview not yet attached */
      }
    };
    webview.addEventListener('did-navigate', onUrlChanged);
    webview.addEventListener('did-navigate-in-page', onUrlChanged);
    return () => {
      webview.removeEventListener('did-navigate', onUrlChanged);
      webview.removeEventListener('did-navigate-in-page', onUrlChanged);
    };
  }, [recordNavigation]);

  // F5 / Ctrl+R reload when focus is *outside* the embedded webview (e.g. in
  // the URL bar or any pane chrome). The matching main-process
  // before-input-event hook handles the webview-focused case.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isF5 = event.key === 'F5';
      const isCtrlR = (event.ctrlKey || event.metaKey) && (event.key === 'r' || event.key === 'R');
      if (!isF5 && !isCtrlR) return;
      event.preventDefault();
      webviewRef.current?.reload();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const navigate = useCallback((target: string) => {
    const candidate = target.match(/^https?:\/\//i) ? target : `http://${target}`;
    let parsed: URL | null = null;
    try {
      parsed = new URL(candidate);
    } catch {
      setError(`Invalid URL: ${target}`);
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      setError('Only http:// and https:// URLs are allowed.');
      return;
    }
    setError(null);
    const final = parsed.toString();
    // Drive navigation through the webview's own loadURL to keep its history
    // intact across multi-step Back/Forward.
    webviewRef.current?.loadURL(final).catch(() => {
      setError(`Failed to load: ${final}`);
    });
  }, []);

  const handleUrlSubmit = useCallback((event: React.FormEvent) => {
    event.preventDefault();
    navigate(urlInput);
  }, [navigate, urlInput]);

  const handleSaveAsProjectDefault = useCallback(async () => {
    const target = (() => {
      try { return webviewRef.current?.getURL() || currentUrl; } catch { return currentUrl; }
    })();
    if (!target) return;
    setPinning(true);
    try {
      await saveForProject(target);
      useToastStore.getState().addToast({
        message: 'Saved as project default',
        variant: 'success',
      });
    } catch (caught) {
      useToastStore.getState().addToast({
        message: caught instanceof Error ? caught.message : 'Failed to save URL',
        variant: 'error',
      });
    } finally {
      setPinning(false);
    }
  }, [currentUrl, saveForProject]);

  const matchesProjectDefault = !!projectDefault && currentUrl === projectDefault;

  const handleSend = useCallback(async () => {
    const webview = webviewRef.current;
    const overlay = canvasRef.current;
    if (!webview || !overlay) return;
    setSending(true);
    setError(null);
    try {
      const overlayRect = overlay.getBoundingClientRect();
      const pngBase64 = await compositeCapture({
        webview,
        strokes,
        overlayWidth: overlayRect.width,
        overlayHeight: overlayRect.height,
      });
      const selectedText = await webview.executeJavaScript<string>(
        '(function () { const sel = window.getSelection(); return sel ? sel.toString() : ""; })()',
      );
      const url = (() => {
        try { return webview.getURL(); } catch { return currentUrl; }
      })();

      await window.electronAPI.browser.captureAndSend({
        sessionId,
        taskId,
        cwd,
        url,
        pngBase64,
        pickedElement,
        selectedText: selectedText || '',
        note,
      });
      setNote('');
      clear();
      setPickedElement(null);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      // Surface paste/submit failures via toast as well, since the inline
      // error is easy to miss next to the URL bar.
      useToastStore.getState().addToast({
        message,
        variant: 'error',
        duration: 6000,
      });
    } finally {
      setSending(false);
    }
  }, [canvasRef, clear, currentUrl, cwd, note, pickedElement, sessionId, strokes, taskId]);

  // One-shot inspect: enters inspect mode, captures the next click, exits.
  // Esc inside the webview cancels and resolves null. Subsequent clicks
  // need another button press to re-enter. Mutually exclusive with Draw.
  const startInspect = useCallback(async () => {
    const webview = webviewRef.current;
    if (!webview) return;
    setInspectActive(true);
    if (drawMode) setDrawMode(false);
    try {
      const result = await webview.executeJavaScript<BrowserPickedElement | null>(INSPECT_SCRIPT);
      if (result) setPickedElement(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Inspect failed');
    } finally {
      setInspectActive(false);
    }
  }, [drawMode]);

  const cancelInspect = useCallback(() => {
    if (!inspectActive) return;
    setInspectActive(false);
    webviewRef.current
      ?.executeJavaScript("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
      .catch(() => undefined);
  }, [inspectActive]);

  const clearPicked = useCallback(() => {
    setPickedElement(null);
  }, []);

  // Document-level keyboard shortcuts. Skipped when target is a form
  // field so typing the letter `i` in the note input doesn't toggle Inspect.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const inFormField = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      if (key === 'i' && !inFormField) {
        event.preventDefault();
        void startInspect();
      } else if (key === 'd' && !inFormField) {
        event.preventDefault();
        setDrawMode((previous) => {
          if (!previous) cancelInspect();
          return !previous;
        });
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (!sending) void handleSend();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [cancelInspect, handleSend, sending, startInspect]);

  return (
    <div className="flex flex-col h-full min-h-0 bg-surface" data-testid="browser-pane">
      {/* URL bar */}
      <form onSubmit={handleUrlSubmit} className="flex items-center gap-1 px-2 py-1.5 border-b border-edge flex-shrink-0">
        <button
          type="button"
          onClick={() => webviewRef.current?.goBack()}
          disabled={!canGoBack}
          className="p-1.5 text-fg-muted hover:text-fg hover:bg-surface-hover rounded transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-fg-muted disabled:cursor-default"
          title={canGoBack ? 'Back' : 'No earlier page'}
        >
          <ArrowLeft size={14} />
        </button>
        <button
          type="button"
          onClick={() => webviewRef.current?.goForward()}
          disabled={!canGoForward}
          className="p-1.5 text-fg-muted hover:text-fg hover:bg-surface-hover rounded transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-fg-muted disabled:cursor-default"
          title={canGoForward ? 'Forward' : 'No forward page'}
        >
          <ArrowRight size={14} />
        </button>
        <button
          type="button"
          onClick={() => webviewRef.current?.reload()}
          className="p-1.5 text-fg-muted hover:text-fg hover:bg-surface-hover rounded transition-colors"
          title="Reload"
        >
          <RotateCcw size={14} />
        </button>
        <input
          type="text"
          value={urlInput}
          onChange={(event) => setUrlInput(event.target.value)}
          placeholder="https://example.com"
          className="flex-1 bg-surface-input text-fg text-xs px-2 py-1 rounded border border-edge-input focus:outline-none focus:border-accent min-w-0"
          spellCheck={false}
          data-testid="browser-url-input"
        />
        {/* Pressing Enter inside the URL input submits the form -- no Go button needed. */}
        <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
        <button
          type="button"
          onClick={handleSaveAsProjectDefault}
          disabled={matchesProjectDefault || pinning}
          className={`flex items-center justify-center self-stretch aspect-square rounded border transition-colors flex-shrink-0 ${
            matchesProjectDefault
              ? 'bg-accent/15 border-accent/40 text-accent-fg cursor-default'
              : 'bg-surface-input border-edge-input text-fg-muted hover:text-fg hover:bg-surface-hover hover:border-accent/50'
          }`}
          title={matchesProjectDefault
            ? 'This URL is the project default'
            : 'Save as project default for all tasks'}
          aria-label={matchesProjectDefault
            ? 'This URL is the project default'
            : 'Save as project default'}
          data-testid="browser-pin-project"
        >
          {pinning
            ? <Loader2 size={14} className="animate-spin" />
            : <Pin size={14} strokeWidth={matchesProjectDefault ? 2 : 1.75} fill={matchesProjectDefault ? 'currentColor' : 'none'} />}
        </button>
      </form>

      {/* Webview + canvas overlay */}
      <div ref={overlayContainerRef} className="relative flex-1 min-h-0 bg-white">
        {/* `webview` is an Electron-only intrinsic; the typing in webview-types.ts adds it to JSX. */}
        <webview
          ref={webviewRef as unknown as React.Ref<HTMLElement>}
          src={initialSrc}
          partition="persist:kangentic-browser-spike"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
          data-testid="browser-webview"
        />
        <canvas
          ref={canvasRef}
          {...handlers}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            pointerEvents: drawMode ? 'auto' : 'none',
            cursor: drawMode ? 'crosshair' : 'default',
          }}
          data-testid="browser-overlay"
        />
      </div>

      <AttachmentChips
        strokeCount={strokes.length}
        pickedElement={pickedElement}
        onClearStrokes={clear}
        onClearPicked={clearPicked}
      />

      {/* Toolbar: capture zone (left) | flex spacer | compose zone (right) */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-t border-edge flex-shrink-0">
        {/* Capture zone */}
        <button
          type="button"
          onClick={() => {
            setDrawMode((previous) => {
              // Drawing and inspecting both want pointer events; only one
              // at a time. Aborting Inspect's loop is what actually stops
              // the script from intercepting clicks in the webview.
              if (!previous) cancelInspect();
              return !previous;
            });
          }}
          className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${
            drawMode
              ? 'bg-accent/20 text-accent-fg border border-accent/40'
              : 'text-fg-muted hover:text-fg hover:bg-surface-hover border border-transparent'
          }`}
          title="Toggle draw mode (Ctrl/Cmd+D)"
          data-testid="browser-draw-toggle"
        >
          <Pencil size={12} />
          {drawMode ? 'Drawing' : 'Draw'}
        </button>
        <button
          type="button"
          onClick={() => void startInspect()}
          className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${
            inspectActive
              ? 'bg-accent/20 text-accent-fg border border-accent/40'
              : 'text-fg-muted hover:text-fg hover:bg-surface-hover border border-transparent'
          }`}
          title="Click elements to capture their identity (Ctrl/Cmd+I, Esc to exit)"
          data-testid="browser-inspect-toggle"
        >
          <Crosshair size={12} />
          {inspectActive ? 'Inspecting' : 'Inspect'}
        </button>
        <div className="w-px h-4 bg-edge mx-1 flex-shrink-0" aria-hidden="true" />
        <button
          type="button"
          onClick={undo}
          disabled={strokes.length === 0}
          className="flex items-center gap-1 px-2 py-1 rounded text-xs text-fg-muted hover:text-fg hover:bg-surface-hover transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
          title="Undo last stroke"
        >
          <Undo2 size={12} />
          Undo
        </button>
        <button
          type="button"
          onClick={clear}
          disabled={strokes.length === 0}
          className="flex items-center gap-1 px-2 py-1 rounded text-xs text-fg-muted hover:text-fg hover:bg-surface-hover transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
          title="Clear all strokes"
        >
          <Eraser size={12} />
          Clear
        </button>

        {/* Compose zone */}
        <input
          type="text"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !sending) {
              event.preventDefault();
              handleSend();
            }
          }}
          placeholder={notePlaceholder(strokes.length, pickedElement ? 1 : 0)}
          className="flex-1 ml-2 bg-surface-input text-fg text-xs px-2 py-1 rounded border border-edge-input focus:outline-none focus:border-accent min-w-0"
          spellCheck={true}
          data-testid="browser-note-input"
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={sending}
          className="flex items-center gap-1 px-3 py-1 text-xs text-accent-on bg-accent-emphasis hover:bg-accent rounded transition-colors disabled:opacity-50"
          title="Send to agent (Ctrl/Cmd+Enter)"
          data-testid="browser-send"
        >
          {sending ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
          Send
        </button>
      </div>

      {error && (
        <div className="px-2 py-1 text-[11px] text-red-400 flex-shrink-0 border-t border-edge">
          {error}
        </div>
      )}
    </div>
  );
}

/**
 * Rotate placeholder copy based on what's queued so the user sees a
 * concrete example of a useful note.
 */
function notePlaceholder(strokeCount: number, pickedCount: number): string {
  if (pickedCount > 0 && strokeCount > 0) return 'e.g. "Explain what I marked"';
  if (pickedCount > 0) return 'e.g. "Why is this misaligned?"';
  if (strokeCount > 0) return 'e.g. "Match the circled spacing"';
  return 'What should the agent do with this?';
}

