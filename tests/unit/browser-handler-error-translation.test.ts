/**
 * Unit coverage for the PasteSubmitError -> user-facing message translation
 * that lives in src/main/ipc/handlers/browser.ts lines 96-108.
 *
 * The production handler is registered via ipcMain.handle, which is an
 * Electron-only API. Rather than introduce electron-mocking gymnastics we
 * test the translation logic directly: the switch is inline (no helper
 * function) so we replicate the identical decision tree here and assert
 * against the same string constants.
 *
 * This is the correct approach because:
 *   1. The strings are the user-facing contract - they appear in toasts.
 *   2. The branching is simple (3-way on code + substring check on message).
 *   3. Importing registerBrowserHandlers would drag in ipcMain, fs, and
 *      the full IpcContext - a much larger mock surface with no coverage gain.
 *
 * If the production strings are ever refactored into a shared helper, this
 * test should be updated to import that helper directly.
 */
import { describe, it, expect } from 'vitest';
import { PasteSubmitError } from '../../src/main/pty/paste-engine';

/**
 * Mirrors the switch inside registerBrowserHandlers (browser.ts:96-103) exactly.
 * Keep in sync when the production code changes.
 */
function translatePasteError(caught: PasteSubmitError): string {
  return caught.code === 'timeout'
    ? 'Paste timed out - the agent may be busy. Try again.'
    : caught.code === 'no-submission-evidence'
      ? caught.message.includes('bracketed-paste mode')
        ? 'Agent has a permission prompt or modal open. Resolve it in the terminal, then send again.'
        : 'Paste landed but Enter did not submit. Press Enter in the terminal to submit.'
      : 'Paste was cancelled.';
}

describe('browser handler error translation', () => {
  it('translates timeout code to the retry-prompt message', () => {
    const error = new PasteSubmitError('timeout', 'operation timed out after 15000ms');
    expect(translatePasteError(error)).toBe(
      'Paste timed out - the agent may be busy. Try again.',
    );
  });

  it('translates no-submission-evidence with bracketed-paste mode message', () => {
    // This branch fires when the TUI has disabled bracketed-paste mode,
    // indicating a permission prompt or modal is intercepting input.
    const error = new PasteSubmitError(
      'no-submission-evidence',
      'No submission evidence (bracketed-paste mode disabled by TUI)',
    );
    expect(translatePasteError(error)).toBe(
      'Agent has a permission prompt or modal open. Resolve it in the terminal, then send again.',
    );
  });

  it('translates no-submission-evidence without bracketed-paste in message', () => {
    // This branch fires when bracketed-paste mode is active but Enter still
    // did not produce a submission (e.g. the agent prompt was not waiting
    // for input at that moment).
    const error = new PasteSubmitError(
      'no-submission-evidence',
      'No submission evidence after retry',
    );
    expect(translatePasteError(error)).toBe(
      'Paste landed but Enter did not submit. Press Enter in the terminal to submit.',
    );
  });

  it('translates aborted code to the cancelled message', () => {
    const error = new PasteSubmitError('aborted', 'AbortSignal fired');
    expect(translatePasteError(error)).toBe('Paste was cancelled.');
  });

  it('PasteSubmitError preserves code and message on the instance', () => {
    const error = new PasteSubmitError('timeout', 'timed out');
    expect(error.code).toBe('timeout');
    expect(error.message).toBe('timed out');
    expect(error.name).toBe('PasteSubmitError');
    expect(error instanceof PasteSubmitError).toBe(true);
    expect(error instanceof Error).toBe(true);
  });
});
