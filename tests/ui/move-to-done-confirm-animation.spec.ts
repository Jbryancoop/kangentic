/**
 * Regression test: the animated fly path runs after the worktree-delete confirm
 * dialog is confirmed (requestDoneConfirmAnimated -> confirmPendingDone animated branch).
 *
 * Gap covered: the existing move-to-done-confirm.spec.ts only checks dialog
 * appearance/disappearance and the config flag; it does NOT assert that
 * `setCompletingTask` was actually called when the user clicks Move, and
 * therefore would NOT catch a regression where `confirmPendingDone`'s animated
 * branch was silently changed to call `moveTask` directly (skipping the fly
 * animation).
 *
 * The move-to-done-worktree-rect-fallback.spec.ts covers the skip=true
 * (no-dialog) animated path. This spec covers the skip=false animated path,
 * i.e. the path through the confirm dialog gate.
 *
 * Test strategy:
 *   - Task has worktree_path non-null (so checkPendingChanges fires)
 *   - window.__mockPendingChangesResult forces hasPendingChanges: true so the
 *     confirm dialog always opens, even when skipDoneWorktreeConfirm is true
 *   - A Zustand subscriber installed before the drag records whether
 *     setCompletingTask was ever called (completingTaskSetCount > 0) and
 *     whether recentlyArchivedId reached the dragged task's id
 *   - The test drags to Done, confirms the dialog appears, clicks Move, then
 *     polls for both conditions and asserts the task landed in archivedTasks
 *
 * Red-green reasoning:
 *   If confirmPendingDone's animated branch did NOT call setCompletingTask (e.g.
 *   someone swapped it to `await get().moveTask(pending.input)` like the direct
 *   branch does), then completingTaskSetCount would stay at 0 and the first
 *   expect.poll would fail. The test is therefore falsifiable at the critical point.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-done-confirm-anim';
const TASK_ID = 'task-done-confirm-anim';

async function launch(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  // skipDoneWorktreeConfirm: true so the dialog would normally be suppressed.
  // __mockPendingChangesResult overrides checkPendingChanges to return
  // hasPendingChanges: true - this forces the confirm dialog open regardless of
  // the skip flag (dirty worktrees always require confirmation even when the user
  // has opted into silent auto-delete for clean moves).
  const preConfigScript = `
    window.__mockConfigOverrides = Object.assign(
      window.__mockConfigOverrides || {},
      { skipDoneWorktreeConfirm: true }
    );
    if (typeof window.electronAPI !== 'undefined' && window.electronAPI.config) {
      void window.electronAPI.config.set({ skipDoneWorktreeConfirm: true });
    }
    window.__mockPendingChangesResult = {
      hasPendingChanges: true,
      uncommittedFileCount: 1,
      unpushedCommitCount: 0,
    };
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Done Confirm Animation Test',
        path: '/mock/done-confirm-anim-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });
      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = 'lane-ca-' + s.name.toLowerCase().replace(/\\s+/g, '-');
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
        title: 'Confirm Then Fly',
        description: 'Worktree task with pending changes - dialog then animated fly',
        swimlane_id: laneIds['Executing'],
        position: 0,
        agent: 'claude',
        session_id: null,
        worktree_path: '/mock/wt/confirm-then-fly',
        branch_name: 'confirm-then-fly-abcd1234',
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

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  return { browser, page };
}

interface AnimationProbeReadout {
  completingTaskSetCount: number;
  lastRecentlyArchivedId: string | null;
  seenRecentlyArchivedIds: string[];
}

async function installAnimationProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: {
        board: {
          subscribe: (listener: (state: unknown) => void) => () => void;
          getState: () => {
            completingTask: unknown;
            recentlyArchivedId: string | null;
          };
        };
      };
    }).__zustandStores;
    if (!stores) throw new Error('window.__zustandStores not exposed');
    const probe = {
      completingTaskSetCount: 0,
      lastRecentlyArchivedId: null as string | null,
      seenRecentlyArchivedIds: [] as string[],
    };
    (window as unknown as { __animationProbeConfirmAnim: typeof probe }).__animationProbeConfirmAnim = probe;
    stores.board.subscribe((state) => {
      const typed = state as { completingTask: unknown; recentlyArchivedId: string | null };
      if (typed.completingTask !== null && typed.completingTask !== undefined) {
        probe.completingTaskSetCount += 1;
      }
      if (typed.recentlyArchivedId) {
        probe.lastRecentlyArchivedId = typed.recentlyArchivedId;
        if (!probe.seenRecentlyArchivedIds.includes(typed.recentlyArchivedId)) {
          probe.seenRecentlyArchivedIds.push(typed.recentlyArchivedId);
        }
      }
    });
  });
}

async function readAnimationProbe(page: Page): Promise<AnimationProbeReadout> {
  return page.evaluate(() => {
    const probe = (window as unknown as { __animationProbeConfirmAnim?: AnimationProbeReadout }).__animationProbeConfirmAnim;
    if (!probe) throw new Error('__animationProbeConfirmAnim was not installed');
    return {
      completingTaskSetCount: probe.completingTaskSetCount,
      lastRecentlyArchivedId: probe.lastRecentlyArchivedId,
      seenRecentlyArchivedIds: [...probe.seenRecentlyArchivedIds],
    };
  });
}

async function dragTaskToColumn(page: Page, taskTitle: string, targetColumn: string): Promise<void> {
  const card = page.locator('[data-testid="swimlane"]').locator(`text=${taskTitle}`).first();
  await card.waitFor({ state: 'visible', timeout: 5000 });

  const target = page.locator(`[data-swimlane-name="${targetColumn}"]`);
  await target.waitFor({ state: 'visible', timeout: 5000 });

  await page.evaluate((targetCol: string) => {
    document.querySelector(`[data-swimlane-name="${targetCol}"]`)?.scrollIntoView({ inline: 'nearest', behavior: 'instant' });
  }, targetColumn);

  // boundingBox() forces a layout flush; post-scroll geometry is accurate
  // without a fixed wait.
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
  // distance; poll the board store's activeTask instead of guessing with a sleep.
  await page.mouse.move(startX + 10, startY, { steps: 3 });
  await expect.poll(async () => page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: { board: { getState: () => { activeTask: { id: string } | null } } };
    }).__zustandStores;
    return stores?.board.getState().activeTask !== null;
  }), { timeout: 2000 }).toBe(true);

  await page.mouse.move(endX, endY, { steps: 15 });
  // DoneSwimlane toggles `.drop-zone-active` via dnd-kit's isOver. Poll for it
  // so the drop fires only after the hover state is registered.
  await expect(target.locator('.drop-zone-active')).toBeVisible({ timeout: 2000 });

  await page.mouse.up();
  // Drop outcome (dialog appearance) is asserted by the caller.
}

test.describe('Move to Done - confirm dialog animated path', () => {
  test('clicking Move after the confirm dialog triggers setCompletingTask and archives the task', async () => {
    // This is the gap test: the confirm dialog opens (requestDoneConfirmAnimated)
    // and the user confirms (confirmPendingDone animated branch). We assert that
    // confirmPendingDone's animated branch actually called setCompletingTask
    // (which hands off to FlyingCard) and that the task ultimately lands in
    // archivedTasks via finalizeCompletion -> moveTask -> recentlyArchivedId.
    const { browser, page } = await launch();

    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });
      await expect(
        page.locator('[data-swimlane-name="Executing"]').locator('text=Confirm Then Fly'),
      ).toBeVisible();

      await installAnimationProbe(page);

      await dragTaskToColumn(page, 'Confirm Then Fly', 'Done');

      // The confirm dialog MUST open because __mockPendingChangesResult has
      // hasPendingChanges: true, which overrides skipDoneWorktreeConfirm.
      await expect(page.locator('text=Move to Done?')).toBeVisible({ timeout: 3000 });
      await expect(page.locator('text=1 uncommitted file will be lost')).toBeVisible();

      // Click the Move/confirm button - same selector as move-to-done-confirm.spec.ts.
      await page.locator('button:has-text("Move")').first().click();

      // Dialog must close immediately.
      await expect(page.locator('text=Move to Done?')).toBeHidden({ timeout: 3000 });

      // Poll for recentlyArchivedId reaching the task id. The FlyingCard
      // fallback is 700ms, plus moveTask IPC round-trip. 5s is generous for
      // a mocked IPC.
      await expect
        .poll(async () => (await readAnimationProbe(page)).lastRecentlyArchivedId, { timeout: 5000 })
        .toBe(TASK_ID);

      const probe = await readAnimationProbe(page);
      // setCompletingTask was called at least once, proving the animated entry
      // path ran (confirmPendingDone animated branch -> setCompletingTask ->
      // FlyingCard -> finalizeCompletion). If this is 0, the animated branch
      // was bypassed and the animation was silently skipped.
      expect(probe.completingTaskSetCount).toBeGreaterThanOrEqual(1);
      // recentlyArchivedId reached the task id, proving finalizeCompletion ran
      // the success path that sets recentlyArchivedId (drives .grow-in).
      expect(probe.seenRecentlyArchivedIds).toContain(TASK_ID);

      // The task must also be in archivedTasks (final persistence check).
      const isArchived = await page.evaluate(async (taskId: string) => {
        const archived = await (window as unknown as {
          electronAPI: { tasks: { listArchived: () => Promise<{ id: string }[]> } };
        }).electronAPI.tasks.listArchived();
        return archived.some((archivedTask) => archivedTask.id === taskId);
      }, TASK_ID);
      expect(isArchived).toBe(true);
    } finally {
      await browser.close();
    }
  });
});
