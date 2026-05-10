/**
 * Unit tests for fetchIfStale.
 *
 * Covers the four code paths:
 *   1. Cached: skip spawn, return origin/branch
 *   2. Success: spawn resolves, populate cache, return origin/branch
 *   3. Timeout: spawn-with-timeout throws timeout error, log warning, fall back to local
 *   4. Abort: external AbortSignal aborts, fall back to local (no warning)
 *
 * Plus: cache integrity (timeout/abort must NOT poison the cache).
 *
 * runGitWithTimeout is mocked at the module boundary so we exercise
 * fetchIfStale's own logic without spawning real subprocesses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRunGitWithTimeout, mockIsGitTimeoutError } = vi.hoisted(() => ({
  mockRunGitWithTimeout: vi.fn(),
  mockIsGitTimeoutError: vi.fn((error: unknown): boolean => {
    return error instanceof Error && error.message.includes('aborted (timeout after');
  }),
}));

vi.mock('../../src/main/git/git-spawn', () => ({
  runGitWithTimeout: mockRunGitWithTimeout,
  isGitTimeoutError: mockIsGitTimeoutError,
}));

import { fetchIfStale, clearFetchCache } from '../../src/main/git/fetch-throttle';
import type { SimpleGit } from 'simple-git';

const PROJECT_PATH = '/mock/project';
const BRANCH = 'main';
const stubGit = {} as SimpleGit;

describe('fetchIfStale', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    clearFetchCache();
    mockRunGitWithTimeout.mockReset();
    // mockClear preserves implementation; mockReset would wipe the
    // hoisted-factory implementation that classifies timeout errors.
    mockIsGitTimeoutError.mockClear();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('returns origin/<branch> and populates cache on success', async () => {
    mockRunGitWithTimeout.mockResolvedValueOnce({ stdout: '', stderr: '' });

    const result = await fetchIfStale(stubGit, PROJECT_PATH, BRANCH);

    expect(result).toBe(`origin/${BRANCH}`);
    expect(mockRunGitWithTimeout).toHaveBeenCalledTimes(1);
    expect(mockRunGitWithTimeout).toHaveBeenCalledWith(
      PROJECT_PATH,
      ['fetch', 'origin', BRANCH],
      expect.objectContaining({ timeoutMs: 15_000 }),
    );
  });

  it('skips spawn on a second call within the throttle window', async () => {
    mockRunGitWithTimeout.mockResolvedValueOnce({ stdout: '', stderr: '' });
    await fetchIfStale(stubGit, PROJECT_PATH, BRANCH);
    expect(mockRunGitWithTimeout).toHaveBeenCalledTimes(1);

    mockRunGitWithTimeout.mockClear();
    const result = await fetchIfStale(stubGit, PROJECT_PATH, BRANCH);

    expect(result).toBe(`origin/${BRANCH}`);
    expect(mockRunGitWithTimeout).not.toHaveBeenCalled();
  });

  it('falls back to local branch and logs warning on timeout', async () => {
    const timeoutError = new Error('git fetch origin main aborted (timeout after 15000ms) (child process killed)');
    mockRunGitWithTimeout.mockRejectedValueOnce(timeoutError);

    const result = await fetchIfStale(stubGit, PROJECT_PATH, BRANCH);

    expect(result).toBe(BRANCH); // local fallback, NOT origin/branch
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[FETCH] timed out'));
  });

  it('does NOT cache the timeout outcome - next call retries', async () => {
    const timeoutError = new Error('git fetch origin main aborted (timeout after 15000ms) (child process killed)');
    mockRunGitWithTimeout.mockRejectedValueOnce(timeoutError);
    await fetchIfStale(stubGit, PROJECT_PATH, BRANCH);
    expect(mockRunGitWithTimeout).toHaveBeenCalledTimes(1);

    // Next call should retry, not return from cache
    mockRunGitWithTimeout.mockResolvedValueOnce({ stdout: '', stderr: '' });
    const result = await fetchIfStale(stubGit, PROJECT_PATH, BRANCH);

    expect(result).toBe(`origin/${BRANCH}`);
    expect(mockRunGitWithTimeout).toHaveBeenCalledTimes(2);
  });

  it('falls back to local branch on external AbortSignal cancellation (no warning)', async () => {
    const abortError = new Error('git fetch origin main aborted (external abort) (child process killed)');
    mockRunGitWithTimeout.mockRejectedValueOnce(abortError);

    const controller = new AbortController();
    const result = await fetchIfStale(stubGit, PROJECT_PATH, BRANCH, { signal: controller.signal });

    expect(result).toBe(BRANCH);
    expect(warnSpy).not.toHaveBeenCalled(); // abort is not a timeout, no log noise
  });

  it('falls back to local branch on generic git error (no warning, no cache)', async () => {
    mockRunGitWithTimeout.mockRejectedValueOnce(new Error('fatal: no remote named origin'));

    const result = await fetchIfStale(stubGit, PROJECT_PATH, BRANCH);

    expect(result).toBe(BRANCH);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('forwards the AbortSignal to runGitWithTimeout', async () => {
    mockRunGitWithTimeout.mockResolvedValueOnce({ stdout: '', stderr: '' });
    const controller = new AbortController();

    await fetchIfStale(stubGit, PROJECT_PATH, BRANCH, { signal: controller.signal });

    expect(mockRunGitWithTimeout).toHaveBeenCalledWith(
      PROJECT_PATH,
      ['fetch', 'origin', BRANCH],
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
