import { simpleGit } from 'simple-git';

/**
 * Read the worktree's live HEAD: the actual branch (preferred over the stored
 * slug, which agents rename) and the tip commit SHA (an immutable anchor we
 * persist so resolution survives worktree deletion and renames).
 *
 * `branch` is null on a detached HEAD or any git error; `sha` is null only on
 * a git error. Best-effort: callers treat null as "keep what we already have".
 */
export async function readWorktreeHead(worktreePath: string): Promise<{ branch: string | null; sha: string | null }> {
  try {
    const git = simpleGit(worktreePath);
    const branchRaw = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    const sha = (await git.revparse(['HEAD'])).trim();
    return {
      branch: branchRaw && branchRaw !== 'HEAD' ? branchRaw : null,
      sha: sha || null,
    };
  } catch {
    // Worktree gone or git error.
    return { branch: null, sha: null };
  }
}
