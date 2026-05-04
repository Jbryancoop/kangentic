/**
 * UI tests for the ContextBar model and effort popovers.
 *
 * The pills become clickable buttons whenever the agent's
 * `discoverCapabilities` reports a non-empty options array. Clicking opens a
 * `ContextBarPopover`, picking an option fires
 * `window.electronAPI.tasks.setRuntimeOverride`, and the pill updates
 * optimistically.
 *
 * The mock at `tests/ui/mock-electron-api.js` exposes:
 *   - `window.__mockSetRuntimeOverrideCalls`: every IPC input recorded
 *   - `window.__mockSetRuntimeOverrideResult`: optional override that lets a
 *     spec inject a custom response (e.g. `{ ok: false, reason: ... }`).
 *   - `window.__mockAgentListOverrides`: per-agent capability overrides; we
 *     use this in the gating test to clear `models` and `effortLevels`.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-ctx-bar-popover';
const TASK_ID = 'task-ctx-bar-popover';
const SESSION_ID = 'sess-ctx-bar-popover';
const SWIMLANE_ID = 'lane-ctx-bar-popover';

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

const CLAUDE_RUNNING_PRECONFIG = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Popover ContextBar Test',
      path: '/mock/ctx-bar-popover',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = i === 0 ? '${SWIMLANE_ID}' : state.uuid();
      state.swimlanes.push({
        id: id,
        name: s.name,
        role: s.role,
        color: s.color,
        icon: s.icon,
        is_archived: s.is_archived,
        permission_strategy: s.permission_strategy ?? null,
        auto_spawn: s.auto_spawn ?? false,
        position: i,
        created_at: ts,
      });
    });

    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9999,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/ctx-bar-popover',
      startedAt: ts,
      exitCode: null,
      resuming: false,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      title: 'Popover Task',
      description: '',
      swimlane_id: '${SWIMLANE_ID}',
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: null,
      branch_name: null,
      pr_number: null,
      pr_url: null,
      base_branch: null,
      labels: [],
      priority: 0,
      model_override: null,
      effort_override: null,
      attachment_count: 0,
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

async function applyClaudeUsage(page: Page, sessionId: string, model: string, displayName: string, effort: string | undefined): Promise<void> {
  await page.evaluate(
    ({ sessionId: id, model: modelId, displayName: name, effort: effortLevel }) => {
      const stores = (window as unknown as {
        __zustandStores?: {
          session: { getState: () => { updateUsage: (id: string, data: unknown) => void } };
        };
      }).__zustandStores;
      stores?.session.getState().updateUsage(id, {
        model: { id: modelId, displayName: name, effort: effortLevel },
        contextWindow: {
          usedPercentage: 0,
          usedTokens: 0,
          cacheTokens: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          contextWindowSize: 1_000_000,
        },
        cost: { totalCostUsd: 0, totalDurationMs: 0 },
      });
    },
    { sessionId, model, displayName, effort },
  );
}

// ---------------------------------------------------------------------------
// Shared toast helper (mirrors the pattern in delete-task-optimistic.spec.ts).
// ---------------------------------------------------------------------------

async function waitForToast(
  page: Page,
  textPattern: RegExp | string,
  timeoutMs = 5000,
): Promise<void> {
  await expect(
    page.locator('[data-testid="toast"]').filter({ hasText: textPattern }),
  ).toBeVisible({ timeout: timeoutMs });
}

test.describe('ContextBar model/effort popover', () => {
  test('clicking model pill opens popover with discovered options and current value checked', async () => {
    const { browser, page } = await launchWithState(CLAUDE_RUNNING_PRECONFIG);
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      const usageBar = page.locator('[data-testid="usage-bar"].min-h-8');
      await expect(usageBar).toBeVisible({ timeout: 10000 });

      await applyClaudeUsage(page, SESSION_ID, 'opus', 'Opus 4.7 (1M context)', 'xhigh');

      const modelTrigger = page.locator('[data-testid="context-bar-model-trigger"]');
      await expect(modelTrigger).toBeVisible({ timeout: 5000 });
      await modelTrigger.click();

      const popover = page.locator('[data-testid="context-bar-model-popover"]');
      await expect(popover).toBeVisible();
      await expect(popover).toContainText('opus');
      await expect(popover).toContainText('sonnet');
      await expect(popover).toContainText('haiku');
      // "Use column default" intentionally hidden when the swimlane has no
      // model_override (the default fixture). Covered separately by the
      // 'hides "Use column default" row when the column has no override'
      // test.
    } finally {
      await browser.close();
    }
  });

  test('picking a different model fires IPC and updates pill optimistically', async () => {
    const { browser, page } = await launchWithState(CLAUDE_RUNNING_PRECONFIG);
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await applyClaudeUsage(page, SESSION_ID, 'opus', 'Opus 4.7 (1M context)', 'xhigh');

      const modelTrigger = page.locator('[data-testid="context-bar-model-trigger"]');
      await expect(modelTrigger).toBeVisible({ timeout: 5000 });
      await modelTrigger.click();

      await page.locator('[data-testid="context-bar-model-popover-option-sonnet"]').click();

      // Popover closes, IPC fired with the picked value
      await expect(page.locator('[data-testid="context-bar-model-popover"]')).toHaveCount(0);
      const calls = await page.evaluate(() => (window as unknown as { __mockSetRuntimeOverrideCalls?: unknown[] }).__mockSetRuntimeOverrideCalls);
      expect(calls).toEqual([{ taskId: TASK_ID, model: 'sonnet' }]);

      // Optimistic store update propagates to the task row
      const taskOverride = await page.evaluate((taskId) => {
        const stores = (window as unknown as {
          __zustandStores?: { board: { getState: () => { tasks: Array<{ id: string; model_override: string | null }> } } };
        }).__zustandStores;
        const t = stores?.board.getState().tasks.find((row) => row.id === taskId);
        return t?.model_override ?? null;
      }, TASK_ID);
      expect(taskOverride).toBe('sonnet');
    } finally {
      await browser.close();
    }
  });

  test('picking an effort level fires IPC with the effort field', async () => {
    const { browser, page } = await launchWithState(CLAUDE_RUNNING_PRECONFIG);
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await applyClaudeUsage(page, SESSION_ID, 'opus', 'Opus 4.7 (1M context)', 'xhigh');

      const effortTrigger = page.locator('[data-testid="context-bar-effort-trigger"]');
      await expect(effortTrigger).toBeVisible({ timeout: 5000 });
      await effortTrigger.click();

      const popover = page.locator('[data-testid="context-bar-effort-popover"]');
      await expect(popover).toBeVisible();
      await page.locator('[data-testid="context-bar-effort-popover-option-medium"]').click();

      await expect(popover).toHaveCount(0);
      const calls = await page.evaluate(() => (window as unknown as { __mockSetRuntimeOverrideCalls?: unknown[] }).__mockSetRuntimeOverrideCalls);
      expect(calls).toEqual([{ taskId: TASK_ID, effort: 'medium' }]);
    } finally {
      await browser.close();
    }
  });

  test('"Use column default" sends null to clear the per-task override (only when the column has a default)', async () => {
    const { browser, page } = await launchWithState(CLAUDE_RUNNING_PRECONFIG);
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await applyClaudeUsage(page, SESSION_ID, 'sonnet', 'Sonnet', 'high');

      // Pretend the task already had an override AND the column has a model
      // override of its own (otherwise the "Use column default" row is
      // intentionally hidden - clicking it on an Auto column would silently
      // persist null without any visible effect, which is confusing UX).
      await page.evaluate((taskId) => {
        const stores = (window as unknown as {
          __zustandStores?: { board: { setState: (fn: (s: unknown) => unknown) => void } };
        }).__zustandStores;
        stores?.board.setState((s) => {
          const state = s as {
            tasks: Array<{ id: string; model_override: string | null; swimlane_id: string }>;
            swimlanes: Array<{ id: string; model_override: string | null }>;
          };
          return {
            tasks: state.tasks.map((t) => (t.id === taskId ? { ...t, model_override: 'sonnet' } : t)),
            swimlanes: state.swimlanes.map((lane) =>
              lane.id === state.tasks.find((t) => t.id === taskId)?.swimlane_id
                ? { ...lane, model_override: 'opus' }
                : lane,
            ),
          };
        });
      }, TASK_ID);

      await page.locator('[data-testid="context-bar-model-trigger"]').click();
      await page.locator('[data-testid="context-bar-model-popover-option-clear"]').click();

      const calls = await page.evaluate(() => (window as unknown as { __mockSetRuntimeOverrideCalls?: unknown[] }).__mockSetRuntimeOverrideCalls);
      expect(calls).toEqual([{ taskId: TASK_ID, model: null }]);
    } finally {
      await browser.close();
    }
  });

  test('hides "Use column default" row when the column has no override (Auto)', async () => {
    const { browser, page } = await launchWithState(CLAUDE_RUNNING_PRECONFIG);
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await applyClaudeUsage(page, SESSION_ID, 'opus', 'Opus 4.7 (1M context)', 'xhigh');

      // Default fixture: swimlane has no model_override (Auto). Open the
      // popover and assert the clear row is not rendered. The user can still
      // pick any concrete option to "revert" - we just don't show a row that
      // would silently no-op.
      await page.locator('[data-testid="context-bar-model-trigger"]').click();
      await expect(page.locator('[data-testid="context-bar-model-popover"]')).toBeVisible();
      await expect(page.locator('[data-testid="context-bar-model-popover-option-clear"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('Escape closes the popover', async () => {
    const { browser, page } = await launchWithState(CLAUDE_RUNNING_PRECONFIG);
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await applyClaudeUsage(page, SESSION_ID, 'opus', 'Opus 4.7 (1M context)', 'xhigh');

      await page.locator('[data-testid="context-bar-model-trigger"]').click();
      await expect(page.locator('[data-testid="context-bar-model-popover"]')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-testid="context-bar-model-popover"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('clicking outside closes the popover', async () => {
    const { browser, page } = await launchWithState(CLAUDE_RUNNING_PRECONFIG);
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await applyClaudeUsage(page, SESSION_ID, 'opus', 'Opus 4.7 (1M context)', 'xhigh');

      await page.locator('[data-testid="context-bar-model-trigger"]').click();
      await expect(page.locator('[data-testid="context-bar-model-popover"]')).toBeVisible();
      // Click an empty area of the page (board surface). The capture-phase
      // listener on document.mousedown closes the popover.
      await page.mouse.click(10, 10);
      await expect(page.locator('[data-testid="context-bar-model-popover"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('pre-persist failure rolls back optimistic update and shows a "Could not apply" toast', async () => {
    // The handler returns ok:false with a reason that does NOT start with
    // 'suspend failed', 'respawn failed', or 'respawn aborted' — meaning the DB
    // write never happened. The store must roll back the optimistic update so
    // the visible pill stays in sync with the DB.
    const { browser, page } = await launchWithState(CLAUDE_RUNNING_PRECONFIG);
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await applyClaudeUsage(page, SESSION_ID, 'opus', 'Opus 4.7 (1M context)', 'xhigh');

      // Snapshot the task's model_override before any click — should be null.
      const overrideBefore = await page.evaluate((taskId) => {
        const stores = (window as unknown as {
          __zustandStores?: { board: { getState: () => { tasks: Array<{ id: string; model_override: string | null }> } } };
        }).__zustandStores;
        return stores?.board.getState().tasks.find((row) => row.id === taskId)?.model_override ?? null;
      }, TASK_ID);
      expect(overrideBefore).toBeNull();

      // Install the failure hook before clicking so the IPC mock returns the error.
      await page.evaluate(() => {
        (window as unknown as { __mockSetRuntimeOverrideResult?: (input: unknown) => unknown }).__mockSetRuntimeOverrideResult =
          (_input: unknown) => ({ ok: false as const, reason: 'task not found' });
      });

      const modelTrigger = page.locator('[data-testid="context-bar-model-trigger"]');
      await expect(modelTrigger).toBeVisible({ timeout: 5000 });
      await modelTrigger.click();

      const popover = page.locator('[data-testid="context-bar-model-popover"]');
      await expect(popover).toBeVisible();
      await page.locator('[data-testid="context-bar-model-popover-option-sonnet"]').click();

      // Popover closes after the pick.
      await expect(popover).toHaveCount(0);

      // Error toast must appear with "Could not apply" prefix (pre-persist path).
      await waitForToast(page, 'Could not apply model/effort: task not found');

      // Optimistic update must be rolled back: model_override returns to null.
      await expect.poll(async () => {
        return page.evaluate((taskId) => {
          const stores = (window as unknown as {
            __zustandStores?: { board: { getState: () => { tasks: Array<{ id: string; model_override: string | null }> } } };
          }).__zustandStores;
          return stores?.board.getState().tasks.find((row) => row.id === taskId)?.model_override ?? null;
        }, TASK_ID);
      }, { timeout: 3000 }).toBeNull();
    } finally {
      // Remove the hook so it doesn't leak into other tests.
      await page.evaluate(() => {
        delete (window as unknown as { __mockSetRuntimeOverrideResult?: unknown }).__mockSetRuntimeOverrideResult;
      });
      await browser.close();
    }
  });

  test('post-persist failure keeps optimistic update and shows a "Saved, but..." toast', async () => {
    // The handler returns ok:false with a reason starting with 'suspend failed:'
    // — meaning the DB write DID happen, but applying the change to the live
    // session failed. The store must KEEP the optimistic update (so the pill
    // stays in sync with what the DB now has) and show the recovery toast.
    const { browser, page } = await launchWithState(CLAUDE_RUNNING_PRECONFIG);
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await applyClaudeUsage(page, SESSION_ID, 'opus', 'Opus 4.7 (1M context)', 'xhigh');

      // Install the failure hook: simulates a post-persist PTY suspend failure.
      await page.evaluate(() => {
        (window as unknown as { __mockSetRuntimeOverrideResult?: (input: unknown) => unknown }).__mockSetRuntimeOverrideResult =
          (_input: unknown) => ({ ok: false as const, reason: 'suspend failed: PTY already exited' });
      });

      const modelTrigger = page.locator('[data-testid="context-bar-model-trigger"]');
      await expect(modelTrigger).toBeVisible({ timeout: 5000 });
      await modelTrigger.click();

      const popover = page.locator('[data-testid="context-bar-model-popover"]');
      await expect(popover).toBeVisible();
      await page.locator('[data-testid="context-bar-model-popover-option-sonnet"]').click();

      // Popover closes after the pick.
      await expect(popover).toHaveCount(0);

      // Recovery toast must appear with "Saved, but..." prefix (post-persist path).
      await waitForToast(page, /Saved, but couldn't apply to the live session/);

      // Optimistic update must be KEPT: model_override is now 'sonnet' (in DB).
      await expect.poll(async () => {
        return page.evaluate((taskId) => {
          const stores = (window as unknown as {
            __zustandStores?: { board: { getState: () => { tasks: Array<{ id: string; model_override: string | null }> } } };
          }).__zustandStores;
          return stores?.board.getState().tasks.find((row) => row.id === taskId)?.model_override ?? null;
        }, TASK_ID);
      }, { timeout: 3000 }).toBe('sonnet');
    } finally {
      await page.evaluate(() => {
        delete (window as unknown as { __mockSetRuntimeOverrideResult?: unknown }).__mockSetRuntimeOverrideResult;
      });
      await browser.close();
    }
  });

  test('hides triggers when adapter capabilities have no models or effort levels', async () => {
    // Pre-init script clears Claude's capability arrays so the fall-through
    // to static-pill rendering kicks in.
    const preconfig = `
      window.__mockAgentListOverrides = {
        claude: {
          capabilities: { effortLevels: [], supportsModelOverride: false, models: [] },
        },
      };
      ${CLAUDE_RUNNING_PRECONFIG}
    `;
    const { browser, page } = await launchWithState(preconfig);
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await applyClaudeUsage(page, SESSION_ID, 'opus', 'Opus 4.7 (1M context)', 'xhigh');

      // The static "Opus 4.7" pill still renders (model name from live status)
      const usageBar = page.locator('[data-testid="usage-bar"].min-h-8');
      await expect.poll(async () => usageBar.textContent(), { timeout: 5000 }).toMatch(/Opus 4\.7/);

      // But neither trigger button mounts when capabilities are empty.
      await expect(page.locator('[data-testid="context-bar-model-trigger"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="context-bar-effort-trigger"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
});
