/**
 * Playwright globalSetup: sweep stale app-under-test Electron instances leaked
 * by a previous run before this run starts, so they cannot interfere or keep
 * pinning worktree node_modules. See electron-janitor.ts for the safety
 * contract.
 */

import type { FullConfig } from '@playwright/test';
import { sweepLeakedElectronInstances } from './electron-janitor';

export default async function globalSetup(_config: FullConfig): Promise<void> {
  await sweepLeakedElectronInstances('setup');
}
