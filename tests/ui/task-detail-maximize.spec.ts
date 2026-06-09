/**
 * UI tests for the Task Detail maximize / restore toggle.
 *
 * Covers:
 * - Maximize button toggle: content fills screen, backdrop insets to app chrome
 * - Ctrl/Cmd+Shift+M keyboard toggle (maximize/restore)
 * - Ctrl/Cmd+Shift+W closes the dialog
 * - Ctrl/Cmd+Shift+B toggles the Browser pane when canShowBrowser is true
 * - Edit-mode guard: maximize hotkey is suppressed while editing
 * - BaseDialog default-prop non-regression: plain consumers keep inset-0 / rounded-lg
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

async function launchWithState(preConfigScript: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

const PROJECT_ID = 'proj-maximize';
const TASK_ID = 'task-maximize';
const SESSION_ID = 'sess-maximize';

// A second task in To Do opens in edit mode by default (no session context).
const EDIT_TASK_ID = 'task-maximize-edit';

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Maximize Test',
      path: '/mock/maximize-test',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });

    // Running session so displayState.kind === 'running' -> dialog opens in
    // non-editing mode (large layout) and the maximize button is rendered.
    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9999,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/maximize-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      display_id: 1,
      title: 'Maximize Task',
      description: 'Task used for the maximize toggle test',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: '/mock/worktrees/maximize',
      branch_name: 'feature/maximize',
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    // A To Do task with no session - opens in edit mode (initialEdit = true
    // is forced by useTaskSessionState when role=todo and no session context).
    state.tasks.push({
      id: '${EDIT_TASK_ID}',
      display_id: 2,
      title: 'Edit Mode Task',
      description: 'Task used to reach edit mode for the maximize guard test',
      swimlane_id: laneIds['To Do'],
      position: 0,
      agent: null,
      session_id: null,
      worktree_path: null,
      branch_name: null,
      pr_number: null,
      pr_url: null,
      base_branch: null,
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchWithState(preConfig);
  browser = result.browser;
  page = result.page;
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
});

test.afterAll(async () => {
  await browser?.close();
});

test.describe('Task Detail: maximize / restore', () => {
  test('maximize fills the screen and insets the backdrop; restore returns to windowed size', async () => {
    const card = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=Maximize Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    const maximizeButton = page.locator('[data-testid="task-detail-maximize"]');
    await expect(maximizeButton).toBeVisible();

    // Starts windowed (running session -> large mode), action is "Maximize".
    await expect(maximizeButton).toHaveAttribute('title', /^Maximize/);
    await expect(dialog).toHaveClass(/w-\[90vw\]/);
    await expect(dialog).toHaveClass(/rounded-lg/);
    const backdropBefore = await dialog.evaluate((el) => el.parentElement?.className ?? '');
    expect(backdropBefore).toContain('inset-0');
    expect(backdropBefore).not.toContain('top-10');

    // Maximize -> content fills the screen, backdrop insets to clear the chrome.
    await maximizeButton.click();
    await expect(maximizeButton).toHaveAttribute('title', /^Restore/);
    await expect(dialog).toHaveClass(/w-full/);
    await expect(dialog).toHaveClass(/h-full/);
    // Corners squared so the border meets the screen edges flush.
    await expect(dialog).toHaveClass(/rounded-none/);
    const backdropMaximized = await dialog.evaluate((el) => el.parentElement?.className ?? '');
    expect(backdropMaximized).toContain('top-10');
    expect(backdropMaximized).toContain('bottom-9');

    // Restore -> back to the windowed large size, backdrop covers the window.
    await maximizeButton.click();
    await expect(maximizeButton).toHaveAttribute('title', /^Maximize/);
    await expect(dialog).toHaveClass(/w-\[90vw\]/);
    const backdropRestored = await dialog.evaluate((el) => el.parentElement?.className ?? '');
    expect(backdropRestored).toContain('inset-0');
    expect(backdropRestored).not.toContain('top-10');

    // Hotkey: Ctrl/Cmd+Shift+M toggles maximize (terminal-safe combo).
    await page.keyboard.press('Control+Shift+M');
    await expect(maximizeButton).toHaveAttribute('title', /^Restore/);
    await expect(dialog).toHaveClass(/w-full/);
    await page.keyboard.press('Control+Shift+M');
    await expect(maximizeButton).toHaveAttribute('title', /^Maximize/);
    await expect(dialog).toHaveClass(/w-\[90vw\]/);

    // Hotkey: Ctrl/Cmd+Shift+W closes the dialog (terminal-safe combo).
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible();
  });

  test('Ctrl+Shift+B toggles the Browser pane when canShowBrowser is true', async () => {
    // The Code Review task has a running session, no browser.enabled override in
    // projectConfigs (so browserEnabled = undefined !== false = true), and the
    // session display state is 'running'. All three canShowBrowser conditions are met.
    const card = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=Maximize Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // The Browser toggle pill is visible (canShowBrowser = true).
    const browserToggle = dialog.locator('[data-testid="browser-toggle"]');
    await expect(browserToggle).toBeVisible();

    // Browser pane is closed initially - the pill shows "Show browser" title.
    await expect(browserToggle).toHaveAttribute('title', 'Show browser');

    // Ctrl+Shift+B opens the browser pane.
    await page.keyboard.press('Control+Shift+B');
    await expect(browserToggle).toHaveAttribute('title', 'Hide browser');

    // Ctrl+Shift+B again closes the browser pane.
    await page.keyboard.press('Control+Shift+B');
    await expect(browserToggle).toHaveAttribute('title', 'Show browser');

    // Close the dialog so subsequent tests start clean.
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible();
  });

  test('Ctrl+Shift+M is suppressed in edit mode (maximize guard)', async () => {
    // A To Do task with no session opens in edit mode (initialEdit=true, forced
    // by the component when role='todo' and hasSessionContext=false). The guard
    // `!isEditing` means Ctrl+Shift+M must not apply the maximized layout.
    const card = page
      .locator('[data-swimlane-name="To Do"]')
      .locator('text=Edit Mode Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // To Do tasks open in edit mode - a title input is visible.
    await expect(page.locator('input[placeholder="Task title"]')).toBeVisible();

    // Record the backdrop classes BEFORE pressing the hotkey.
    const backdropBefore = await dialog.evaluate((el) => el.parentElement?.className ?? '');

    // Ctrl+Shift+M must not switch to maximized layout while in edit mode.
    await page.keyboard.press('Control+Shift+M');

    // Intentional fixed wait: we cannot poll for non-occurrence.
    // 500ms is enough for React to process any state change if the guard failed.
    await page.waitForTimeout(500);

    const backdropAfter = await dialog.evaluate((el) => el.parentElement?.className ?? '');
    // Backdrop must still be full-window (inset-0), not the maximized inset.
    expect(backdropAfter).toContain('inset-0');
    expect(backdropAfter).not.toContain('top-10');
    // The dialog content must not have received w-full h-full (maximize layout).
    await expect(dialog).not.toHaveClass(/w-full/);

    // Classes unchanged from before the keypress.
    expect(backdropAfter).toBe(backdropBefore);

    // Close the dialog to leave a clean state for the next test.
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });

  test('BaseDialog default props: non-maximize consumer keeps inset-0 and rounded-lg', async () => {
    // The New Task dialog uses BaseDialog with no backdropPositionClass or
    // contentRadiusClass overrides. This test proves the new optional props
    // default safely and do not affect plain consumers of BaseDialog.
    const todoColumn = page.locator('[data-swimlane-name="To Do"]');
    await todoColumn.locator('text=Add task').click();

    // Wait for the dialog to mount.
    await page.locator('input[placeholder="Task title"]').waitFor({ state: 'visible', timeout: 5000 });

    // The content element has data-testid="task-description" inside it;
    // find the content box by walking up from a known inner element.
    const titleInput = page.locator('input[placeholder="Task title"]');
    const contentBox = titleInput.locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]');
    await expect(contentBox).toBeVisible();
    await expect(contentBox).toHaveClass(/rounded-lg/);
    // Must not have the maximized corners class.
    await expect(contentBox).not.toHaveClass(/rounded-none/);

    // The backdrop is the fixed full-screen overlay wrapping the content box.
    const backdropClass = await contentBox.evaluate((el) => el.parentElement?.className ?? '');
    expect(backdropClass).toContain('inset-0');
    // Must not have the maximized inset.
    expect(backdropClass).not.toContain('top-10');

    // Dismiss the dialog.
    await page.keyboard.press('Escape');
    await expect(page.locator('input[placeholder="Task title"]')).not.toBeVisible();
  });
});
