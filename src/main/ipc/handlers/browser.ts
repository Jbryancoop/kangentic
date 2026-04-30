import fs from 'node:fs';
import path from 'node:path';
import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import type { BrowserCaptureInput, BrowserPickedElement } from '../../../shared/types';
import type { IpcContext } from '../ipc-context';
import { browserUrlStore } from '../../browser/browser-url-store';
import { PasteSubmitError } from '../../pty/paste-engine';

// Spike: embedded webview capture-and-send. Persists the composited PNG
// inside the agent's cwd (task.worktree_path or project root) under
// .kangentic/captures/, then injects a short text prompt referencing the
// screenshot via @<relative-path> into the task's running PTY.
//
// Why inside the cwd: every supported agent CLI sandboxes its file-read
// tools to its working directory. Writing to os.tmpdir() means Claude
// and friends refuse to read the file ("can't access path"). Writing
// inside cwd under the already-gitignored .kangentic/ keeps captures
// reachable without polluting git status.
//
// Why @<relative-path>: this is the universal format. Claude Code and
// Gemini CLI auto-inject the file as multimodal input on @-mention.
// Agents without @ parsing (Aider, Codex, etc.) see it as natural prose
// with a path and reach for their Read tool. No agent-specific branching.
//
// We DO NOT send the rendered DOM as a sidecar HTML file -- the agent
// already has the codebase, and a full outerHTML dump is mostly noise
// relative to what makes elements findable in source. Instead, when the
// user uses the Inspect picker we send a small structured fingerprint
// (selector, role, testid, accessible name, ancestors, computed styles,
// the element's own outerHTML) optimized for grepping the codebase.
// Mirrors Chrome DevTools MCP's "snapshot over screenshot" guidance.

const CAPTURE_REL_DIR = path.join('.kangentic', 'captures');

const SELECTION_INLINE_LIMIT = 800;

function formatRect(rect: BrowserPickedElement['rect']): string {
  return `${Math.round(rect.width)}x${Math.round(rect.height)} at (${Math.round(rect.x)}, ${Math.round(rect.y)})`;
}

// Browser-default values that add no signal for an LLM.
const STYLE_DEFAULT_DROPS = new Set<string>([
  'normal', 'auto', 'none', '0px', '0', '1', 'static',
  'rgba(0, 0, 0, 0)', 'rgb(0, 0, 0, 0)', 'transparent',
]);

// width/height duplicate the `rect` line; display value tracks the tag's
// natural default for text-flow elements. Drop both so the styles block
// stays focused on what's actually styled.
const STYLE_KEYS_TO_DROP = new Set<string>(['width', 'height', 'display']);

function isMeaningfulStyle(key: string, value: string): boolean {
  if (!value) return false;
  if (STYLE_KEYS_TO_DROP.has(key)) return false;
  if (STYLE_DEFAULT_DROPS.has(value)) return false;
  // Common no-op patterns
  if (value === '0px 0px 0px 0px') return false;
  if (key === 'border' && /^0px/.test(value)) return false;
  if (key === 'opacity' && value === '1') return false;
  return true;
}

function formatStyles(styles: Record<string, string>): string[] {
  const meaningful = Object.entries(styles).filter(([key, value]) => isMeaningfulStyle(key, value));
  if (meaningful.length === 0) return ['(defaults)'];
  return meaningful.map(([key, value]) => `${key}: ${value}`);
}

function formatAncestors(ancestors: BrowserPickedElement['ancestors']): string {
  if (ancestors.length === 0) return '(none)';
  return ancestors
    .map((ancestor) => {
      const parts: string[] = [ancestor.tagName.toLowerCase()];
      if (ancestor.id) parts.push(`#${ancestor.id}`);
      if (ancestor.testId) parts.push(`[data-testid="${ancestor.testId}"]`);
      if (ancestor.classes.length > 0) parts.push(`.${ancestor.classes.slice(0, 3).join('.')}`);
      if (ancestor.role) parts.push(`[role="${ancestor.role}"]`);
      return parts.join('');
    })
    .join(' > ');
}

// True when outerHTML is just the open tag + plain text + close tag with no
// nested elements. In that case the structured fields (classes, text) already
// cover everything and re-printing the markup is just noise.
function isTrivialWrapper(outerHTML: string): boolean {
  const inner = outerHTML.replace(/^<[^>]+>/, '').replace(/<\/[^>]+>\s*$/, '');
  return !/<[a-zA-Z]/.test(inner);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Anthropic + OpenAI canonical guidance: wrap prompt input data in XML tags
// so the model sees a clear data/instruction boundary. Aider/Codex/etc treat
// the markup as harmless prose; the structured fields stay readable.
function formatPickedElementXml(element: BrowserPickedElement): string[] {
  const lines: string[] = ['<picked_element>'];
  lines.push(`  <selector>${escapeXml(element.selector)}</selector>`);
  if (element.testId) lines.push(`  <testid>${escapeXml(element.testId)}</testid>`);
  if (element.role) lines.push(`  <role>${escapeXml(element.role)}</role>`);
  if (element.id) lines.push(`  <id>${escapeXml(element.id)}</id>`);
  if (element.classes.length > 0) {
    lines.push(`  <classes>${escapeXml(element.classes.join(', '))}</classes>`);
  }

  // accessibleName and text frequently match for text-heavy elements;
  // prefer accessibleName and only emit `text` when it adds new info.
  const accessibleName = (element.accessibleName || '').trim();
  const text = (element.text || '').trim();
  if (accessibleName) {
    lines.push(`  <accessible_name>${escapeXml(accessibleName)}</accessible_name>`);
  }
  if (element.ariaLabel && element.ariaLabel.trim() !== accessibleName) {
    lines.push(`  <aria_label>${escapeXml(element.ariaLabel.trim())}</aria_label>`);
  }
  if (text && text !== accessibleName) {
    lines.push(`  <text>${escapeXml(text)}</text>`);
  }

  const rect = element.rect;
  lines.push(`  <rect x="${Math.round(rect.x)}" y="${Math.round(rect.y)}" width="${Math.round(rect.width)}" height="${Math.round(rect.height)}" />`);

  const styleLines = formatStyles(element.computedStyles);
  if (styleLines.length === 1 && styleLines[0] === '(defaults)') {
    lines.push('  <styles />');
  } else {
    lines.push('  <styles>');
    for (const style of styleLines) {
      lines.push(`    ${escapeXml(style)}`);
    }
    lines.push('  </styles>');
  }

  if (element.ancestors.length > 0) {
    lines.push(`  <ancestors>${escapeXml(formatAncestors(element.ancestors))}</ancestors>`);
  }

  // Skip outerHTML when it's just <tag>text</tag> -- already covered by classes/text.
  if (element.outerHTML && !isTrivialWrapper(element.outerHTML)) {
    lines.push('  <outer_html>');
    for (const part of element.outerHTML.split('\n')) {
      lines.push(`    ${escapeXml(part)}`);
    }
    lines.push('  </outer_html>');
  }

  lines.push('</picked_element>');
  return lines;
}

function buildPromptPayload(input: BrowserCaptureInput, relativePngPath: string): string {
  const lines: string[] = [];
  const note = input.note.trim();
  if (note) {
    lines.push(note);
  } else {
    lines.push('Look at this browser capture and tell me what you see.');
  }
  lines.push('');

  // Screenshot @-mention stays at top-level (outside the XML envelope) so
  // Claude Code / Gemini CLI's bare-token @-parsers reliably auto-inject
  // it as multimodal input. POSIX-style path for cross-platform safety.
  const posixPath = relativePngPath.split(path.sep).join('/');
  lines.push(`Screenshot: @${posixPath}`);
  lines.push('');

  // XML envelope for the structured browser context. Per Anthropic +
  // OpenAI prompt-engineering guidance, XML tags give the model a clear
  // data/instruction boundary. Non-XML-aware agents see harmless prose.
  lines.push('<browser_context>');
  lines.push(`  <url>${escapeXml(input.url)}</url>`);

  if (input.pickedElement) {
    for (const line of formatPickedElementXml(input.pickedElement)) {
      lines.push(`  ${line}`);
    }
  }

  const selection = input.selectedText.trim();
  if (selection) {
    if (selection.length <= SELECTION_INLINE_LIMIT) {
      lines.push(`  <selected_text>${escapeXml(selection)}</selected_text>`);
    } else {
      lines.push(`  <selected_text truncated="true">${escapeXml(selection.slice(0, SELECTION_INLINE_LIMIT))}...</selected_text>`);
    }
  }

  lines.push('</browser_context>');

  return lines.join('\n');
}

export function registerBrowserHandlers(context: IpcContext): void {
  ipcMain.handle(IPC.BROWSER_CAPTURE_SEND, async (_event, input: BrowserCaptureInput) => {
    if (!input.sessionId) throw new Error('captureAndSend requires a sessionId');
    if (!input.pngBase64) throw new Error('captureAndSend requires pngBase64');
    if (!input.cwd) throw new Error('captureAndSend requires cwd');

    const captureDir = path.join(input.cwd, CAPTURE_REL_DIR);
    fs.mkdirSync(captureDir, { recursive: true });

    const stamp = Date.now();
    const filename = `capture-${stamp}.png`;
    const absolutePngPath = path.join(captureDir, filename);
    fs.writeFileSync(absolutePngPath, Buffer.from(input.pngBase64, 'base64'));

    // Path the agent will see in the prompt: relative to its cwd so any
    // sandboxed Read tool can resolve it without absolute-path issues.
    const relativePngPath = path.join(CAPTURE_REL_DIR, filename);
    const payload = buildPromptPayload(input, relativePngPath);

    // Engine handles bracketed-paste wrap, drain, paste-to-Enter gap,
    // and atomic submit. Translate engine errors to renderer-facing toasts.
    try {
      await context.pasteEngine.pasteAndSubmit(input.sessionId, payload, {
        bracketed: true,
        source: 'browser-capture',
      });
    } catch (caught) {
      if (caught instanceof PasteSubmitError) {
        const userMessage = caught.code === 'timeout'
          ? 'Paste timed out - the agent may be busy. Try again.'
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
}
