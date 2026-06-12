import { ipcMain } from 'electron';
import simpleGit from 'simple-git';
import { IPC } from '../../../shared/ipc-channels';
import { DiffService } from '../../git/diff-service';
import { readWorktreeHead } from '../../git/worktree-head';
import { fetchAllRemotesIfStale } from '../../git/fetch-throttle';
import type { GitDiffFilesInput, GitFileContentInput, GitPendingChangesInput, GitPendingChangesResult } from '../../../shared/types';
import type { IpcContext } from '../ipc-context';

/**
 * Probe a worktree (or project) directory for work that the Done move would
 * destroy: uncommitted files (lost when the worktree is removed) and commits
 * that exist on no remote. Also reports the live HEAD branch so the dialog can
 * name the branch the work actually lives on rather than a stale stored slug.
 *
 * The unpushed count is gated on the repo having at least one remote: with no
 * remotes, `rev-list --not --remotes` matches nothing and would count the
 * entire history, scaring the user with a number that is not unpushed work.
 * When a remote exists we first refresh remote-tracking refs
 * (fetchAllRemotesIfStale) so the count reflects current remote state rather
 * than stale local refs, which previously made already-pushed commits look
 * local-only.
 *
 * On any git failure it returns a safe default (`hasPendingChanges: true`) so
 * a corrupted or missing worktree still routes through the confirm dialog.
 */
export async function probePendingChanges(checkPath: string): Promise<GitPendingChangesResult> {
  try {
    const git = simpleGit(checkPath);
    const status = await git.status();

    const uncommittedFileCount = status.files.length;
    const { branch: currentBranch } = await readWorktreeHead(checkPath);

    let unpushedCommitCount = 0;
    const remotes = await git.getRemotes();
    if (remotes.length > 0) {
      // Refresh remote-tracking refs first: stale local refs make rev-list
      // report already-pushed commits as local-only. Never rejects; on failure
      // the count falls back to existing (possibly stale) refs, the pre-fix
      // behavior. Kept outside the inner try so a hypothetical throw lands in
      // the outer catch (safe default) rather than yielding a false 0 count.
      await fetchAllRemotesIfStale(checkPath);
      try {
        const countOutput = (await git.raw(['rev-list', 'HEAD', '--not', '--remotes', '--count'])).trim();
        unpushedCommitCount = parseInt(countOutput, 10) || 0;
      } catch {
        // Detached HEAD or unborn branch - treat as 0 unpushed.
      }
    }

    const hasPendingChanges = uncommittedFileCount > 0 || unpushedCommitCount > 0;
    return { hasPendingChanges, uncommittedFileCount, unpushedCommitCount, currentBranch };
  } catch {
    // If git fails (missing directory, corrupted repo, etc.), assume changes exist as safe default
    return { hasPendingChanges: true, uncommittedFileCount: 0, unpushedCommitCount: 0, currentBranch: null };
  }
}

export function registerGitDiffHandlers(context: IpcContext): void {
  // DiffWatcher lives on the context (not module-local) so project relocation
  // can release the worktree fs.watch handles inside a folder before moving it.
  const watcher = context.diffWatcher;

  // Cache DiffService instances per directory so the merge-base cache persists
  // across getDiffFiles and getFileContent calls, avoiding redundant git
  // merge-base subprocess spawns on every file click. These hold no file
  // handles (git is spawned per call), so stale post-relocation entries keyed
  // by the old path are harmless and left in place.
  const serviceCache = new Map<string, DiffService>();

  function getOrCreateService(gitDirectory: string): DiffService {
    const existing = serviceCache.get(gitDirectory);
    if (existing) return existing;
    const service = new DiffService(gitDirectory);
    serviceCache.set(gitDirectory, service);
    return service;
  }

  ipcMain.handle(IPC.GIT_DIFF_FILES, async (_, input: GitDiffFilesInput) => {
    const service = getOrCreateService(input.worktreePath ?? input.projectPath);
    return service.getDiffFiles(input);
  });

  ipcMain.handle(IPC.GIT_FILE_CONTENT, async (_, input: GitFileContentInput) => {
    const service = getOrCreateService(input.worktreePath ?? input.projectPath);
    return service.getFileContent(input);
  });

  ipcMain.on(IPC.GIT_DIFF_SUBSCRIBE, (_, worktreePath: string) => {
    watcher.subscribe(worktreePath, () => {
      if (!context.mainWindow.isDestroyed()) {
        context.mainWindow.webContents.send(IPC.GIT_DIFF_CHANGED);
      }
    });
  });

  ipcMain.handle(IPC.GIT_CHECK_PENDING_CHANGES, (_, input: GitPendingChangesInput): Promise<GitPendingChangesResult> => {
    return probePendingChanges(input.checkPath);
  });

  ipcMain.on(IPC.GIT_DIFF_UNSUBSCRIBE, (_, worktreePath: string) => {
    watcher.unsubscribe(worktreePath);
    serviceCache.delete(worktreePath);
  });
}
