import { simpleGit } from 'simple-git';
import type { SessionRepository } from '../../db/repositories/session-repository';
import type { UsageHistoryRepository } from '../../db/repositories/usage-history-repository';
import type { Task } from '../../../shared/types';

/**
 * Capture git diff stats (lines added/removed, files changed) by comparing
 * the task's branch against its base branch and write them to BOTH the
 * `sessions` row and the `usage_history` row for the same `recordId`.
 *
 * The history mirror call is a silent no-op if no history row exists for the
 * record (e.g. the session was captured with no usage at all and skipped the
 * history entirely).
 *
 * Best-effort: returns early if there is no git directory; callers wrap this
 * in try/catch so a git error never breaks the surrounding task-move flow.
 */
export async function captureGitStats(
  task: Task,
  sessionRepo: SessionRepository,
  usageHistoryRepo: UsageHistoryRepository,
  recordId: string,
  projectPath: string | null | undefined,
  defaultBaseBranch?: string,
): Promise<void> {
  const gitDir = task.worktree_path ?? projectPath;
  if (!gitDir) return;

  const baseBranch = task.base_branch || defaultBaseBranch || 'main';
  const git = simpleGit(gitDir);

  // Compare all changes (committed + uncommitted) against the merge-base.
  // Three-dot syntax `main...` means `git diff $(git merge-base main HEAD)`,
  // which shows only changes introduced on the task branch, excluding any
  // new commits on the base branch since the fork point.
  const diffResult = await git.diffSummary([baseBranch + '...']);

  const stats = {
    linesAdded: diffResult.insertions,
    linesRemoved: diffResult.deletions,
    filesChanged: diffResult.changed,
  };
  sessionRepo.updateGitStats(recordId, stats);
  // Mirror to the history so productivity stats survive task deletion.
  usageHistoryRepo.updateGitStats(recordId, stats);
}
