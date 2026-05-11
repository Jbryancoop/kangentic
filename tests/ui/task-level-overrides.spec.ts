import { test, expect } from '@playwright/test';
import { launchPage, createProject, createTask } from './helpers';
import type { Browser, Page } from '@playwright/test';

const PROJECT_NAME = `TaskOverrides Test ${Date.now()}`;
let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchPage();
  browser = result.browser;
  page = result.page;
  await createProject(page, PROJECT_NAME);
});

test.afterAll(async () => {
  await browser?.close();
});

async function openNewTaskDialog() {
  const column = page.locator('[data-swimlane-name="To Do"]');
  await column.locator('text=Add task').click();
  await page.locator('input[placeholder="Task title"]').waitFor({ state: 'visible' });
}

async function closeDialog() {
  await page.keyboard.press('Escape');
  await page.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 2000 });
}

test.describe('NewTaskDialog Advanced section', () => {
  test('Advanced toggle is visible and starts collapsed', async () => {
    await openNewTaskDialog();

    const toggle = page.locator('[data-testid="task-advanced-toggle"]');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    // Section body is hidden until expanded
    await expect(page.locator('[data-testid="task-advanced-section"]')).not.toBeVisible();

    await closeDialog();
  });

  test('expanding Advanced reveals model and effort selects with column-default option', async () => {
    await openNewTaskDialog();

    await page.locator('[data-testid="task-advanced-toggle"]').click();

    const modelSelect = page.locator('[data-testid="task-model-override"]');
    const effortSelect = page.locator('[data-testid="task-effort-override"]');
    await expect(modelSelect).toBeVisible();
    await expect(effortSelect).toBeVisible();

    // First option in each is the "use column default" sentinel (empty value)
    await expect(modelSelect.locator('option').first()).toHaveText('Use column default');
    await expect(effortSelect.locator('option').first()).toHaveText('Use column default');

    // Discovered options from mock capabilities
    const modelOptions = await modelSelect.locator('option').allTextContents();
    expect(modelOptions).toEqual(expect.arrayContaining(['opus', 'sonnet', 'haiku']));
    const effortOptions = await effortSelect.locator('option').allTextContents();
    expect(effortOptions).toEqual(expect.arrayContaining(['low', 'medium', 'high', 'xhigh', 'max']));

    await closeDialog();
  });

  test('selected overrides persist on the created task row', async () => {
    await openNewTaskDialog();

    await page.locator('input[placeholder="Task title"]').fill('Override Task');
    await page.locator('[data-testid="task-advanced-toggle"]').click();
    await page.locator('select[data-testid="task-model-override"]').selectOption('opus');
    await page.locator('select[data-testid="task-effort-override"]').selectOption('high');

    await page.locator('button:has-text("Create")').click();
    await page.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 3000 });

    const taskData = await page.evaluate(() => window.electronAPI.tasks.list());
    const task = taskData.find((t: { title: string }) => t.title === 'Override Task');
    expect(task).toBeDefined();
    expect(task!.model_override).toBe('opus');
    expect(task!.effort_override).toBe('high');
  });

  test('leaving overrides on column default omits them from the row', async () => {
    await openNewTaskDialog();

    await page.locator('input[placeholder="Task title"]').fill('Default Override Task');
    await page.locator('[data-testid="task-advanced-toggle"]').click();
    // Don't change either select - keep "Use column default"

    await page.locator('button:has-text("Create")').click();
    await page.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 3000 });

    const taskData = await page.evaluate(() => window.electronAPI.tasks.list());
    const task = taskData.find((t: { title: string }) => t.title === 'Default Override Task');
    expect(task).toBeDefined();
    expect(task!.model_override).toBeNull();
    expect(task!.effort_override).toBeNull();
  });
});

test.describe('PreSpawnContextBar', () => {
  test('renders in the task detail dialog when no session is running', async () => {
    await createTask(page, 'PreSpawn Bar Task');

    const card = page.locator('text=PreSpawn Bar Task').first();
    await card.click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });

    // To Do tasks open in edit mode by default. The pre-spawn bar must be
    // visible alongside the edit form so the user can pick model/effort
    // before moving the task to a spawning column.
    const bar = page.locator('[data-testid="prespawn-context-bar"]');
    await expect(bar).toBeVisible();

    // Both the model and effort triggers should be present pre-spawn
    await expect(bar.locator('[data-testid="context-bar-model-trigger"]')).toBeVisible();
    await expect(bar.locator('[data-testid="context-bar-effort-trigger"]')).toBeVisible();

    // Close the dialog so subsequent tests can interact with the board
    await page.locator('button:has-text("Cancel")').click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden' });
  });

  test('selecting a model pre-spawn writes through TASK_SET_RUNTIME_OVERRIDE in persisted mode', async () => {
    await createTask(page, 'PreSpawn Set Model');

    const card = page.locator('text=PreSpawn Set Model').first();
    await card.click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });

    const bar = page.locator('[data-testid="prespawn-context-bar"]');
    await expect(bar).toBeVisible();
    await bar.locator('[data-testid="context-bar-model-trigger"]').click();

    const popover = page.locator('[data-testid="context-bar-model-popover"]');
    await popover.waitFor({ state: 'visible' });
    await popover.locator('button:has-text("sonnet")').click();

    // Verify the override landed on the task row (mock plumbs through to setRuntimeOverride
    // which calls updateOverrides() under the hood).
    await expect.poll(async () => {
      const taskData = await page.evaluate(() => window.electronAPI.tasks.list());
      const task = taskData.find((t: { title: string }) => t.title === 'PreSpawn Set Model');
      return task?.model_override;
    }).toBe('sonnet');

    await page.locator('button:has-text("Cancel")').click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden' });
  });
});
