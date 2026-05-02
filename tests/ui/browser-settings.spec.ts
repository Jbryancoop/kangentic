import { test, expect } from '@playwright/test';
import { launchPage, createProject } from './helpers';
import type { Browser, Page } from '@playwright/test';

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchPage();
  browser = result.browser;
  page = result.page;
  await createProject(page, `Webview Settings ${Date.now()}`);
});

test.afterAll(async () => {
  await browser?.close();
});

async function openBrowserTab() {
  await page.locator('button[title="Settings"]').click();
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
  await page.getByRole('button', { name: 'Browser', exact: true }).click();
  await expect(page.getByText('Enable Browser Pane')).toBeVisible();
}

async function closeSettings() {
  await page.keyboard.press('Escape');
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'hidden', timeout: 2000 });
}

test.describe('Browser settings tab', () => {
  test('exposes Clear Browser Data row with destructive button', async () => {
    await openBrowserTab();
    await expect(page.getByText('Clear Browser Data')).toBeVisible();
    await expect(page.getByTestId('browser-clear-storage')).toBeVisible();
    await expect(page.getByTestId('browser-clear-storage')).toContainText('Clear data');
    await closeSettings();
  });

  test('Clear data -> Cancel keeps button idle and fires no toast', async () => {
    await openBrowserTab();
    await page.getByTestId('browser-clear-storage').click();

    await expect(page.locator('h3:has-text("Clear browser data?")')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('h3:has-text("Clear browser data?")')).toBeHidden();

    // No toast should appear
    await expect(page.getByTestId('toast')).toHaveCount(0);
    // Button is back to idle (not disabled, label "Clear data")
    await expect(page.getByTestId('browser-clear-storage')).toBeEnabled();
    await expect(page.getByTestId('browser-clear-storage')).toContainText('Clear data');
    await closeSettings();
  });

  test('Clear data -> Confirm wipes via IPC and shows success toast', async () => {
    await openBrowserTab();

    // Spy: count clearStorage invocations on the mock
    await page.evaluate(() => {
      (window as unknown as { __browserClearCalls: number }).__browserClearCalls = 0;
      const original = window.electronAPI.browser.clearStorage;
      window.electronAPI.browser.clearStorage = async () => {
        (window as unknown as { __browserClearCalls: number }).__browserClearCalls += 1;
        return original();
      };
    });

    await page.getByTestId('browser-clear-storage').click();
    const dialog = page.locator('h3:has-text("Clear browser data?")').locator('xpath=ancestor::*[contains(@class, "z-[60]")][1]');
    await expect(dialog).toBeVisible();
    // Confirm uses the destructive label - scoped to the dialog footer to
    // disambiguate from the settings-row button that has the same label
    await dialog.getByRole('button', { name: 'Clear data', exact: true }).click();

    await expect(page.getByTestId('toast').filter({ hasText: 'Browser data cleared. Reload the browser pane to apply.' })).toBeVisible();

    const callCount = await page.evaluate(
      () => (window as unknown as { __browserClearCalls: number }).__browserClearCalls,
    );
    expect(callCount).toBe(1);

    // Button returns to idle after the action resolves
    await expect(page.getByTestId('browser-clear-storage')).toBeEnabled();
    await expect(page.getByTestId('browser-clear-storage')).toContainText('Clear data');
    await closeSettings();
  });

  test('confirm dialog has no "Don\'t ask again" checkbox', async () => {
    await openBrowserTab();
    await page.getByTestId('browser-clear-storage').click();
    await expect(page.locator('h3:has-text("Clear browser data?")')).toBeVisible();
    await expect(page.getByText("Don't ask again")).toHaveCount(0);
    await page.getByRole('button', { name: 'Cancel' }).click();
    await closeSettings();
  });

  test('shows error toast and returns button to idle when clearStorage rejects', async () => {
    await openBrowserTab();

    // Monkeypatch clearStorage to reject with a specific error before clicking.
    await page.evaluate(() => {
      window.electronAPI.browser.clearStorage = async () => {
        throw new Error('simulated electron failure');
      };
    });

    await page.getByTestId('browser-clear-storage').click();

    const dialog = page.locator('h3:has-text("Clear browser data?")').locator('xpath=ancestor::*[contains(@class, "z-[60]")][1]');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Clear data', exact: true }).click();

    // Error toast must contain the static prefix and the thrown message.
    await expect(
      page.getByTestId('toast').filter({ hasText: 'Failed to clear browser data' }),
    ).toBeVisible();
    await expect(
      page.getByTestId('toast').filter({ hasText: 'simulated electron failure' }),
    ).toBeVisible();

    // Button must return to idle state: enabled and labelled "Clear data".
    await expect(page.getByTestId('browser-clear-storage')).toBeEnabled();
    await expect(page.getByTestId('browser-clear-storage')).toContainText('Clear data');

    await closeSettings();
  });
});
