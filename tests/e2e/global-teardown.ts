/**
 * Playwright globalTeardown: sweep app-under-test Electron instances this run
 * leaked. Worker crashes bypass per-fixture teardown, so this run-level hook is
 * the only reliable owner of leaks created during the run. See
 * electron-janitor.ts for the safety contract.
 */

import type { FullConfig } from '@playwright/test';
import { sweepLeakedElectronInstances } from './electron-janitor';

export default async function globalTeardown(_config: FullConfig): Promise<void> {
  await sweepLeakedElectronInstances('teardown');
}
