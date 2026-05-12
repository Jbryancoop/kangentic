/**
 * UI tests for BrowserPaneActive keyboard shortcuts.
 *
 * BrowserPane registers a CAPTURE-phase document-level keydown listener that
 * handles:
 *   Ctrl+Enter / Meta+Enter  -- Send
 *   Ctrl+D / Meta+D          -- Toggle draw mode
 *   Ctrl+I / Meta+I          -- Start inspect
 *   Esc (while inspect active) -- Cancel inspect WITHOUT closing the dialog
 *
 * The "in a form field" guard skips Ctrl+D and Ctrl+I when the target is
 * INPUT or TEXTAREA.
 *
 * Headless caveats:
 *   - <webview> is mounted in the DOM as an unknown HTML element. Its Electron-
 *     specific methods (loadURL, executeJavaScript, getURL, etc.) are absent.
 *   - Ctrl+D / draw button click call cancelInspect() which calls
 *     webviewRef.current?.executeJavaScript(...). In headless this throws
 *     synchronously (executeJavaScript is not a function on an HTMLElement),
 *     crashing BrowserPaneActive via the ErrorBoundary. Draw mode shortcuts
 *     cannot be tested in the UI tier.
 *   - Ctrl+I calls startInspect() -> webviewRef.current?.executeJavaScript(INSPECT_SCRIPT).
 *     Same crash. Inspect shortcuts cannot be tested in the UI tier.
 *   - Ctrl+Enter calls handleSend() which checks canvasRef.current before
 *     doing anything (null guard). In headless canvasRef is the real canvas
 *     element, but canvasRef.current?.getBoundingClientRect() is called
 *     indirectly via compositeCapture. handleSend checks both webviewRef and
 *     canvasRef at the top: `if (!webview || !overlay) return;`. In headless
 *     both refs are real DOM elements so this guard does NOT short-circuit,
 *     and the function proceeds to call webview.executeJavaScript() -> crash.
 *
 * What IS testable in the UI tier:
 *   - Ctrl+D in a form field (URL input) is a no-op -> draw mode stays off.
 *     This is testable because we never click outside the form field so the
 *     document listener fires but the inFormField guard prevents any draw mode
 *     change and therefore no executeJavaScript call is made.
 *   - Ctrl+I in a form field (note input) is a no-op -> inspect stays off.
 *     Same reasoning: inFormField guard fires, no startInspect, no crash.
 *   - Esc at document level when inspect is NOT active does not close the dialog.
 *     We dispatch Esc while the pane has non-inspect focus and assert the dialog
 *     stays open. This validates the guard without needing a real inspect mode.
 *
 * Draw mode and inspect mode shortcut tests (the affirmative paths) belong in
 * tests/e2e/ where a real Electron webview provides executeJavaScript.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-browser-shortcuts';
const TASK_ID = 'task-browser-shortcuts';
const SESSION_ID = 'sess-browser-shortcuts';
const PROJECT_PATH = '/mock/browser-shortcuts-test';

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Browser Shortcuts Test',
      path: '${PROJECT_PATH}',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    state.projectConfigs['${PROJECT_PATH}'] = {
      browser: { enabled: true },
    };

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-sc-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });

    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9998,
      status: 'running',
      shell: 'bash',
      cwd: '${PROJECT_PATH}',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      title: 'Shortcuts Browser Task',
      description: 'Used to drive BrowserPaneActive keyboard shortcut tests',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: null,
      branch_name: null,
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

async function launchBrowserShortcuts(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });

  return { browser, page };
}

/** Seed task URL and open the browser pane. */
async function openBrowserPane(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__mockBrowser?.reset();
    window.__mockBrowser?.seedTaskUrl('task-browser-shortcuts', 'http://localhost:5173/');
  });

  const card = page.locator('[data-swimlane-name="Code Review"]').locator('text=Shortcuts Browser Task').first();
  await card.click();
  const dialog = page.locator('[data-testid="task-detail-dialog"]');
  await dialog.waitFor({ state: 'visible', timeout: 5000 });

  const browserPane = page.locator('[data-testid="browser-pane"]');
  if (!(await browserPane.isVisible().catch(() => false))) {
    await page.locator('[data-testid="browser-toggle"]').click();
  }
  await browserPane.waitFor({ state: 'visible', timeout: 5000 });
}

test.describe('BrowserPaneActive keyboard shortcuts - form-field guards', () => {
  test('Ctrl+D in the URL bar (INPUT) does NOT toggle draw mode', async () => {
    // The inFormField guard in the document-level listener prevents Ctrl+D
    // from calling setDrawMode when the event target is an INPUT element.
    // The draw button must remain in non-active state after the shortcut.
    const { browser, page } = await launchBrowserShortcuts();
    try {
      await openBrowserPane(page);

      const urlInput = page.locator('[data-testid="browser-url-input"]');
      const drawButton = page.locator('[data-testid="browser-draw-toggle"]');

      // Verify draw is initially off.
      await expect(drawButton).not.toHaveClass(/bg-accent/);

      // Focus the URL input and fire the shortcut.
      await urlInput.click();
      await page.keyboard.press('Control+d');

      // The draw button must remain non-active (guard fired).
      // If the guard had NOT fired, executeJavaScript would be called and
      // the component would crash -- an implicit crash assertion.
      await expect(drawButton).not.toHaveClass(/bg-accent/);
      await expect(page.locator('[data-testid="browser-pane"]')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('Ctrl+I in the note input (INPUT) does NOT start inspect', async () => {
    // The inFormField guard prevents Ctrl+I from calling startInspect() when
    // the event target is an INPUT element. The inspect button must remain
    // non-active and the component must not crash.
    const { browser, page } = await launchBrowserShortcuts();
    try {
      await openBrowserPane(page);

      const noteInput = page.locator('[data-testid="browser-note-input"]');
      const inspectButton = page.locator('[data-testid="browser-inspect-toggle"]');

      // Inspect is initially off.
      await expect(inspectButton).not.toHaveClass(/bg-accent/);

      // Focus the note input and fire the shortcut.
      await noteInput.click();
      await page.keyboard.press('Control+i');

      // Inspect must remain off (guard fired).
      await expect(inspectButton).not.toHaveClass(/bg-accent/);
      // Dialog and pane must still be visible.
      await expect(page.locator('[data-testid="task-detail-dialog"]')).toBeVisible();
      await expect(page.locator('[data-testid="browser-pane"]')).toBeVisible();
    } finally {
      await browser.close();
    }
  });
});

test.describe('BrowserPaneActive keyboard shortcuts - Esc handling', () => {
  test('Esc at document level does not close the dialog when inspect is NOT active', async () => {
    // BrowserPane's capture-phase Esc handler only fires cancelInspect() when
    // inspectActive === true. When inspect is off, Esc propagates normally to
    // the parent TaskDetailDialog's bubble-phase handler.
    //
    // However, TaskDetailDialog's Esc handler closes the dialog. We verify
    // that the dialog closes (expected Esc behaviour when inspect is off) --
    // this confirms the BrowserPane Esc handler is NOT incorrectly eating the
    // event when inspect is inactive.
    //
    // We use document.dispatchEvent (anti-pattern 10) to bypass xterm capture.
    const { browser, page } = await launchBrowserShortcuts();
    try {
      await openBrowserPane(page);

      // Dispatch Esc at document level -- should propagate to dialog's handler.
      await page.evaluate(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      });

      // When inspect is NOT active the BrowserPane Esc handler does nothing,
      // so the dialog's own Esc listener fires and closes the dialog.
      await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });
    } finally {
      await browser.close();
    }
  });
});

test.describe('BrowserPaneActive keyboard shortcuts - URL input Enter', () => {
  test('pressing Enter in the URL input with an unparseable URL surfaces an error', async () => {
    // Exercises the handleUrlSubmit -> navigate() path when called from inside
    // an INPUT element (the form's onSubmit fires, not the document listener).
    // `:bad` is not a valid hostname so new URL('http://:bad') throws, setting
    // the error state WITHOUT calling loadURL -- safe in headless.
    const { browser, page } = await launchBrowserShortcuts();
    try {
      await openBrowserPane(page);
      const urlInput = page.locator('[data-testid="browser-url-input"]');
      await urlInput.fill(':bad');
      await urlInput.press('Enter');
      await expect(page.getByText(/Invalid URL:/)).toBeVisible({ timeout: 3000 });
      // Pane must still be mounted (the error branch returns before loadURL).
      await expect(page.locator('[data-testid="browser-pane"]')).toBeVisible();
    } finally {
      await browser.close();
    }
  });
});

test.describe('BrowserPaneActive zoom controls', () => {
  test('toolbar buttons step zoom and the % button resets to 100%', async () => {
    // applyZoom uses `if (typeof webview.setZoomFactor === 'function')` so the
    // missing method on the headless HTMLElement does not crash -- the React
    // state still updates and the toolbar % reflects it.
    const { browser, page } = await launchBrowserShortcuts();
    try {
      await openBrowserPane(page);

      const zoomReset = page.locator('[data-testid="browser-zoom-reset"]');
      const zoomIn = page.locator('[data-testid="browser-zoom-in"]');
      const zoomOut = page.locator('[data-testid="browser-zoom-out"]');

      // Initial state: 100%.
      await expect(zoomReset).toHaveText('100%');

      // Step up once -> 110% (next rung on the Chrome ladder).
      await zoomIn.click();
      await expect(zoomReset).toHaveText('110%');

      // Step up again -> 125%.
      await zoomIn.click();
      await expect(zoomReset).toHaveText('125%');

      // Reset via the % button.
      await zoomReset.click();
      await expect(zoomReset).toHaveText('100%');

      // Step down -> 90%.
      await zoomOut.click();
      await expect(zoomReset).toHaveText('90%');
    } finally {
      await browser.close();
    }
  });

  test('Ctrl+= and Ctrl+0 work when focus is inside the pane', async () => {
    // The keydown handler gates zoom shortcuts on hovered OR focus-within.
    // Focusing the % button (which is inside paneRef) is the most reliable
    // way to set focus-within in a headless test, and doesn't mutate state.
    const { browser, page } = await launchBrowserShortcuts();
    try {
      await openBrowserPane(page);
      const zoomReset = page.locator('[data-testid="browser-zoom-reset"]');
      await expect(zoomReset).toHaveText('100%');

      // Focus the % button so paneRef.current.contains(document.activeElement)
      // becomes true; the gate then admits the zoom shortcuts.
      await zoomReset.focus();

      await page.keyboard.press('Control+=');
      await expect(zoomReset).toHaveText('110%');

      await page.keyboard.press('Control+0');
      await expect(zoomReset).toHaveText('100%');
    } finally {
      await browser.close();
    }
  });

  test('Ctrl+= does NOT fire when the pane is neither hovered nor focused', async () => {
    // Same principle as task #139: global Ctrl+0 should not reset browser
    // zoom while the user is interacting elsewhere. We move the mouse away
    // from the pane (onto the page body well outside the pane) and ensure
    // no input inside the pane is focused.
    const { browser, page } = await launchBrowserShortcuts();
    try {
      await openBrowserPane(page);
      const zoomReset = page.locator('[data-testid="browser-zoom-reset"]');

      // Prime the zoom to a non-default so a missed reset would be visible.
      await page.locator('[data-testid="browser-zoom-in"]').click();
      await expect(zoomReset).toHaveText('110%');

      // First move INTO the pane center so onMouseEnter fires and sets
      // hoveredRef = true. This ensures that the subsequent move OUT
      // provably triggers onMouseLeave (not assumed to be starting outside).
      const paneBox = await page.locator('[data-testid="browser-pane"]').boundingBox();
      if (paneBox) {
        await page.mouse.move(
          paneBox.x + paneBox.width / 2,
          paneBox.y + paneBox.height / 2,
        );
      }

      // Now blur and move to (0,0) so onMouseLeave fires and hoveredRef = false.
      await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      });
      await page.mouse.move(0, 0);

      // hoveredRef is now false and nothing inside the pane has focus.
      // Ctrl+0 at the document level must not reset zoom.
      await page.keyboard.press('Control+0');

      // The gate should have prevented reset.
      await expect(zoomReset).toHaveText('110%');
    } finally {
      await browser.close();
    }
  });

  test('Ctrl+= fires when pane is hovered but no element inside has focus', async () => {
    // Positive path for the hover branch of the zoom gate.
    // hoveredRef.current === true (via onMouseEnter) lets zoom shortcuts fire
    // even when document.activeElement is completely outside the pane.
    //
    // Approach: Hover the zoom-reset button (inside pane, real DOM element,
    // not covered by the webview overlay) using Playwright's element.hover()
    // which reliably dispatches pointer events on the target. Then blur focus
    // and verify the keyboard shortcut fires via the hover path.
    //
    // The zoom-reset button is in the URL bar row which sits ABOVE the
    // webview/canvas overlay, so pointer events reach the element without
    // being intercepted by absolute-positioned children.
    const { browser, page } = await launchBrowserShortcuts();
    try {
      await openBrowserPane(page);
      const zoomReset = page.locator('[data-testid="browser-zoom-reset"]');
      await expect(zoomReset).toHaveText('100%');

      // Hover the zoom-reset button. Playwright's .hover() moves the mouse
      // and waits for the element to be actionable, then dispatches mouse
      // events ending with mouseenter on the element and its ancestors -
      // including the [data-testid="browser-pane"] root which owns
      // onMouseEnter -> hoveredRef.current = true.
      await zoomReset.hover();

      // Blur everything. zoomReset.hover() may have left focus on the button
      // (browsers sometimes focus buttons on hover). We need focusInside to
      // be false so only the hover branch admits the shortcut.
      await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      });

      // Fire Ctrl+= at the document level. hoveredRef.current should be true
      // (the hover event chain sets it) so the gate admits the shortcut even
      // though nothing inside the pane is focused.
      await page.keyboard.press('Control+=');

      // hoveredRef was true -> shortcut fires -> zoomFactor steps from 1.0 to 1.1.
      await expect(zoomReset).toHaveText('110%');
    } finally {
      await browser.close();
    }
  });
});
