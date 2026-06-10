import path from 'node:path';
import fs from '../../git/original-fs';
import { withTaskLock } from '../task-lifecycle-lock';
import { TaskRepository } from '../../db/repositories/task-repository';
import { SessionRepository } from '../../db/repositories/session-repository';
import { WorktreeManager } from '../../git/worktree-manager';
import { isGitRepo } from '../../git/git-checks';
import { runGitWithTimeout } from '../../git/git-spawn';
import { getProjectDb } from '../../db/database';
import { isLiveSession } from '../../pty/session-registry';
import { applySuspendDbWrites } from './session-reconcile';
import { abortInFlightResume } from './session-resume-controllers';
import { trackEvent } from '../../analytics/analytics';
import { agentRegistry } from '../../agent/agent-registry';
import { replacePathPrefix } from '../../../shared/paths';
import type { Project } from '../../../shared/types';
import type { IpcContext } from '../ipc-context';

/**
 * Platform-correct path equality via `path.relative` (case-insensitive on
 * Windows, where strict string comparison of resolved paths is not).
 */
function isSamePath(first: string, second: string): boolean {
  return path.relative(first, second) === '';
}

/**
 * Re-point an existing project at a new folder on disk (the folder was moved
 * or renamed outside Kangentic). Tasks, board, and history live in the
 * per-project DB keyed by project id, so only stored absolute paths need
 * rewriting:
 *
 * 1. Validate the new location (exists, is a directory, not already
 *    registered to another project).
 * 2. Suspend the project's live sessions so they resume at the new cwd.
 * 3. Update `projects.path` plus stored `tasks.worktree_path` and
 *    `sessions.cwd` prefixes.
 * 4. Best-effort `git worktree repair` (a moved repo's worktree metadata
 *    holds stale absolute paths).
 * 5. Notify each agent adapter so it can migrate per-project data it keeps
 *    OUTSIDE the project folder keyed by absolute path (e.g. Claude's
 *    ~/.claude/projects transcripts and ~/.claude.json keys).
 * 6. Reset per-path runtime state so the next open re-derives everything.
 *
 * The renderer re-opens the project afterwards (when it was the current one),
 * which re-attaches the board config watcher, rewrites the MCP config, and
 * re-runs session recovery via the normal PROJECT_OPEN flow.
 */
export async function relocateProject(context: IpcContext, projectId: string, newPath: string): Promise<Project> {
  const project = context.projectRepo.getById(projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);

  const resolved = path.resolve(newPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`New project location is not a directory: ${resolved}`);
  }
  // Capture before updatePath: worktree queues are keyed by the stored
  // path string, and `project` may alias a row object a repo mock mutates.
  const storedOldPath = project.path;
  const oldPath = path.resolve(storedOldPath);
  if (isSamePath(oldPath, resolved)) return project;

  const duplicate = context.projectRepo.list()
    .find((candidate) => candidate.id !== projectId && isSamePath(path.resolve(candidate.path), resolved));
  if (duplicate) {
    throw new Error(`Another project ("${duplicate.name}") already points at ${resolved}`);
  }

  // Suspend live sessions so they resume at the new cwd after reopen.
  // Mirrors SESSION_SUSPEND: abort any in-flight resume BEFORE acquiring the
  // task lock (aborting inside would deadlock on a holder stuck in unlocked
  // git I/O), then do the DB writes + PTY shutdown under the lock.
  const liveSessions = context.sessionManager.listSessions()
    .filter((session) => session.projectId === projectId && isLiveSession(session));
  for (const session of liveSessions) {
    if (session.transient || !session.taskId) {
      // Transient command terminals have no task or DB record; kill outright.
      try {
        await context.sessionManager.kill(session.id);
      } catch (err) {
        console.warn(`[PROJECT_RELOCATE] Failed to kill transient session ${session.id.slice(0, 8)}:`, err);
      }
      continue;
    }
    abortInFlightResume(session.taskId);
    await withTaskLock(session.taskId, async () => {
      applySuspendDbWrites(context, projectId, session.taskId, 'system');
      await context.sessionManager.suspend(session.id);
    });
  }

  const updated = context.projectRepo.updatePath(projectId, resolved);

  // Rewrite stored absolute paths in the per-project DB. Worktrees and
  // session cwds live under <project>/.kangentic/, so they moved with the
  // folder; paths outside the old prefix are left untouched.
  const db = getProjectDb(projectId);
  const taskRepo = new TaskRepository(db);
  const sessionRepo = new SessionRepository(db);
  const rewrittenWorktreePaths: string[] = [];
  for (const task of [...taskRepo.list(), ...taskRepo.listArchived()]) {
    if (!task.worktree_path) continue;
    const rewritten = replacePathPrefix(task.worktree_path, oldPath, resolved);
    if (!rewritten) continue;
    taskRepo.update({ id: task.id, worktree_path: rewritten });
    rewrittenWorktreePaths.push(rewritten);
  }
  for (const record of sessionRepo.listAll()) {
    if (!record.cwd) continue;
    const rewritten = replacePathPrefix(record.cwd, oldPath, resolved);
    if (rewritten) sessionRepo.updateCwd(record.id, rewritten);
  }

  // A moved repo's worktree metadata (.git files and .git/worktrees/*/gitdir)
  // still holds the old absolute paths. `git worktree repair <paths>` fixes
  // both sides when repo and worktrees moved together. Best-effort: a non-git
  // folder is a valid project, and a repair failure only degrades worktrees.
  if (isGitRepo(resolved)) {
    const existingWorktreePaths = rewrittenWorktreePaths.filter((worktreePath) => fs.existsSync(worktreePath));
    try {
      await runGitWithTimeout(resolved, ['worktree', 'repair', ...existingWorktreePaths], { timeoutMs: 30_000 });
    } catch (err) {
      console.warn('[PROJECT_RELOCATE] git worktree repair failed (non-fatal):', err);
    }
  }

  // Give each agent adapter a chance to migrate per-project data it keeps
  // outside the project folder (e.g. Claude's ~/.claude/projects transcripts
  // and ~/.claude.json keys). Best-effort: a failure must not fail relocation.
  // The project folder is already at `resolved`, so an adapter can list its
  // worktrees to reconstruct old paths.
  for (const adapterName of agentRegistry.list()) {
    const adapter = agentRegistry.get(adapterName);
    if (!adapter?.onProjectRelocated) continue;
    try {
      await adapter.onProjectRelocated(oldPath, resolved);
    } catch (err) {
      console.warn(`[PROJECT_RELOCATE] ${adapterName} onProjectRelocated failed (non-fatal):`, err);
    }
  }

  // Reset per-path runtime state. Dropping the project from recoveredProjects
  // makes the next open run full recovery, which resumes the sessions
  // suspended above at their rewritten cwds.
  WorktreeManager.clearQueue(storedOldPath);
  context.recoveredProjects.delete(projectId);
  if (context.currentProjectId === projectId) {
    context.currentProjectPath = resolved;
    // The file watcher is bound to the old path; PROJECT_OPEN re-attaches it.
    context.boardConfigManager.detach();
  }

  trackEvent('project_relocate');
  console.log(`[PROJECT_RELOCATE] ${project.name}: ${storedOldPath} -> ${resolved}`);
  return updated;
}
