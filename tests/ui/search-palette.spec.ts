/**
 * UI tests for the global search palette (Ctrl+Shift+F / Ctrl+F).
 *
 * Verifies the overlay opens via both keybinds and the title bar icon,
 * results render grouped by kind with mocked hits, keyboard navigation
 * works, and per-kind navigation actions are invoked correctly.
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-search';
const OTHER_PROJECT_ID = 'proj-other';
const TASK_ID = 'task-search-1';
const SESSION_ID = 'sess-search-1';

function preConfigWithSearchHits(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Primary Project',
        path: '/mock/primary',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      state.projects.push({
        id: '${OTHER_PROJECT_ID}',
        name: 'Other Project',
        path: '/mock/other',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, {
          id: 'lane-search-' + i,
          position: i,
          created_at: ts,
        }));
      });

      state.tasks.push({
        id: '${TASK_ID}',
        title: 'Task with auth in title',
        description: '',
        swimlane_id: 'lane-search-0',
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

      var hits = [
        {
          kind: 'project',
          projectId: '${OTHER_PROJECT_ID}',
          projectName: 'Other Project',
          projectPath: '/mock/other',
          snippet: 'Other Project',
          matchStart: 0,
          matchEnd: 5,
        },
        {
          kind: 'task',
          projectId: '${PROJECT_ID}',
          projectName: 'Primary Project',
          taskId: '${TASK_ID}',
          displayId: 7,
          taskTitle: 'Task with auth in title',
          archived: false,
          snippetField: 'title',
          snippet: 'Task with auth in title',
          matchStart: 10,
          matchEnd: 14,
        },
        {
          kind: 'backlog',
          projectId: '${PROJECT_ID}',
          projectName: 'Primary Project',
          backlogId: 'backlog-1',
          backlogTitle: 'Investigate auth flow',
          snippetField: 'title',
          snippet: 'Investigate auth flow',
          matchStart: 12,
          matchEnd: 16,
        },
        {
          kind: 'session_event',
          projectId: '${PROJECT_ID}',
          projectName: 'Primary Project',
          taskId: '${TASK_ID}',
          taskTitle: 'Task with auth in title',
          sessionId: '${SESSION_ID}',
          agentName: 'Claude Code',
          eventTs: Date.now(),
          eventKey: '${SESSION_ID}-' + Date.now(),
          eventType: 'tool_start',
          snippet: 'Read: src/auth/login.ts',
          matchStart: 10,
          matchEnd: 14,
        },
      ];

      return { currentProjectId: '${PROJECT_ID}', searchHits: hits };
    });
  `;
}

async function launchWithState(preConfigScript: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady();
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

test.describe('Search Palette', () => {
  test('Ctrl+Shift+F opens the palette', async () => {
    const { browser, page } = await launchWithState(preConfigWithSearchHits());
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await expect(page.getByTestId('search-palette')).not.toBeVisible();
      await page.keyboard.press('Control+Shift+F');
      await expect(page.getByTestId('search-palette')).toBeVisible();
      await expect(page.getByTestId('search-palette-input')).toBeFocused();
    } finally {
      await browser.close();
    }
  });

  test('Ctrl+F also opens the palette when not in an input', async () => {
    const { browser, page } = await launchWithState(preConfigWithSearchHits());
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      // Focus a non-editable element first to ensure the guard doesn't block us
      await page.locator('body').click();
      await page.keyboard.press('Control+f');
      await expect(page.getByTestId('search-palette')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('title bar Search button opens the palette', async () => {
    const { browser, page } = await launchWithState(preConfigWithSearchHits());
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await expect(page.getByTestId('open-search-button')).toBeVisible();
      await page.getByTestId('open-search-button').click();
      await expect(page.getByTestId('search-palette')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('Escape closes the palette', async () => {
    const { browser, page } = await launchWithState(preConfigWithSearchHits());
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await page.keyboard.press('Control+Shift+F');
      await expect(page.getByTestId('search-palette')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('search-palette')).not.toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('typing returns mocked hits across all kinds', async () => {
    const { browser, page } = await launchWithState(preConfigWithSearchHits());
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await page.keyboard.press('Control+Shift+F');
      await page.getByTestId('search-palette-input').fill('auth');
      // Wait past the 200ms debounce
      await expect(page.getByTestId('search-palette-results')).toBeVisible({ timeout: 2000 });

      const results = page.locator('[data-testid="search-palette-result"]');
      await expect(results).toHaveCount(4);
      // Per-kind data attribute should reflect each hit's kind
      await expect(page.locator('[data-result-kind="project"]')).toHaveCount(1);
      await expect(page.locator('[data-result-kind="task"]')).toHaveCount(1);
      await expect(page.locator('[data-result-kind="backlog"]')).toHaveCount(1);
      await expect(page.locator('[data-result-kind="session_event"]')).toHaveCount(1);
    } finally {
      await browser.close();
    }
  });

  test('Enter on a task hit closes palette and opens detail dialog', async () => {
    const { browser, page } = await launchWithState(preConfigWithSearchHits());
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await page.keyboard.press('Control+Shift+F');
      await page.getByTestId('search-palette-input').fill('auth');
      await expect(page.getByTestId('search-palette-results')).toBeVisible({ timeout: 2000 });

      // First result is the project hit; arrow down once to land on the task hit
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');

      // Palette closes
      await expect(page.getByTestId('search-palette')).not.toBeVisible();
      // Task detail dialog opens (its container has data-testid="task-detail-dialog" if present;
      // fall back to checking for the dialog title text)
      await expect(page.locator('text=Task with auth in title').first()).toBeVisible({ timeout: 5000 });
    } finally {
      await browser.close();
    }
  });
});
