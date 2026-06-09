/**
 * UI test: the task.create hotkey (Mod+N = Ctrl+N on non-Mac) opens the New
 * Task dialog on the board view.
 *
 * Flow: AppLayout binds task.create → useBoardStore.getState().requestNewTask()
 * increments newTaskRequestNonce → KanbanBoard's useEffect opens a board-level
 * NewTaskDialog targeting the first role==='todo' lane.
 *
 * Tier: UI (headless Chromium, mock electronAPI, no PTY/Electron).
 * The shortcut is gated on activeView === 'board' && !!currentProject, so the
 * test sets up a project first (createProject helper) and stays on the board.
 */
import { test, expect } from '@playwright/test';
import { launchPage, createProject, waitForBoard } from './helpers';
import type { Browser, Page } from '@playwright/test';

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchPage();
  browser = result.browser;
  page = result.page;
  // Open a project so currentProject is set and the board is visible.
  await createProject(page, `TaskCreate Hotkey Test ${Date.now()}`);
  // waitForBoard is called inside createProject, but explicitly confirm here.
  await waitForBoard(page);
});

test.afterAll(async () => {
  await browser?.close();
});

test.describe('task.create hotkey (Ctrl+N)', () => {
  test('pressing Ctrl+N on the board opens the New Task dialog', async () => {
    // Confirm we are on the board view (To Do column visible).
    await expect(page.locator('[data-swimlane-name="To Do"]')).toBeVisible();

    // Dismiss any leftover dialog from a previous test run (defensive).
    const titleInput = page.locator('input[placeholder="Task title"]');
    if (await titleInput.isVisible().catch(() => false)) {
      await page.keyboard.press('Escape');
      await titleInput.waitFor({ state: 'hidden', timeout: 2000 });
    }

    // Press the hotkey.
    await page.keyboard.press('Control+N');

    // The NewTaskDialog's title input must appear.
    await expect(titleInput).toBeVisible({ timeout: 3000 });

    // Close the dialog before leaving.
    await page.keyboard.press('Escape');
    await expect(titleInput).toBeHidden({ timeout: 2000 });
  });

  test('the dialog opened by Ctrl+N targets the To Do (role=todo) lane', async () => {
    // Dismiss any leftover dialog.
    const titleInput = page.locator('input[placeholder="Task title"]');
    if (await titleInput.isVisible().catch(() => false)) {
      await page.keyboard.press('Escape');
      await titleInput.waitFor({ state: 'hidden', timeout: 2000 });
    }

    await page.keyboard.press('Control+N');
    await expect(titleInput).toBeVisible({ timeout: 3000 });

    // Create a task through the hotkey-opened dialog and verify it lands in
    // the To Do column - confirming the dialog targeted the todo lane.
    const uniqueTitle = `HotkeyCreated-${Date.now()}`;
    await titleInput.fill(uniqueTitle);
    await page.locator('button:has-text("Create")').click();
    await expect(titleInput).toBeHidden({ timeout: 3000 });

    // The card should appear in the To Do swimlane.
    const todoColumn = page.locator('[data-swimlane-name="To Do"]');
    await expect(todoColumn.locator(`text=${uniqueTitle}`)).toBeVisible({ timeout: 3000 });
  });

  test('Ctrl+N does NOT open the dialog when the board view is not active', async () => {
    // Switch to backlog view by pressing the toggle shortcut (Ctrl+Shift+B),
    // then confirm Ctrl+N does not open the New Task dialog (hotkey is gated on
    // activeView === 'board').
    const titleInput = page.locator('input[placeholder="Task title"]');

    // Switch to backlog by pressing Ctrl+Shift+B.
    await page.keyboard.press('Control+Shift+B');
    // Wait for the backlog view to be active (To Do column hidden).
    await expect(page.locator('[data-swimlane-name="To Do"]')).toBeHidden({ timeout: 3000 });

    await page.keyboard.press('Control+N');

    // Intentional fixed wait: we cannot poll for non-occurrence.
    // 800ms is enough for the React event loop to have processed the keydown
    // and for KanbanBoard's useEffect to have run if the guard was absent.
    // eslint-disable-next-line playwright/no-wait-for-timeout
    await page.waitForTimeout(800);

    const dialogVisible = await titleInput.isVisible().catch(() => false);
    expect(dialogVisible).toBe(false);

    // Switch back to board view for subsequent tests.
    await page.keyboard.press('Control+Shift+B');
    await expect(page.locator('[data-swimlane-name="To Do"]')).toBeVisible({ timeout: 3000 });
  });
});
