import type { SimpleGit } from 'simple-git';
import { runGitWithTimeout, isGitTimeoutError } from './git-spawn';

/**
 * Fetch throttle cache - avoids redundant `git fetch` calls for the
 * same project+branch within a short window. In-memory only, resets
 * on app restart.
 *
 * Covers batch moves (5+ tasks dragged in quick succession) without
 * significant staleness risk for spaced-out individual moves.
 *
 * Consumers: WorktreeManager.createWorktree, transient-sessions IPC
 * handler, task-git helper.
 */

const fetchCache = new Map<string, number>();

/** Skip fetch if the same project+branch was fetched within this window. */
const FETCH_THROTTLE_MS = 30 * 1000; // 30 seconds

/**
 * Wall-clock ceiling for the underlying `git fetch`. Real fetches against
 * GitHub/Azure DevOps complete in <1s on a healthy network. The 15s ceiling
 * exists to bound the failure mode where Electron-spawned fetches hang
 * forever waiting on a stale OpenSSH ControlMaster socket, an unreachable
 * proxy, or an invisible credential dialog. On timeout we fall back to the
 * local branch - the same fallback already used for every other failure
 * mode (no remote, branch missing, network error).
 */
const FETCH_TIMEOUT_MS = 15_000;

/** Clear the fetch throttle cache (for testing). */
export function clearFetchCache(): void {
  fetchCache.clear();
}

function fetchCacheKey(projectPath: string, branch: string): string {
  const normalizedPath = process.platform === 'win32' ? projectPath.toLowerCase() : projectPath;
  return `${normalizedPath}:${branch}`;
}

/**
 * Fetch from origin if the branch hasn't been fetched recently.
 * Returns the start point to use (`origin/<branch>` or local `<branch>`).
 *
 * Failure semantics: ANY failure (no remote, branch missing, network down,
 * timeout, abort) falls back to the local branch. The cache is only
 * populated on success, so a transient timeout never poisons subsequent
 * calls.
 *
 * The `_git: SimpleGit` parameter is retained on the signature for
 * back-compat with existing callers but is unused (prefixed `_` so
 * eslint accepts it). The timeout path requires `child_process.spawn`
 * directly so we can attach an `AbortSignal` (simple-git's `.raw()`
 * exposes no abort primitive).
 */
export async function fetchIfStale(
  _git: SimpleGit,
  projectPath: string,
  branch: string,
  options?: { signal?: AbortSignal },
): Promise<string> {
  const key = fetchCacheKey(projectPath, branch);
  const lastFetch = fetchCache.get(key);
  if (lastFetch && Date.now() - lastFetch < FETCH_THROTTLE_MS) {
    return `origin/${branch}`;
  }

  try {
    await runGitWithTimeout(projectPath, ['fetch', 'origin', branch], {
      timeoutMs: FETCH_TIMEOUT_MS,
      signal: options?.signal,
    });
    fetchCache.set(key, Date.now());
    return `origin/${branch}`;
  } catch (error) {
    if (isGitTimeoutError(error)) {
      console.warn(`[FETCH] timed out after ${FETCH_TIMEOUT_MS / 1000}s, falling back to local branch ${branch}`);
    }
    // No remote, branch not on remote, network unavailable, timeout, or
    // abort: use local branch. Cache intentionally NOT updated so the
    // next call retries.
    return branch;
  }
}
