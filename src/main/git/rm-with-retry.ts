import fs from './original-fs';

/**
 * Recursive directory removal with two-layer retry for Windows transients.
 *
 * Uses `original-fs` so the walk doesn't trigger Electron's asar
 * interception (see `original-fs.ts`).
 *
 * Two layers of retry, sized to outlast the documented 1500ms ConPTY
 * handle-release grace window plus AV / search-indexer / thumbnailer scans:
 *
 *   Inner (Node built-in, per-file): { maxRetries: 10, retryDelay: 200 }
 *     Node retries individual unlink/rmdir calls on EBUSY/ENOTEMPTY/EPERM/
 *     EMFILE/ENFILE. ~2s budget per locked path, fine-grained.
 *
 *   Outer (this loop, per-tree): [0, 200, 500, 1000, 2000] ms between
 *     attempts. Backstop for failures that escape the inner retry (e.g.
 *     re-locks during the tree walk). ~3.7s additional wall-clock budget.
 *
 * `force: true` silences ENOENT so a partially-removed tree on the previous
 * attempt does not fail the next.
 */

const RETRY_DELAYS_MS = [0, 200, 500, 1000, 2000] as const;
const INNER_MAX_RETRIES = 10;
const INNER_RETRY_DELAY_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function removeWithRetry(targetPath: string): Promise<void> {
  let lastError: unknown;
  for (const delay of RETRY_DELAYS_MS) {
    if (delay > 0) await sleep(delay);
    try {
      await fs.promises.rm(targetPath, {
        recursive: true,
        force: true,
        maxRetries: INNER_MAX_RETRIES,
        retryDelay: INNER_RETRY_DELAY_MS,
      });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error(`removeWithRetry exhausted retries for ${targetPath}`);
}
