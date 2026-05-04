/**
 * E2E coverage: BrowserPane Send button -> paste-engine -> mock-claude
 * round-trip.
 *
 * Drives the real Electron <webview>, real PTY, and real paste-engine. The
 * webview's initial src is a data: URL, which the main-process hardening
 * rewrites to about:blank (will-attach-webview policy). That is fine for
 * coverage purposes -- capturePage() works on about:blank, returning a
 * blank PNG. The point of the test is the IPC -> file -> paste-engine ->
 * mock-claude PTY chain, not the rendered page content.
 */
import { test, expect } from '@playwright/test';
import {
  launchApp,
  createProject,
  createTask,
  createTempProject,
  cleanupTempProject,
  getTestDataDir,
  waitForRunningSession,
  waitForScrollback,
  getTaskIdByTitle,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const TEST_NAME = 'browser-send-roundtrip';
const runId = Date.now();
const PROJECT_NAME = `Browser Send ${runId}`;
let app: ElectronApplication;
let page: Page;
let tmpDir: string;
let dataDir: string;

function mockClaudePath(): string {
  const fixturesDir = path.join(__dirname, '..', 'fixtures');
  if (process.platform === 'win32') {
    return path.join(fixturesDir, 'mock-claude.cmd');
  }
  const jsPath = path.join(fixturesDir, 'mock-claude.js');
  fs.chmodSync(jsPath, 0o755);
  return jsPath;
}

test.beforeAll(async () => {
  tmpDir = createTempProject(TEST_NAME);
  dataDir = getTestDataDir(TEST_NAME);

  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      claude: {
        cliPath: mockClaudePath(),
        permissionMode: 'default',
        maxConcurrentSessions: 5,
        queueOverflow: 'queue',
      },
      git: {
        worktreesEnabled: false,
      },
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
});

async function dragTaskToColumn(taskTitle: string, targetColumn: string): Promise<void> {
  const card = page.locator('[data-testid="swimlane"]').locator(`text=${taskTitle}`).first();
  await card.waitFor({ state: 'visible', timeout: 5000 });
  const target = page.locator(`[data-swimlane-name="${targetColumn}"]`);
  await target.waitFor({ state: 'visible', timeout: 5000 });

  const cardBox = await card.boundingBox();
  const targetBox = await target.boundingBox();
  if (!cardBox || !targetBox) throw new Error('Could not get bounding boxes');

  await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(cardBox.x + 10, cardBox.y, { steps: 3 });
  await page.waitForTimeout(100);
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + 80, { steps: 15 });
  await page.waitForTimeout(200);
  await page.mouse.up();
  await page.waitForTimeout(500);
}

test.describe('Claude Agent -- Browser Send round-trip', () => {
  // Windows-only platform limitation: this test asserts the paste content
  // (`<browser_context>` envelope) appears in PTY scrollback, relying on
  // line-discipline echo of pasted bytes. ConPTY does not echo input the
  // way Linux/macOS PTYs do - it absorbs bracketed-paste markers and does
  // not surface the wrapped content as visible terminal output. The IPC
  // handler -> capture-file -> paste-engine wiring is covered at unit tier
  // (`tests/unit/browser-handler-error-translation.test.ts` and
  // `attachment-chips`); the capture-file existence path is also covered
  // by the `eats-first-cr` case in `browser-evidence-retry.spec.ts`. This
  // E2E remains valuable on POSIX PTYs to prove the full round-trip.
  test('Send composites capture and submits the prompt envelope to the agent PTY', async () => {
    test.fixme(process.platform === 'win32', 'ConPTY does not echo paste content into scrollback; round-trip covered at unit tier.');
    const title = `Browser Send ${runId}`;
    const description = 'browser send round-trip';
    await createTask(page, title, description);
    await dragTaskToColumn(title, 'Code Review');
    await waitForRunningSession(page);

    const taskId = await getTaskIdByTitle(page, title);

    // Seed the task URL so BrowserPane skips its empty state and mounts the
    // active branch with the <webview>. data: URLs are rewritten to
    // about:blank by the main-process hardening, which is fine -- the test
    // only needs SOME page rendered so capturePage() returns a NativeImage.
    await page.evaluate(async (id: string) => {
      await window.electronAPI.browser.setTaskUrl(
        id,
        'data:text/html,<h1>kangentic-browser-send-roundtrip</h1>',
      );
    }, taskId);

    // Open the task detail dialog by clicking the card.
    const card = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator(`text=${title}`)
      .first();
    await card.click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 5000 });

    // Toggle Browser pane.
    await page.locator('[data-testid="browser-toggle"]').click();
    await page.locator('[data-testid="browser-pane"]').waitFor({ state: 'visible', timeout: 5000 });

    // Wait for the webview to settle so capturePage() has something to copy.
    // about:blank is effectively instant but we guard against early Send.
    await page.waitForTimeout(500);

    // Click Send. Dialog has the terminal subscribed via TERMINAL_SUBSCRIBE,
    // so the paste-engine has the session in focusedSessionIds when invoked.
    await page.locator('[data-testid="browser-send"]').click();

    // Capture file is written under <projectRoot>/.kangentic/sessions/<sid>/captures/
    const capturesDir = path.join(tmpDir, '.kangentic', 'sessions');
    await expect.poll(
      () => {
        if (!fs.existsSync(capturesDir)) return 0;
        let total = 0;
        for (const sessionDir of fs.readdirSync(capturesDir)) {
          const dir = path.join(capturesDir, sessionDir, 'captures');
          if (!fs.existsSync(dir)) continue;
          total += fs.readdirSync(dir).filter((f) => f.endsWith('.png')).length;
        }
        return total;
      },
      { timeout: 15000, intervals: [200, 500, 1000] },
    ).toBeGreaterThanOrEqual(1);

    // The paste-engine should have shipped the XML-tagged prompt to the
    // mock's PTY. Mock-claude does not interpret the prompt -- but the
    // bracketed-paste packet bytes traverse the PTY and PTY echo (line
    // discipline) reflects them in scrollback, where we can grep the XML
    // envelope tags.
    const scrollback = await waitForScrollback(page, '<browser_context>', 20000);
    expect(scrollback).toContain('<browser_context>');
    expect(scrollback).toContain('<url>');
  });
});
