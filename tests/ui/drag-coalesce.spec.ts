import { test, expect } from '@playwright/test';
import { launchPage, waitForBoard, createProject, createTask } from './helpers';
import type { Browser, Page } from '@playwright/test';

/**
 * Drag-jank gate: while a board drag is active, non-positional session-store
 * pushes (spawn progress, activity, ...) must be HELD by the coalescer so the
 * initializing TaskCard does not re-render mid-drag (which would force dnd-kit
 * to re-measure on the pointer-move thread). They flush on drag end.
 *
 * Asserting at the store level is the clean proxy: if the held update never
 * reaches the session store during the drag, the subscribed card cannot
 * re-render from it. We verify the value is unchanged during the drag and
 * applied immediately after the drop.
 */

const runId = Date.now();
const PROJECT_NAME = `Coalesce Test ${runId}`;
const DRAG_TASK = 'Drag Me Smoothly';
const SPAWNING_TASK = 'Initializing Task';

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchPage();
  browser = result.browser;
  page = result.page;
  await createProject(page, PROJECT_NAME, '/tmp/coalesce-test');
  await createTask(page, DRAG_TASK);
  await createTask(page, SPAWNING_TASK);
  await waitForBoard(page);
});

test.afterAll(async () => {
  await browser?.close();
});

/** Resolve a task's id from the exposed board store (createTask doesn't return it). */
async function getTaskIdByTitle(title: string): Promise<string> {
  const id = await page.evaluate((wantedTitle) => {
    const win = window as unknown as {
      __zustandStores: { board: { getState: () => { tasks: Array<{ id: string; title: string }> } } };
    };
    const found = win.__zustandStores.board.getState().tasks.find((task) => task.title === wantedTitle);
    return found ? found.id : null;
  }, title);
  if (!id) throw new Error(`Task "${title}" not found in board store`);
  return id;
}

/** Read the held-or-applied spawn-progress label for a task from the session store. */
async function readSpawnProgress(taskId: string): Promise<string | null> {
  return page.evaluate((id) => {
    const win = window as unknown as {
      __zustandStores: { session: { getState: () => { spawnProgress: Record<string, string> } } };
    };
    return win.__zustandStores.session.getState().spawnProgress[id] ?? null;
  }, taskId);
}

async function fireSpawnProgress(taskId: string, label: string | null): Promise<void> {
  await page.evaluate((args) => {
    const win = window as unknown as {
      __mockFireSpawnProgress: (taskId: string, label: string | null) => void;
    };
    win.__mockFireSpawnProgress(args.taskId, args.label);
  }, { taskId, label });
}

test('spawn-progress updates are deferred during an active board drag and flushed on drop', async () => {
  const dragTaskId = await getTaskIdByTitle(DRAG_TASK);
  const spawningTaskId = await getTaskIdByTitle(SPAWNING_TASK);

  // Baseline: with no drag in progress, a push applies (coalesced on a microtask).
  await fireSpawnProgress(spawningTaskId, 'Creating worktree...');
  await expect.poll(() => readSpawnProgress(spawningTaskId), { timeout: 2000 })
    .toBe('Creating worktree...');

  // Start (but don't finish) a drag on the OTHER card so a drag is active.
  const dragCard = page.locator(`[data-task-id="${dragTaskId}"]`);
  await dragCard.waitFor({ state: 'visible', timeout: 5000 });
  const box = await dragCard.boundingBox();
  if (!box) throw new Error('Could not get bounding box for drag card');
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Move past the 5px PointerSensor activation threshold to start the drag.
  await page.mouse.move(startX + 12, startY, { steps: 3 });
  await expect(page.locator('.drag-overlay').filter({ hasText: DRAG_TASK }))
    .toBeVisible({ timeout: 2000 });

  // While the drag is active, push a NEW spawn-progress label for the other task.
  await fireSpawnProgress(spawningTaskId, 'Starting agent...');

  // It must be HELD: the session store still shows the pre-drag label. The fixed
  // wait gives any erroneously-scheduled microtask flush time to run, so this
  // asserts the absence of an update rather than racing it.
  await page.waitForTimeout(200);
  expect(await readSpawnProgress(spawningTaskId)).toBe('Creating worktree...');

  // Release the drag. endBoardDrag() flushes synchronously at the top of
  // handleDragEnd, so the held update applies.
  await page.mouse.up();
  await page.locator('.drag-overlay').filter({ hasText: DRAG_TASK })
    .waitFor({ state: 'detached', timeout: 2000 }).catch(() => {});

  await expect.poll(() => readSpawnProgress(spawningTaskId), { timeout: 2000 })
    .toBe('Starting agent...');
});
