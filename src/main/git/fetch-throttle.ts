import path from 'node:path';
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
 * handler, task-git helper, and the pending-changes probe
 * (fetchAllRemotesIfStale).
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

/**
 * Sentinel cache "branch" for whole-repo (`fetch --all`) refreshes. Git ref
 * names cannot contain `*`, so this never collides with a real branch key
 * written by fetchIfStale.
 */
const ALL_REMOTES_SENTINEL = '*all-remotes*';

/**
 * Tighter ceiling than FETCH_TIMEOUT_MS: the all-remotes fetch gates the
 * Done-drop pending-changes dialog while the user is mid-interaction, so it
 * cannot afford the full 15s hang budget. Healthy fetches finish under 1s; the
 * completion gate tolerates a slow probe (see
 * .claude/rules/board-completing-task-chokepoint.md), so the worst case is the
 * dialog appearing ~5s after the drop.
 */
const PROBE_FETCH_TIMEOUT_MS = 5_000;

/**
 * In-flight all-remotes fetches keyed by repo identity. Batch Done moves probe
 * each task's worktree concurrently; sharing one fetch promise avoids parallel
 * `git fetch` processes contending on the shared repo's ref locks.
 */
const inFlightAllRemoteFetches = new Map<string, Promise<void>>();

/** Clear the fetch throttle cache (for testing). */
export function clearFetchCache(): void {
  fetchCache.clear();
  inFlightAllRemoteFetches.clear();
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

/**
 * Refresh ALL remote-tracking refs for the repo that owns `checkPath` so a
 * subsequent `git rev-list --not --remotes` compares against current remote
 * state rather than stale local refs. Used by the Done-move pending-changes
 * probe, where a stale ref made already-pushed commits look local-only and
 * falsely warned the user about losing work.
 *
 * `--all` (every remote, not just origin) matches `rev-list --not --remotes`,
 * and the observed false positive came from a commit reachable via a different
 * remote branch than the task's. `--prune` drops tracking refs for deleted
 * remote branches; without it a stale ref could mask genuinely unpushed
 * commits (a false negative, which risks silent loss and is worse than the
 * false positive this fixes).
 *
 * Throttled (FETCH_THROTTLE_MS) and deduped by repo identity so batch Done
 * moves of many worktrees pay for one fetch, not one per worktree. Identity is
 * the git common dir (shared across a repo's worktrees), falling back to
 * `checkPath` if it cannot be resolved.
 *
 * Failure semantics: this never rejects. Any failure (no remote, offline,
 * timeout, ref-lock contention) is swallowed so the probe falls back to the
 * existing local refs - the behavior before this refresh existed.
 */
export async function fetchAllRemotesIfStale(checkPath: string): Promise<void> {
  let repoIdentityPath = checkPath;
  try {
    const commonDirOutput = (
      await runGitWithTimeout(checkPath, ['rev-parse', '--git-common-dir'], {
        timeoutMs: PROBE_FETCH_TIMEOUT_MS,
      })
    ).stdout.trim();
    if (commonDirOutput) {
      // `--git-common-dir` can be relative (e.g. ".git"); resolve against the
      // probed path so worktrees of the same repo share one identity.
      repoIdentityPath = path.resolve(checkPath, commonDirOutput);
    }
  } catch {
    // Fall back to checkPath: the throttle degrades to per-worktree, still correct.
  }

  const cacheKey = fetchCacheKey(repoIdentityPath, ALL_REMOTES_SENTINEL);
  const lastFetch = fetchCache.get(cacheKey);
  if (lastFetch && Date.now() - lastFetch < FETCH_THROTTLE_MS) {
    return;
  }

  const inFlight = inFlightAllRemoteFetches.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const fetchPromise = (async () => {
    try {
      await runGitWithTimeout(checkPath, ['fetch', '--all', '--prune', '--quiet'], {
        timeoutMs: PROBE_FETCH_TIMEOUT_MS,
      });
      fetchCache.set(cacheKey, Date.now());
    } catch (error) {
      if (isGitTimeoutError(error)) {
        console.warn(`[FETCH] all-remotes refresh timed out after ${PROBE_FETCH_TIMEOUT_MS / 1000}s; using existing refs`);
      }
      // Swallow every failure: the probe falls back to existing local refs.
      // Cache intentionally NOT updated so the next probe retries.
    } finally {
      inFlightAllRemoteFetches.delete(cacheKey);
    }
  })();

  inFlightAllRemoteFetches.set(cacheKey, fetchPromise);
  return fetchPromise;
}
