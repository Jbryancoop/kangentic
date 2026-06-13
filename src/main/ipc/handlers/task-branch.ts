import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ipcMain } from 'electron';
import { simpleGit } from 'simple-git';
import { IPC } from '../../../shared/ipc-channels';
import { SessionRepository } from '../../db/repositories/session-repository';
import { getProjectDb } from '../../db/database';
import {
  getProjectRepos,
  ensureTaskWorktree,
} from '../helpers';
import { resolveProjectContext } from '../helpers/project-repos';
import type { IpcContext } from '../ipc-context';
import type { TaskSwitchBranchInput } from '../../../shared/types';

export interface CarryResult {
  carriedTracked: boolean;
  carriedUntracked: string[];
  failedUntracked: string[];
  applyFailed: boolean;
}

/**
 * Carry uncommitted changes (tracked + untracked) from a project directory
 * to a newly-created worktree. Best-effort: never throws.
 */
export async function carryUncommittedChanges(
  projectPath: string,
  worktreePath: string,
  taskIdSlug: string,
): Promise<CarryResult> {
  const result: CarryResult = {
    carriedTracked: false,
    carriedUntracked: [],
    failedUntracked: [],
    applyFailed: false,
  };

  try {
    const mainGit = simpleGit(projectPath);
    const status = await mainGit.status();

    if (status.files.length === 0 && status.not_added.length === 0) {
      return result;
    }

    // Carry tracked changes (staged + unstaged) via diff/apply
    const diff = await mainGit.diff(['HEAD']);
    if (diff) {
      const worktreeGit = simpleGit(worktreePath);
      const patchFile = path.join(os.tmpdir(), `kangentic-patch-${taskIdSlug}.patch`);
      try {
        fs.writeFileSync(patchFile, diff);
        await worktreeGit.raw('apply', '--3way', patchFile);
        result.carriedTracked = true;
      } catch {
        result.applyFailed = true;
      } finally {
        try { fs.unlinkSync(patchFile); } catch { /* ignore cleanup failure */ }
      }
    }

    // Carry untracked files (git diff HEAD ignores these)
    const untrackedFiles = status.not_added;
    for (const filePath of untrackedFiles) {
      const source = path.join(projectPath, filePath);
      const destination = path.join(worktreePath, filePath);
      // Guard against path traversal (e.g. ../../../etc/passwd)
      const resolvedDestination = path.resolve(destination);
      if (!resolvedDestination.startsWith(path.resolve(worktreePath))) {
        result.failedUntracked.push(filePath);
        continue;
      }
      try {
        fs.mkdirSync(path.dirname(resolvedDestination), { recursive: true });
        fs.copyFileSync(source, resolvedDestination);
        result.carriedUntracked.push(filePath);
      } catch {
        result.failedUntracked.push(filePath);
      }
    }
  } catch (error) {
    console.error('[carryUncommittedChanges] Unexpected error:', error);
  }

  return result;
}

export function registerTaskBranchHandlers(context: IpcContext): void {
  ipcMain.handle(IPC.TASK_SWITCH_BRANCH, async (_, input: TaskSwitchBranchInput, projectId?: string | null) => {
    const { projectId: resolvedProjectId, projectPath: resolvedProjectPath } = resolveProjectContext(context, projectId);
    if (!resolvedProjectId) throw new Error('No project is currently open');

    const { tasks } = getProjectRepos(context, resolvedProjectId);
    const task = tasks.getById(input.taskId);
    if (!task) throw new Error(`Task ${input.taskId} not found`);

    // Guard: must not have a running PTY session
    if (task.session_id) {
      const activeSession = context.sessionManager.listSessions()
        .find(s => s.id === task.session_id && (s.status === 'running' || s.status === 'queued'));
      if (activeSession) {
        throw new Error('Cannot switch branch while a session is running. Suspend the session first.');
      }
    }

    const db = getProjectDb(resolvedProjectId);
    const sessionRepo = new SessionRepository(db);

    if (input.enableWorktree && !task.worktree_path) {
      // --- Path B: Enable worktree ---
      if (!resolvedProjectPath) throw new Error('No project path available');

      // Update base branch and use_worktree before creating the worktree
      tasks.update({
        id: task.id,
        base_branch: input.newBaseBranch || null,
        use_worktree: 1,
      });
      Object.assign(task, tasks.getById(task.id));

      // Create the worktree
      await ensureTaskWorktree(context, task, tasks, resolvedProjectPath);
      const updatedTask = tasks.getById(task.id);
      if (!updatedTask?.worktree_path) {
        throw new Error('Failed to create worktree');
      }

      // Best-effort: carry uncommitted changes from main repo to worktree
      try {
        const carryResult = await carryUncommittedChanges(
          resolvedProjectPath, updatedTask.worktree_path, task.id.slice(0, 8),
        );
        if (carryResult.carriedTracked || carryResult.carriedUntracked.length > 0) {
          console.log(`[TASK_SWITCH_BRANCH] Carried uncommitted changes to worktree (tracked: ${carryResult.carriedTracked}, untracked: ${carryResult.carriedUntracked.length})`);
        }
        if (carryResult.applyFailed) {
          console.warn(`[TASK_SWITCH_BRANCH] Could not apply tracked changes to worktree. They remain in the main repo.`);
        }
        if (carryResult.failedUntracked.length > 0) {
          console.warn(`[TASK_SWITCH_BRANCH] Could not copy ${carryResult.failedUntracked.length} untracked file(s) to worktree.`);
        }
      } catch {
        // Best-effort, non-fatal
      }

      // Update session record CWD for seamless resume
      const latestRecord = sessionRepo.getLatestForTask(task.id);
      if (latestRecord && latestRecord.status === 'suspended') {
        sessionRepo.updateCwd(latestRecord.id, updatedTask.worktree_path);
        console.log(`[TASK_SWITCH_BRANCH] Updated session ${latestRecord.id.slice(0, 8)} CWD to worktree`);
      }

      // Update git config in the new worktree (best-effort)
      if (input.newBaseBranch) {
        try {
          const worktreeGit = simpleGit(updatedTask.worktree_path);
          await worktreeGit.addConfig('kangentic.baseBranch', input.newBaseBranch);
        } catch {
          // Non-fatal
        }
      }

      return tasks.getById(task.id)!;
    }

    if (task.worktree_path) {
      // --- Path A: Switch base branch (worktree exists) ---
      if (!fs.existsSync(task.worktree_path)) {
        throw new Error(`Worktree directory not found: ${task.worktree_path}`);
      }

      tasks.update({ id: task.id, base_branch: input.newBaseBranch || null });

      // Update git config in the worktree (best-effort)
      try {
        const worktreeGit = simpleGit(task.worktree_path);
        await worktreeGit.addConfig('kangentic.baseBranch', input.newBaseBranch);
      } catch {
        console.warn(`[TASK_SWITCH_BRANCH] Could not update git config in worktree`);
      }

      return tasks.getById(task.id)!;
    }

    // --- Path C: No worktree, no enableWorktree ---
    tasks.update({ id: task.id, base_branch: input.newBaseBranch || null });
    return tasks.getById(task.id)!;
  });
}
