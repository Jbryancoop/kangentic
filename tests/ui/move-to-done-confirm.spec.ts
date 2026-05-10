/**
 * UI tests for the confirmation dialog when moving a task to the Done column.
 *
 * Moving to Done deletes the local worktree (branch + session history are
 * preserved). A confirmation dialog appears by default; users can opt into
 * silent auto-delete via a "Delete automatically in the future" checkbox that
 * sets config.skipDoneWorktreeConfirm.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-done-confirm';
const TASK_ID = 'task-done-confirm';

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

function makePreConfig(options: {
  skipConfirm?: boolean;
  pendingChanges?: { uncommittedFileCount: number; unpushedCommitCount: number };
} = {}): string {
  const skipConfirm = options.skipConfirm === true;
  const pendingChanges = options.pendingChanges;
  const pendingChangesOverride = pendingChanges
    ? `
      window.electronAPI.git.checkPendingChanges = async function () {
        return {
          hasPendingChanges: ${pendingChanges.uncommittedFileCount > 0 || pendingChanges.unpushedCommitCount > 0},
          uncommittedFileCount: ${pendingChanges.uncommittedFileCount},
          unpushedCommitCount: ${pendingChanges.unpushedCommitCount},
        };
      };
    `
    : '';
  return `
    window.__mockConfigOverrides = Object.assign(
      window.__mockConfigOverrides || {},
      { skipDoneWorktreeConfirm: ${skipConfirm} }
    );
    // The mock reads __mockConfigOverrides synchronously at init time; if the
    // preconfig script runs after the mock is already initialised we also push
    // the override through electronAPI.config.set so it lands before the
    // Zustand store reads the effective config.
    if (typeof window.electronAPI !== 'undefined' && window.electronAPI.config) {
      void window.electronAPI.config.set({ skipDoneWorktreeConfirm: ${skipConfirm} });
    }
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Done Confirm Test',
        path: '/mock/done-confirm-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = 'lane-' + s.name.toLowerCase().replace(/\\s+/g, '-');
        laneIds[s.name] = id;
        state.swimlanes.push(Object.assign({}, s, {
          id: id,
          position: i,
          created_at: ts,
        }));
      });

      var planningLane = state.swimlanes.find(function (s) { return s.name === 'Planning'; });
      var executingLane = state.swimlanes.find(function (s) { return s.name === 'Executing'; });
      if (planningLane && executingLane) {
        planningLane.plan_exit_target_id = executingLane.id;
      }

      state.tasks.push({
        id: '${TASK_ID}',
        title: 'Ready To Ship',
        description: 'A task about to move to Done',
        swimlane_id: laneIds['Executing'],
        position: 0,
        agent: 'claude',
        session_id: null,
        worktree_path: '/mock/worktrees/ready-to-ship',
        branch_name: 'ready-to-ship-abcd1234',
        pr_number: null,
        pr_url: null,
        base_branch: 'main',
        use_worktree: 1,
        labels: [],
        priority: 0,
        attachment_count: 0,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      ${pendingChangesOverride}

      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

async function dragTaskToColumn(page: Page, taskTitle: string, targetColumn: string): Promise<void> {
  const card = page
    .locator('[data-testid="swimlane"]')
    .locator(`text=${taskTitle}`)
    .first();
  await card.waitFor({ state: 'visible', timeout: 5000 });

  const target = page.locator(`[data-swimlane-name="${targetColumn}"]`);
  await target.waitFor({ state: 'visible', timeout: 5000 });

  await page.evaluate((targetCol: string) => {
    document.querySelector(`[data-swimlane-name="${targetCol}"]`)?.scrollIntoView({ inline: 'nearest', behavior: 'instant' });
  }, targetColumn);

  // boundingBox() forces a layout flush, so the post-scroll geometry is
  // accurate without a fixed wait.
  const cardBox = await card.boundingBox();
  const targetBox = await target.boundingBox();
  if (!cardBox || !targetBox) throw new Error('Could not get bounding boxes for drag');

  const startX = cardBox.x + cardBox.width / 2;
  const startY = cardBox.y + cardBox.height / 2;
  const endX = targetBox.x + targetBox.width / 2;
  const endY = targetBox.y + 120;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // The 10px shift + steps satisfies dnd-kit's PointerSensor activation
  // distance; poll the store's activeTask instead of guessing with a sleep.
  await page.mouse.move(startX + 10, startY, { steps: 3 });
  await expect.poll(async () => page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: { board: { getState: () => { activeTask: { id: string } | null } } };
    }).__zustandStores;
    return stores?.board.getState().activeTask !== null;
  }), { timeout: 2000 }).toBe(true);

  await page.mouse.move(endX, endY, { steps: 15 });
  // Done is the only target this helper drags to, and DoneSwimlane toggles
  // the `drop-zone-active` class via dnd-kit's isOver. Poll for it so the
  // drop fires only after the hover state is registered.
  await expect(target.locator('.drop-zone-active')).toBeVisible({ timeout: 2000 });

  await page.mouse.up();
  // Drop outcome (dialog, archive, etc.) varies per test - the caller's own
  // assertion does the post-drop wait.
}

test.describe('Move to Done - Delete Worktree Confirmation', () => {
  test('shows confirmation dialog when dropping a task on Done', async () => {
    const { browser, page } = await launchWithState(makePreConfig());

    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });

      const executingColumn = page.locator('[data-swimlane-name="Executing"]');
      await expect(executingColumn.locator('text=Ready To Ship')).toBeVisible();

      await dragTaskToColumn(page, 'Ready To Ship', 'Done');

      const dialog = page.locator('text=Move to Done?');
      await expect(dialog).toBeVisible({ timeout: 3000 });

      // Dialog enumerates the trade-off as bullets: worktree deleted,
      // branch unaffected (with concrete branch name shown), session kept.
      // Plus a closing line about resume restoring both.
      await expect(page.locator('text=Local worktree will be deleted')).toBeVisible();
      await expect(page.locator('text=will be unaffected')).toBeVisible();
      await expect(page.locator('text=ready-to-ship-abcd1234')).toBeVisible();
      await expect(page.locator('text=Session history will be kept')).toBeVisible();
      await expect(page.locator('text=session history and worktree will be restored')).toBeVisible();

      await expect(page.locator('button:has-text("Move")').first()).toBeVisible();
      await expect(page.locator('button:has-text("Cancel")')).toBeVisible();
      await expect(page.locator('text=Delete automatically in the future')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('cancel leaves the task in its original column', async () => {
    const { browser, page } = await launchWithState(makePreConfig());

    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });

      await dragTaskToColumn(page, 'Ready To Ship', 'Done');
      await expect(page.locator('text=Move to Done?')).toBeVisible({ timeout: 3000 });

      await page.locator('button:has-text("Cancel")').click();

      await expect(page.locator('text=Move to Done?')).toBeHidden({ timeout: 3000 });

      const executingColumn = page.locator('[data-swimlane-name="Executing"]');
      await expect(executingColumn.locator('text=Ready To Ship')).toBeVisible();

      // Cancel is a no-op - the config flag is still the default
      const skipConfirm = await page.evaluate(async () => {
        const config = await (window as unknown as { electronAPI: { config: { get: () => Promise<{ skipDoneWorktreeConfirm: boolean }> } } }).electronAPI.config.get();
        return config.skipDoneWorktreeConfirm;
      });
      expect(skipConfirm).toBe(false);
    } finally {
      await browser.close();
    }
  });

  test('confirm with "don\'t ask again" persists the config flag', async () => {
    const { browser, page } = await launchWithState(makePreConfig());

    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });

      await dragTaskToColumn(page, 'Ready To Ship', 'Done');
      await expect(page.locator('text=Move to Done?')).toBeVisible({ timeout: 3000 });

      // Tick the "Delete automatically in the future" checkbox
      const toggle = page.locator('text=Delete automatically in the future');
      await toggle.click();

      await page.locator('button:has-text("Move")').first().click();
      await expect(page.locator('text=Move to Done?')).toBeHidden({ timeout: 3000 });

      // Config should now be flipped so future Done drops skip the dialog
      const skipConfirm = await page.evaluate(async () => {
        const config = await (window as unknown as { electronAPI: { config: { get: () => Promise<{ skipDoneWorktreeConfirm: boolean }> } } }).electronAPI.config.get();
        return config.skipDoneWorktreeConfirm;
      });
      expect(skipConfirm).toBe(true);
    } finally {
      await browser.close();
    }
  });

  test('no dialog when skipDoneWorktreeConfirm is already true', async () => {
    const { browser, page } = await launchWithState(makePreConfig({ skipConfirm: true }));

    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });

      await dragTaskToColumn(page, 'Ready To Ship', 'Done');

      // No confirmation dialog at all
      await expect(page.locator('text=Move to Done?')).toBeHidden({ timeout: 2000 });
    } finally {
      await browser.close();
    }
  });

  test('pending uncommitted files force the dialog even when skipDoneWorktreeConfirm is true', async () => {
    // Even if the user has previously opted into silent auto-delete, a dirty
    // worktree must still trigger a confirm - the destructive delete would
    // wipe real work.
    const { browser, page } = await launchWithState(
      makePreConfig({
        skipConfirm: true,
        pendingChanges: { uncommittedFileCount: 3, unpushedCommitCount: 0 },
      }),
    );

    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });

      await dragTaskToColumn(page, 'Ready To Ship', 'Done');

      // Dialog must appear despite the skip preference
      await expect(page.locator('text=Move to Done?')).toBeVisible({ timeout: 3000 });
      await expect(page.locator('text=3 uncommitted files will be lost')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('pending unpushed commits force the dialog even when skipDoneWorktreeConfirm is true', async () => {
    const { browser, page } = await launchWithState(
      makePreConfig({
        skipConfirm: true,
        pendingChanges: { uncommittedFileCount: 0, unpushedCommitCount: 2 },
      }),
    );

    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });

      await dragTaskToColumn(page, 'Ready To Ship', 'Done');

      await expect(page.locator('text=Move to Done?')).toBeVisible({ timeout: 3000 });
      await expect(page.locator('text=2 unpushed commits will be lost')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('don\'t-ask-again checkbox is hidden when there are pending changes', async () => {
    // The checkbox is an escape hatch for clean Done moves only. When real
    // work is at risk, the user must not be able to re-suppress the warning
    // during this destructive operation.
    const { browser, page } = await launchWithState(
      makePreConfig({
        pendingChanges: { uncommittedFileCount: 1, unpushedCommitCount: 1 },
      }),
    );

    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });

      await dragTaskToColumn(page, 'Ready To Ship', 'Done');

      await expect(page.locator('text=Move to Done?')).toBeVisible({ timeout: 3000 });
      // Both counts surface in the dialog body
      await expect(page.locator('text=1 uncommitted file will be lost')).toBeVisible();
      await expect(page.locator('text=1 unpushed commit will be lost')).toBeVisible();
      // The "don't ask again" escape hatch is suppressed
      await expect(page.locator('text=Delete automatically in the future')).toBeHidden();
    } finally {
      await browser.close();
    }
  });

  // ---------------------------------------------------------------------------
  // Finding #1 / #4: git failure catch path
  //
  // When checkPendingChanges throws, useBoardDragDrop sets:
  //   pendingChanges = { uncommittedFileCount: 0, unpushedCommitCount: 0, hasPendingChanges: true }
  //
  // The slice stores only the counts (both 0). BoardDialogs then recomputes
  // hasPendingChanges = uncommittedFileCount > 0 || unpushedCommitCount > 0,
  // which evaluates to FALSE even though git failed and the worktree state is
  // unknown.
  //
  // As a result the dialog appears as variant='warning' (yellow, not red) and
  // the "Delete automatically in the future" checkbox IS shown - meaning a user
  // could suppress the safety net just after a git failure.
  //
  // This test documents the current (broken) behavior so that any future fix
  // causes an intentional test update. The dialog SHOULD be variant='danger'
  // and the checkbox SHOULD be hidden when git fails.
  // ---------------------------------------------------------------------------
  test('git failure with skipDoneWorktreeConfirm=true forces a locked danger dialog', async () => {
    // Override checkPendingChanges to throw so the catch block fires. Even
    // with skip=true, the dialog must appear AND must be locked into its
    // danger styling - the slice now stores hasPendingChanges explicitly so
    // BoardDialogs no longer recomputes it from the zero counts.
    const { browser, page } = await launchWithState(makePreConfig({ skipConfirm: true }));

    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });

      await page.evaluate(() => {
        (window as unknown as { electronAPI: { git: { checkPendingChanges: () => Promise<never> } } })
          .electronAPI.git.checkPendingChanges = async function () {
          throw new Error('git binary not found');
        };
      });

      await dragTaskToColumn(page, 'Ready To Ship', 'Done');

      // The dialog MUST appear - git failure should never be a silent skip.
      await expect(page.locator('text=Move to Done?')).toBeVisible({ timeout: 3000 });

      // Suppression checkbox is hidden - the user must not be able to silence
      // future warnings during a destructive move whose damage is unverified.
      await expect(page.locator('text=Delete automatically in the future')).toBeHidden();

      // The git-failure fallback copy is rendered in red, matching the
      // MoveConfirmMessage pattern from the To Do confirm path.
      await expect(page.locator('text=Unable to verify pending changes')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  // ---------------------------------------------------------------------------
  // Finding #2: requestDoneConfirmDirect path with pending counts
  //
  // When active.rect.current.initial is null (HMR / DOM destruction mid-drag)
  // the code falls back to requestDoneConfirmDirect instead of the animated
  // path. This test exercises that code path directly via the store action
  // without needing to simulate a real DOM destruction race.
  // ---------------------------------------------------------------------------
  test('requestDoneConfirmDirect with pending changes shows danger dialog', async () => {
    const { browser, page } = await launchWithState(makePreConfig());

    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });

      // Drive the store directly to exercise the direct (non-animated) path.
      // This is equivalent to what useBoardDragDrop does when initialRect is null.
      await page.evaluate(() => {
        const stores = (window as unknown as {
          __zustandStores?: {
            board: {
              getState: () => {
                requestDoneConfirmDirect: (
                  task: { id: string; title: string; branch_name: string; worktree_path: string },
                  input: { taskId: string; targetSwimlaneId: string; targetPosition: number },
                  pendingChanges: { hasPendingChanges: boolean; uncommittedFileCount: number; unpushedCommitCount: number },
                ) => void;
              };
            };
          };
        }).__zustandStores;
        stores?.board.getState().requestDoneConfirmDirect(
          {
            id: 'task-done-confirm',
            title: 'Ready To Ship',
            branch_name: 'ready-to-ship-abcd1234',
            worktree_path: '/mock/worktrees/ready-to-ship',
          },
          {
            taskId: 'task-done-confirm',
            targetSwimlaneId: 'lane-done',
            targetPosition: 0,
          },
          { hasPendingChanges: true, uncommittedFileCount: 2, unpushedCommitCount: 1 },
        );
      });

      // The dialog should appear with the correct content.
      await expect(page.locator('text=Move to Done?')).toBeVisible({ timeout: 3000 });
      await expect(page.locator('text=2 uncommitted files will be lost')).toBeVisible();
      await expect(page.locator('text=1 unpushed commit will be lost')).toBeVisible();
      // Danger variant: "don't ask again" checkbox is suppressed.
      await expect(page.locator('text=Delete automatically in the future')).toBeHidden();
    } finally {
      await browser.close();
    }
  });

  // ---------------------------------------------------------------------------
  // Finding #3: regression spy - checkPendingChanges is always called
  //
  // Even when skipDoneWorktreeConfirm=true and the worktree is clean, the IPC
  // probe must still fire. A future optimisation that short-circuits the probe
  // based on the config flag alone would reintroduce the silent-delete bug.
  // ---------------------------------------------------------------------------
  test('checkPendingChanges is called even when skipDoneWorktreeConfirm is true', async () => {
    const { browser, page } = await launchWithState(makePreConfig({ skipConfirm: true }));

    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });

      // Replace checkPendingChanges with a call-counting spy that returns a
      // clean result so the dialog is still skipped (verifying the probe fired
      // without changing the observable drag outcome).
      await page.evaluate(() => {
        (window as unknown as {
          __checkPendingChangesCalled: boolean;
          electronAPI: { git: { checkPendingChanges: () => Promise<{ hasPendingChanges: boolean; uncommittedFileCount: number; unpushedCommitCount: number }> } };
        }).__checkPendingChangesCalled = false;

        const originalFn = (window as unknown as {
          electronAPI: { git: { checkPendingChanges: () => Promise<{ hasPendingChanges: boolean; uncommittedFileCount: number; unpushedCommitCount: number }> } };
        }).electronAPI.git.checkPendingChanges;

        (window as unknown as {
          electronAPI: { git: { checkPendingChanges: () => Promise<{ hasPendingChanges: boolean; uncommittedFileCount: number; unpushedCommitCount: number }> } };
        }).electronAPI.git.checkPendingChanges = async function (...args) {
          (window as unknown as { __checkPendingChangesCalled: boolean }).__checkPendingChangesCalled = true;
          return originalFn.apply(this, args as []);
        };
      });

      await dragTaskToColumn(page, 'Ready To Ship', 'Done');

      // No dialog because skip=true AND the worktree is clean.
      // (intentional fixed wait - we cannot poll for non-occurrence)
      await page.waitForTimeout(1000);
      await expect(page.locator('text=Move to Done?')).toBeHidden();

      // The probe MUST have fired despite the skip flag.
      const wasCalled = await page.evaluate(() => {
        return (window as unknown as { __checkPendingChangesCalled: boolean }).__checkPendingChangesCalled;
      });
      expect(wasCalled).toBe(true);
    } finally {
      await browser.close();
    }
  });

  test('no dialog when the task has no worktree to delete', async () => {
    // Tasks that go straight from To Do to Done never created a worktree;
    // there's nothing destructive about the move, so the dialog is suppressed.
    const noWorktreeConfig = `
      window.__mockPreConfigure(function (state) {
        var ts = new Date().toISOString();
        state.projects.push({
          id: '${PROJECT_ID}',
          name: 'No Worktree Test',
          path: '/mock/no-worktree-test',
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
        state.tasks.push({
          id: '${TASK_ID}',
          title: 'Quick Done',
          description: 'A task that never created a worktree',
          swimlane_id: laneIds['Executing'],
          position: 0,
          agent: 'claude',
          session_id: null,
          worktree_path: null,
          branch_name: null,
          pr_number: null,
          pr_url: null,
          base_branch: 'main',
          use_worktree: 1,
          labels: [],
          priority: 0,
          attachment_count: 0,
          archived_at: null,
          created_at: ts,
          updated_at: ts,
        });
        return { currentProjectId: '${PROJECT_ID}' };
      });
    `;
    const { browser, page } = await launchWithState(noWorktreeConfig);

    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });

      await dragTaskToColumn(page, 'Quick Done', 'Done');

      // No dialog appeared
      await expect(page.locator('text=Move to Done?')).toBeHidden({ timeout: 2000 });
    } finally {
      await browser.close();
    }
  });
});
