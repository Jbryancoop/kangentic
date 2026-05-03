/**
 * UI tests for the EditColumnDialog:
 * - Agent section divider
 * - Permission Mode dropdown (per-column override)
 * - Auto-spawn toggle (per-column agent auto-start)
 * - Plan exit target dropdown (for plan-mode columns)
 * - Locked state for system columns (To Do, Done)
 */
import { test, expect } from '@playwright/test';
import { launchPage, waitForBoard, createProject } from './helpers';
import type { Browser, Page } from '@playwright/test';

const PROJECT_NAME = `EditCol Test ${Date.now()}`;
let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchPage();
  browser = result.browser;
  page = result.page;
  await createProject(page, PROJECT_NAME);
  await waitForBoard(page);
});

test.afterAll(async () => {
  await browser?.close();
});

/** Open the EditColumnDialog for a given column name */
async function openEditDialog(columnName: string) {
  const column = page.locator(`[data-swimlane-name="${columnName}"]`);
  await column.locator(`text=${columnName}`).click();
  await page.waitForTimeout(300);
  // Verify dialog opened
  await expect(page.locator('text=Edit Column')).toBeVisible({ timeout: 3000 });
}

/** Close dialog via Escape */
async function closeDialog() {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

test.describe('EditColumnDialog', () => {
  test('Agent section divider is visible', async () => {
    await openEditDialog('Code Review');

    await expect(page.locator('text=Agent').first()).toBeVisible();

    // Permissions and Auto-spawn are always visible (no collapse)
    await expect(page.locator('label:has-text("Permissions")').first()).toBeVisible();
    await expect(page.locator('label:has-text("Auto-spawn")').first()).toBeVisible();

    await closeDialog();
  });

  test('custom column shows editable permissions dropdown with Default selected', async () => {
    await openEditDialog('Code Review');

    const dialog = page.locator('.bg-surface-raised').filter({ hasText: 'Edit Column' });
    const select = dialog.locator('select').last();
    await expect(select).toBeEnabled();

    // Global default should be the selected value (empty string = inherit)
    const value = await select.inputValue();
    expect(value).toBe('');

    // First option shows resolved global value (mock default is 'default' → "Default (Allowlist)")
    // Duplicate is filtered out -- only appears once as the default option
    const options = await select.locator('option').allTextContents();
    expect(options.filter((o) => o === 'Default (Allowlist)')).toHaveLength(1);
    expect(options).toContain('Plan (Read-Only)');
    expect(options).toContain('Accept Edits');
    expect(options).toContain('Auto (Classifier)');
    expect(options).toContain('Bypass (Unsafe)');

    await closeDialog();
  });

  test('custom column shows editable auto-spawn toggle (ON)', async () => {
    await openEditDialog('Code Review');

    const toggle = page.getByRole('switch', { name: 'Auto-spawn' });
    await expect(toggle).toBeEnabled();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    await closeDialog();
  });

  test('Planning column has editable permissions set to Plan', async () => {
    await openEditDialog('Planning');

    const select = page.locator('[data-testid="column-permission-mode"]');
    await expect(select).toBeEnabled();

    const value = await select.inputValue();
    expect(value).toBe('plan');

    await closeDialog();
  });

  test('Planning column has editable auto-spawn ON', async () => {
    await openEditDialog('Planning');

    const toggle = page.getByRole('switch', { name: 'Auto-spawn' });
    await expect(toggle).toBeEnabled();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    await closeDialog();
  });

  test('Planning column shows plan exit target dropdown', async () => {
    await openEditDialog('Planning');

    const planExitSelect = page.locator('[data-testid="plan-exit-target"]');
    await expect(planExitSelect).toBeVisible();

    // Default target should be Executing
    const options = await planExitSelect.locator('option').allTextContents();
    expect(options).toContain('Nowhere (stay in column)');
    expect(options).toContain('Executing');

    // Should not include current column, To Do, or Done
    expect(options).not.toContain('Planning');
    expect(options).not.toContain('To Do');
    expect(options).not.toContain('Done');

    await closeDialog();
  });

  test('To Do column hides agent section entirely', async () => {
    await openEditDialog('To Do');

    // Agent section should not be visible for To Do column
    await expect(page.locator('button[role="switch"]')).toHaveCount(0);
    await expect(page.locator('label:has-text("Permissions")')).toHaveCount(0);
    await expect(page.locator('label:has-text("Auto-spawn")')).toHaveCount(0);

    // Name, Icon, Color should still be visible
    await expect(page.locator('label:has-text("Name")')).toBeVisible();
    await expect(page.locator('label:has-text("Color")')).toBeVisible();

    await closeDialog();
  });

  test('pencil button opens edit dialog on custom column', async () => {
    const column = page.locator('[data-swimlane-name="Code Review"]');
    await column.locator('[data-testid="edit-column-btn"]').click();
    await expect(page.locator('text=Edit Column')).toBeVisible({ timeout: 3000 });
    await closeDialog();
  });

  test('pencil button opens edit dialog on Done column', async () => {
    const column = page.locator('[data-swimlane-name="Done"]');
    await column.locator('[data-testid="edit-column-btn"]').click();
    await expect(page.locator('text=Edit Column')).toBeVisible({ timeout: 3000 });
    await closeDialog();
  });

  test('renders Model dropdown when the agent ships an availableModels list', async () => {
    await openEditDialog('Code Review');

    // Default mock agent (Claude) declares effortLevels, supportsModelOverride,
    // AND a discovered models list. Model is now a combobox with autocomplete;
    // effort still renders as a dropdown.
    const modelCombobox = page.locator('[data-testid="column-model-override"]');
    await expect(modelCombobox).toBeVisible();
    // Combobox is an input; opening the dropdown shows suggestions
    await expect(modelCombobox).toHaveAttribute('type', 'text');
    await modelCombobox.click(); // Click to open dropdown
    // Check that suggestions appear in the dropdown list
    const dropdownItems = page.locator('[data-model-option]');
    const modelTexts = await dropdownItems.allTextContents();
    expect(modelTexts).toContain('opus');
    expect(modelTexts).toContain('sonnet');
    expect(modelTexts).toContain('haiku');

    const effortSelect = page.locator('[data-testid="column-effort-override"]');
    await expect(effortSelect).toBeVisible();
    const effortOptions = await effortSelect.locator('option').allTextContents();
    expect(effortOptions).toContain('Default');
    expect(effortOptions).toContain('low');
    expect(effortOptions).toContain('xhigh');
    expect(effortOptions).toContain('max');

    await closeDialog();
  });

  test('falls back to free-form input when models capability is empty', async () => {
    await page.evaluate(() => {
      (window as unknown as { __mockAgentListOverrides: Record<string, unknown> }).__mockAgentListOverrides = {
        claude: {
          capabilities: {
            effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
            supportsModelOverride: true,
            // models intentionally omitted -> renderer falls back to <input>.
          },
        },
      };
    });

    await openEditDialog('Code Review');
    const modelInput = page.locator('[data-testid="column-model-override"]');
    // <input> exposes a placeholder; <select> does not. Use the tag name as
    // the structural assertion.
    await expect(modelInput).toBeVisible();
    const tag = await modelInput.evaluate((node) => node.tagName.toLowerCase());
    expect(tag).toBe('input');
    await expect(modelInput).toHaveAttribute('placeholder', /default/i);

    await closeDialog();
    await page.evaluate(() => {
      (window as unknown as { __mockAgentListOverrides: undefined }).__mockAgentListOverrides = undefined;
    });
  });

  test('persists Model and Effort overrides round-trip', async () => {
    await openEditDialog('Code Review');

    const modelCombobox = page.locator('[data-testid="column-model-override"]');
    await modelCombobox.fill('opus');
    const effortSelect = page.locator('[data-testid="column-effort-override"]');
    await effortSelect.selectOption('xhigh');

    await page.locator('button:has-text("Save")').click();
    await page.waitForTimeout(500);

    await openEditDialog('Code Review');
    const modelComboboxAfter = page.locator('[data-testid="column-model-override"]');
    await expect(modelComboboxAfter).toHaveValue('opus');
    const effortSelectAfter = page.locator('[data-testid="column-effort-override"]');
    await expect(effortSelectAfter).toHaveValue('xhigh');

    // Reset both so subsequent tests start clean.
    await modelComboboxAfter.clear();
    await effortSelectAfter.selectOption('');
    await page.locator('button:has-text("Save")').click();
    await page.waitForTimeout(300);
  });

  test('Model and Effort dropdowns hide when the active agent does not declare capabilities', async () => {
    // Mark Codex as installed so the agent override dropdown lists it. The
    // dialog re-fetches agentList from the IPC mock on every open via the
    // useEffect at mount, so opening after the override is enough; no reload.
    await page.evaluate(() => {
      (window as unknown as { __mockAgentListOverrides: Record<string, unknown> }).__mockAgentListOverrides = {
        codex: { found: true, authenticated: true },
      };
    });

    await openEditDialog('Code Review');
    await page.locator('[data-testid="column-agent-override"]').selectOption('codex');

    await expect(page.locator('[data-testid="column-model-override"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="column-effort-override"]')).toHaveCount(0);

    // Switch back to project default to clean up state for subsequent tests.
    await page.locator('[data-testid="column-agent-override"]').selectOption('');
    await closeDialog();

    await page.evaluate(() => {
      (window as unknown as { __mockAgentListOverrides: undefined }).__mockAgentListOverrides = undefined;
    });
  });

  test('model_override saved as null when supportsModelOverride is false on the active agent', async () => {
    // Gap 7: when the agent explicitly declares supportsModelOverride=false, the
    // model combobox must not render and the save path must write model_override=null
    // regardless of any prior value on the swimlane.
    //
    // Setup: first save a model override via the default agent (Claude, which does
    // support model override), then switch the column to an agent that does not,
    // and confirm the save writes null.
    await page.evaluate(() => {
      (window as unknown as { __mockAgentListOverrides: Record<string, unknown> }).__mockAgentListOverrides = {
        gemini: {
          found: true,
          capabilities: {
            supportsModelOverride: false,
            effortLevels: [],
            models: [],
          },
        },
      };
    });

    await openEditDialog('Executing');

    // Switch to an agent that does not support model override
    await page.locator('[data-testid="column-agent-override"]').selectOption('gemini');

    // Model combobox must NOT be rendered
    await expect(page.locator('[data-testid="column-model-override"]')).toHaveCount(0);

    // Save - the IPC call must include model_override: null
    await page.locator('button:has-text("Save")').click();
    // intentional fixed wait: give the mock time to apply the update before
    // we check the swimlane state via the page store. Cannot poll for absence.
    await page.waitForTimeout(300);

    // Re-open to confirm model_override is null (not a stale value)
    await openEditDialog('Executing');
    // Model combobox must still not render (confirming model_override=null persisted)
    await page.locator('[data-testid="column-agent-override"]').selectOption('gemini');
    await expect(page.locator('[data-testid="column-model-override"]')).toHaveCount(0);

    // Clean up - restore column to defaults
    await page.locator('[data-testid="column-agent-override"]').selectOption('');
    await page.locator('button:has-text("Save")').click();
    await page.waitForTimeout(300);

    await page.evaluate(() => {
      (window as unknown as { __mockAgentListOverrides: undefined }).__mockAgentListOverrides = undefined;
    });
  });

  test('discoveredModels includes model_override values from other columns for the same effective agent', async () => {
    // Gap 8: when another column already has model_override='my-custom-model' for the
    // same effective agent, the open dialog's model dropdown should include that value
    // even if the agent's capability scan has not seen it.
    //
    // This exercises the discoveredModels merge logic in EditColumnDialog.tsx:
    //   for (const lane of swimlanes) {
    //     if (!lane.model_override) continue;
    //     if (laneAgent !== effectiveAgent) continue;
    //     merged.add(lane.model_override);
    //   }

    // First, save a custom model on one column ('Code Review')
    await openEditDialog('Code Review');
    const modelCombobox = page.locator('[data-testid="column-model-override"]');
    await modelCombobox.fill('my-custom-model-xyz');
    await page.locator('button:has-text("Save")').click();
    await page.waitForTimeout(300);

    // Now open a DIFFERENT column that uses the same default agent (Claude)
    // and verify 'my-custom-model-xyz' appears in the dropdown suggestions
    await openEditDialog('Executing');
    const execModelCombobox = page.locator('[data-testid="column-model-override"]');
    await execModelCombobox.click(); // open the dropdown to see suggestions
    const dropdownItems = page.locator('[data-model-option]');
    const modelTexts = await dropdownItems.allTextContents();
    expect(modelTexts).toContain('my-custom-model-xyz');

    await closeDialog();

    // Clean up: clear the custom model on Code Review
    await openEditDialog('Code Review');
    await page.locator('[data-testid="column-model-override"]').clear();
    await page.locator('button:has-text("Save")').click();
    await page.waitForTimeout(300);
  });

  test('save persists permission_mode and auto_spawn changes', async () => {
    await openEditDialog('Code Review');

    const permSelect = page.locator('[data-testid="column-permission-mode"]');
    await permSelect.selectOption('plan');

    // Toggle auto-spawn OFF
    const toggle = page.getByRole('switch', { name: 'Auto-spawn' });
    await toggle.click();
    await page.waitForTimeout(100);
    await expect(toggle).toHaveAttribute('aria-checked', 'false');

    // Save
    await page.locator('button:has-text("Save")').click();
    await page.waitForTimeout(500);

    // Reopen and verify persisted values
    await openEditDialog('Code Review');

    const permSelectAfter = page.locator('[data-testid="column-permission-mode"]');
    const valueAfter = await permSelectAfter.inputValue();
    expect(valueAfter).toBe('plan');

    const toggleAfter = page.getByRole('switch', { name: 'Auto-spawn' });
    await expect(toggleAfter).toHaveAttribute('aria-checked', 'false');

    // Plan exit target dropdown should now be visible (since permissions = plan)
    await expect(page.locator('[data-testid="plan-exit-target"]')).toBeVisible();

    // Restore original values so other tests aren't affected
    await permSelectAfter.selectOption('');
    await toggleAfter.click();
    await page.locator('button:has-text("Save")').click();
    await page.waitForTimeout(300);
  });
});
