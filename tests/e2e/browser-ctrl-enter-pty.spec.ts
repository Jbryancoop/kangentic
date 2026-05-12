/**
 * E2E regression guard: Ctrl+Enter from outside the note input must NOT
 * trigger BrowserPane's send flow when the browser pane is mounted in a
 * task detail dialog alongside a running terminal.
 *
 * Before the fix, BrowserPane registered a document-level capture-phase
 * listener that called handleSend() on Ctrl+Enter from anywhere in the
 * document - including from a focused xterm terminal in the same dialog.
 * xterm's own custom key handler (terminal-clipboard.ts:202-205) also
 * intercepts Ctrl+Enter to send \n to the PTY for multiline input. The
 * two listeners raced, with the document capture listener winning (it ran
 * first because capture phase precedes target phase on the same element),
 * triggering an unwanted browser screenshot/paste cycle.
 *
 * After the fix, the document-level listener no longer handles Ctrl+Enter.
 * The send shortcut lives in the note <input>'s own onKeyDown handler,
 * which only fires when the input itself has focus.
 *
 * What this test proves (E2E tier is required because):
 *   - We need a real Electron app with a real PTY session mounted so the
 *     TaskDetailBody renders the TerminalTab + BrowserPane side-by-side.
 *     The document-level listener is only attached when BrowserPaneActive
 *     is mounted, which requires a live session in a Code Review column.
 *   - The UI tier cannot prove the listener is absent in a real Electron
 *     document with a real IPC-backed captureAndSend handler.
 *
 * Regression path exercised:
 *   (a) Browser pane is open (document-level listener is mounted).
 *   (b) Ctrl+Enter is dispatched at document level (what xterm would
 *       produce when a user presses Ctrl+Enter with the terminal focused).
 *   (c) browser.captureAndSend must NOT be called (handleSend was NOT
 *       triggered - the regression is absent).
 *   (d) Browser pane stays mounted (no crash from webview.executeJavaScript
 *       being called in the Electron webview context).
 *
 * Note on the xterm -> PTY write path:
 *   The terminal-clipboard.ts custom key handler (onWrite('\n')) is pure
 *   JavaScript with no Electron-specific dependencies. Its logic is covered
 *   at the unit tier. The synthetic dispatchEvent path we use here doesn't
 *   reliably route through xterm's internal event handler when using
 *   Playwright's CDP in a headless Electron window (xterm's textarea listener
 *   is registered in the renderer process's isolated context, and synthetic
 *   events created in the test frame don't always reach it). We therefore
 *   limit this E2E spec to the document-level regression guard, which is the
 *   observable and reliable side of the fix.
 */
import { test, expect } from '@playwright/test';
import {
  launchApp,
  createProject,
  createTask,
  createTempProject,
  cleanupTempProject,
  getTestDataDir,
  mockAgentPath,
  waitForRunningSession,
  waitForScrollback,
  getTaskIdByTitle,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const TEST_NAME = 'browser-ctrl-enter-pty';
const runId = Date.now();
const PROJECT_NAME = `Browser CtrlEnter PTY ${runId}`;

let app: ElectronApplication;
let page: Page;
let tmpDir: string;
let dataDir: string;

test.beforeAll(async () => {
  tmpDir = createTempProject(TEST_NAME);
  dataDir = getTestDataDir(TEST_NAME);

  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      claude: {
        cliPath: mockAgentPath('claude'),
        permissionMode: 'default',
        maxConcurrentSessions: 5,
        queueOverflow: 'queue',
      },
      git: { worktreesEnabled: false },
    }),
  );

  const result = await launchApp({ dataDir });
  app = result.app;
  page = result.page;
  await createProject(page, PROJECT_NAME, tmpDir);
});

test.afterAll(async () => {
  await app?.close();
  cleanupTempProject(TEST_NAME);
  // getTestDataDir() cleans up stale dataDir on the next run; no
  // explicit cleanupTestDataDir() here avoids a Windows handle-release
  // race where better-sqlite3 still has the file open during afterAll.
});

async function dragToCodeReview(taskTitle: string): Promise<void> {
  const card = page.locator('[data-testid="swimlane"]').locator(`text=${taskTitle}`).first();
  await card.waitFor({ state: 'visible', timeout: 5000 });

  const target = page.locator('[data-swimlane-name="Code Review"]');
  await target.waitFor({ state: 'visible', timeout: 5000 });

  const cardBox = await card.boundingBox();
  const targetBox = await target.boundingBox();
  if (!cardBox || !targetBox) throw new Error('Could not get bounding boxes for drag');

  await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(cardBox.x + 10, cardBox.y, { steps: 3 });
  // Fixed wait: DnD activation distance requires a brief moment regardless
  // of target visibility. Matches the pattern in browser-send-roundtrip.spec.ts.
  await page.waitForTimeout(100);
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + 80, { steps: 15 });
  await page.waitForTimeout(200);
  await page.mouse.up();
  // Poll for the card landing in Code Review rather than a fixed post-drop sleep.
  await expect(target.locator(`text=${taskTitle}`).first()).toBeVisible({ timeout: 5000 });
}

test.describe('BrowserPane + Terminal Ctrl+Enter regression guard', () => {
  test('document-level Ctrl+Enter does NOT trigger browser send when browser pane is open', async () => {
    // This is the primary regression guard. Before the fix, BrowserPane's
    // document-level capture-phase listener called handleSend() on any
    // Ctrl+Enter dispatched from anywhere in the document, including from
    // xterm when the user pressed Ctrl+Enter in the terminal.
    //
    // After the fix, the document-level listener no longer handles Ctrl+Enter.
    // captureAndSend must NOT be called when Ctrl+Enter is dispatched at
    // document level with the browser pane mounted.

    const taskTitle = `CtrlEnter Doc ${runId}`;
    await createTask(page, taskTitle, 'ctrl-enter document-level regression');
    await dragToCodeReview(taskTitle);
    await waitForRunningSession(page);

    // Wait for mock-claude to print its session marker, which confirms the PTY
    // is live and the session is fully spawned before we open the dialog.
    await waitForScrollback(page, 'MOCK_CLAUDE_SESSION:', 15000);

    const taskId = await getTaskIdByTitle(page, taskTitle);

    // Seed a task URL so the browser pane renders BrowserPaneActive (with the
    // document-level listener) instead of the empty-state placeholder.
    // The main process rewrites data: URLs to about:blank via will-attach-webview.
    await page.evaluate(async (id: string) => {
      await window.electronAPI.browser.setTaskUrl(
        id,
        'data:text/html,<h1>ctrl-enter-pty</h1>',
      );
    }, taskId);

    // Open the task detail dialog. Anti-pattern 8: use .filter({ hasText }) to
    // avoid matching multiple dialogs if other dialogs are somehow open.
    const card = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator(`text=${taskTitle}`)
      .first();
    await card.click();
    const taskDetailDialog = page
      .locator('[data-testid="task-detail-dialog"]')
      .filter({ hasText: taskTitle })
      .first();
    await taskDetailDialog.waitFor({ state: 'visible', timeout: 5000 });

    // Toggle the browser pane open. This mounts BrowserPaneActive, which
    // registers the document-level capture-phase keydown listener. Before the
    // fix, that listener would intercept Ctrl+Enter from any source in the
    // document and call handleSend().
    await page.locator('[data-testid="browser-toggle"]').click();
    await page.locator('[data-testid="browser-pane"]').waitFor({ state: 'visible', timeout: 5000 });

    // Spy on captureAndSend BEFORE dispatching the key event. Any call to
    // this function means handleSend() ran, which is the regression we're guarding.
    // The spy replaces the IPC bridge method at the window object level; the
    // replacement is visible in this page's JavaScript context on subsequent
    // calls to captureAndSend made from BrowserPane.handleSend().
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__captureAndSendCalls = [];
      const original = window.electronAPI.browser.captureAndSend.bind(
        window.electronAPI.browser,
      );
      window.electronAPI.browser.captureAndSend = async (...args: unknown[]) => {
        (window as unknown as Record<string, unknown[]>).__captureAndSendCalls.push(args);
        return original(...(args as Parameters<typeof original>));
      };
    });

    // Dispatch Ctrl+Enter at document level. This simulates what happens when
    // the user presses Ctrl+Enter with the xterm terminal focused: xterm's
    // keydown event bubbles up through the DOM and reaches document listeners.
    // Before the fix, the BrowserPane capture-phase listener intercepted this
    // and called handleSend(). After the fix, it's ignored.
    await page.evaluate(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    // Fixed wait: proving non-occurrence requires a bounded budget.
    // 500ms gives any microtask or rAF-delayed code time to run.
    // This is an intentional fixed wait per anti-pattern 6 documentation.
    await page.waitForTimeout(500);

    // Assert captureAndSend was NOT called. The regression is absent.
    const captureAndSendCalls = await page.evaluate(
      () => (window as unknown as Record<string, unknown[]>).__captureAndSendCalls,
    );
    expect(captureAndSendCalls).toHaveLength(0);

    // Assert pane stays mounted (no crash from webview.executeJavaScript
    // being called in the Electron webview context by handleSend).
    await expect(page.locator('[data-testid="browser-pane"]')).toBeVisible();
    await expect(taskDetailDialog).toBeVisible();
  });
});
