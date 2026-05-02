// Pure helpers extracted from browser.ts so they can be unit-tested without
// importing Electron (ipcMain) or any I/O. The handler module re-exports
// nothing from here publicly - the functions are imported directly.

import path from 'node:path';
import type { BrowserCaptureInput, BrowserPickedElement } from '../../../shared/types';
import { escapeXml } from '../../agent/shared';

export const SELECTION_INLINE_LIMIT = 800;

// Browser-default values that add no signal for an LLM.
export const STYLE_DEFAULT_DROPS = new Set<string>([
  'normal', 'auto', 'none', '0px', '0', '1', 'static',
  'rgba(0, 0, 0, 0)', 'rgb(0, 0, 0, 0)', 'transparent',
]);

// width/height duplicate the `rect` line; display value tracks the tag's
// natural default for text-flow elements. Drop both so the styles block
// stays focused on what's actually styled.
export const STYLE_KEYS_TO_DROP = new Set<string>(['width', 'height', 'display']);

export function isMeaningfulStyle(key: string, value: string): boolean {
  if (!value) return false;
  if (STYLE_KEYS_TO_DROP.has(key)) return false;
  if (STYLE_DEFAULT_DROPS.has(value)) return false;
  // Common no-op patterns
  if (value === '0px 0px 0px 0px') return false;
  if (key === 'border' && /^0px/.test(value)) return false;
  if (key === 'opacity' && value === '1') return false;
  return true;
}

export function formatStyles(styles: Record<string, string>): string[] {
  const meaningful = Object.entries(styles).filter(([key, value]) => isMeaningfulStyle(key, value));
  if (meaningful.length === 0) return ['(defaults)'];
  return meaningful.map(([key, value]) => `${key}: ${value}`);
}

export function formatAncestors(ancestors: BrowserPickedElement['ancestors']): string {
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
export function isTrivialWrapper(outerHTML: string): boolean {
  const inner = outerHTML.replace(/^<[^>]+>/, '').replace(/<\/[^>]+>\s*$/, '');
  return !/<[a-zA-Z]/.test(inner);
}

// Validates a UUID v4-style session ID. Used to guard the filesystem path
// derived from sessionId in the handler against traversal attacks.
export function isValidSessionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

// Detects when path.relative returned an absolute Windows path because
// the source and target are on different drives.
export function isCrossDrivePath(relativePath: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(relativePath);
}

// Anthropic + OpenAI canonical guidance: wrap prompt input data in XML tags
// so the model sees a clear data/instruction boundary. Aider/Codex/etc treat
// the markup as harmless prose; the structured fields stay readable.
export function formatPickedElementXml(element: BrowserPickedElement): string[] {
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

  // Skip outerHTML when it's just <tag>text</tag> - already covered by classes/text.
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

export function buildPromptPayload(input: BrowserCaptureInput, relativePngPath: string): string {
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
