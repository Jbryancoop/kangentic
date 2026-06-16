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

/**
 * Whether `sha` is a merge commit (more than one parent). A merge commit is
 * never a task's own work - in particular a base-branch `Merge pull request #N`
 * tip, which a freshly-branched code-review worktree sits on - so the commit-SHA
 * PR anchor must not attribute that commit's originating PR to the task.
 *
 * `rev-list --parents -n 1 <sha>` prints the commit's SHA followed by its parent
 * SHAs on one line, so more than two tokens means two or more parents. The merge
 * commit survives in the object store after the worktree is reclaimed, so this
 * works from the main repo too. Best-effort: returns false on any git error so
 * resolution still proceeds.
 */
export async function isMergeCommit(repoCwd: string, sha: string): Promise<boolean> {
  try {
    const git = simpleGit(repoCwd);
    const line = (await git.raw(['rev-list', '--parents', '-n', '1', sha])).trim();
    return line.split(/\s+/).length > 2;
  } catch {
    return false;
  }
}
