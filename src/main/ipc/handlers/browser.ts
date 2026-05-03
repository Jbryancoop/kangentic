import fs from 'node:fs';
import path from 'node:path';
import { ipcMain, session } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { BROWSER_PARTITION } from '../../../shared/browser-partition';
import type { BrowserCaptureInput } from '../../../shared/types';
import type { IpcContext } from '../ipc-context';
import { browserUrlStore } from '../../browser/browser-url-store';
import { PasteSubmitError } from '../../pty/paste-engine';
import { agentRegistry } from '../../agent/agent-registry';
import {
  buildPromptPayload,
  isValidSessionId,
  isCrossDrivePath,
} from './browser-payload';

// Embedded webview capture-and-send. Persists the composited PNG
// under the session's existing on-disk directory at
// `<projectRoot>/.kangentic/sessions/<sessionId>/captures/`, then injects
// a short text prompt referencing the screenshot via @<relative-path> into
// the task's running PTY.
//
// Why under the session dir: it's already part of Kangentic's lifecycle.
// `cleanupTaskSession` (move-to-Backlog, move-to-Done, task-delete) removes
// the session directory recursively, and `pruneOrphanedDirectories` sweeps
// any stragglers on next project open. Captures inherit that for free, no
// new cleanup hook needed.
//
// Why @<relative-path>: this is the universal format. Claude Code and
// Gemini CLI auto-inject the file as multimodal input on @-mention.
// Agents without @ parsing (Aider, Codex, etc.) see it as natural prose
// with a path and reach for their Read tool. The relative path is
// computed from the agent's cwd, so worktree-cwd tasks see `../..` paths
// (Claude under bypass-permissions reads those fine; other agents inherit
// the same broad permissions in Kangentic's default config).
//
// We DO NOT send the rendered DOM as a sidecar HTML file -- the agent
// already has the codebase, and a full outerHTML dump is mostly noise
// relative to what makes elements findable in source. Instead, when the
// user uses the Inspect picker we send a small structured fingerprint
// (selector, role, testid, accessible name, ancestors, computed styles,
// the element's own outerHTML) optimized for grepping the codebase.
// Mirrors Chrome DevTools MCP's "snapshot over screenshot" guidance.

export function registerBrowserHandlers(context: IpcContext): void {
  ipcMain.handle(IPC.BROWSER_CAPTURE_SEND, async (_event, input: BrowserCaptureInput) => {
    if (!input.sessionId) throw new Error('captureAndSend requires a sessionId');
    if (!input.pngBase64) throw new Error('captureAndSend requires pngBase64');
    if (!input.cwd) throw new Error('captureAndSend requires cwd');

    // Defensive: sessionId is interpolated into a filesystem path. Reject
    // anything that isn't a UUID so a malformed IPC payload can't escape
    // the session directory via path traversal.
    if (!isValidSessionId(input.sessionId)) {
      throw new Error('captureAndSend received malformed sessionId');
    }

    // Always anchor at the project root so this directory lines up with
    // the session dir that resource-cleanup / cleanupTaskSession already
    // manage. Falls back to cwd when no project is open (transient case).
    const projectRoot = context.currentProjectPath ?? input.cwd;
    const captureDir = path.join(projectRoot, '.kangentic', 'sessions', input.sessionId, 'captures');
    await fs.promises.mkdir(captureDir, { recursive: true });

    const stamp = Date.now();
    const filename = `capture-${stamp}.png`;
    const absolutePngPath = path.join(captureDir, filename);
    // Async write so libuv's worker pool handles flush + close before we
    // hand the path to the agent. On Windows, this gives AV scanners a
    // moment to finish their open-on-create scan, avoiding sharing
    // violations when the agent's Read tool opens the file immediately
    // after Send. On Unix it's a no-op cost difference.
    await fs.promises.writeFile(absolutePngPath, Buffer.from(input.pngBase64, 'base64'));

    // Path the agent sees in the prompt is relative to its cwd. For
    // worktree-cwd tasks this starts with `..` (the captures dir lives
    // under the project root, not the worktree); buildPromptPayload
    // POSIX-ifies the separators before emitting the @-mention.
    let relativePngPath = path.relative(input.cwd, absolutePngPath);
    // Windows cross-drive guard: when projectRoot and cwd live on different
    // drives, path.relative returns the absolute target instead of a
    // walked-up path. Falling back to the absolute path keeps the file
    // reachable; the agent's @-mention parser handles either form.
    if (isCrossDrivePath(relativePngPath)) {
      console.warn(`[browser] capture path crosses drives (cwd=${input.cwd}); using absolute path`);
      relativePngPath = absolutePngPath;
    }
    const payload = buildPromptPayload(input, relativePngPath);

    // Look up the session's adapter to get the submission verifier for paste confirmation.
    const agentName = context.sessionManager.getSessionAgentName(input.sessionId);
    const adapter = agentName ? agentRegistry.get(agentName) : undefined;
    const verifier = adapter?.getSubmissionVerifier?.('paste') ?? undefined;

    // Engine handles bracketed-paste wrap, drain, paste-to-Enter gap,
    // and atomic submit. Translate engine errors to renderer-facing toasts.
    try {
      await context.pasteEngine.pasteAndSubmit(input.sessionId, payload, {
        bracketed: true,
        source: 'browser-capture',
        verifier,
      });
    } catch (caught) {
      if (caught instanceof PasteSubmitError) {
        const userMessage = caught.code === 'timeout'
          ? 'Paste timed out - the agent may be busy. Try again.'
          : caught.code === 'no-submission-evidence'
            ? caught.message.includes('bracketed-paste mode')
              ? 'Agent has a permission prompt or modal open. Resolve it in the terminal, then send again.'
              : 'Paste landed but Enter did not submit. Press Enter in the terminal to submit.'
            : 'Paste was cancelled.';
        const error = new Error(userMessage);
        (error as Error & { cause?: unknown }).cause = caught;
        throw error;
      }
      throw caught;
    }

    return { filePath: absolutePngPath };
  });

  // === URL persistence ===
  ipcMain.handle(IPC.BROWSER_URL_GET, (_event, taskId: string) => {
    const projectPath = context.currentProjectPath;
    if (!projectPath) return { projectDefault: null, taskOverride: null };
    const overrides = context.configManager.loadProjectOverrides(projectPath);
    const projectDefault = overrides?.browser?.defaultUrl ?? null;
    const taskOverride = browserUrlStore.get(projectPath, taskId);
    return { projectDefault, taskOverride };
  });

  ipcMain.handle(IPC.BROWSER_URL_SET_TASK, (_event, taskId: string, url: string) => {
    const projectPath = context.currentProjectPath;
    if (!projectPath) throw new Error('No project open');
    if (!url) throw new Error('URL is required');
    browserUrlStore.set(projectPath, taskId, url);
  });

  ipcMain.handle(IPC.BROWSER_URL_CLEAR_TASK, (_event, taskId: string) => {
    const projectPath = context.currentProjectPath;
    if (!projectPath) return;
    browserUrlStore.clear(projectPath, taskId);
  });

  // Wipe the embedded browser's persistent partition. Cookies, localStorage,
  // IndexedDB, service workers, and HTTP/auth caches all go. Per-task URL
  // overrides and the project default URL live elsewhere (browser-urls.json,
  // AppConfig.browser.defaultUrl) and are intentionally left alone. Those
  // are workflow state, not browsing identity.
  ipcMain.handle(IPC.BROWSER_CLEAR_STORAGE, async () => {
    const browserSession = session.fromPartition(BROWSER_PARTITION);
    await browserSession.clearStorageData({
      storages: ['cookies', 'localstorage', 'indexdb', 'shadercache', 'cachestorage', 'serviceworkers'],
    });
    await browserSession.clearCache();
    await browserSession.clearAuthCache();
  });
}
