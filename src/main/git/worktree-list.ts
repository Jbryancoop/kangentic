import * as fs from 'node:fs';
import simpleGit from 'simple-git';
import { ProjectRepository } from '../db/repositories/project-repository';
import type { ProjectWorktrees, WorktreeRecord } from '../../shared/types';

/**
 * Enumerate worktrees across one project or every registered project.
 * Each worktree record carries its branch, dirty state, and commit
 * delta vs. its tracked upstream - enough for an agent to find a task's
 * branch, locate dirty work, or reason about merge state.
 *
 * Pure read-only. Uses `simple-git` (already a project dep, used by
 * `WorktreeManager` and `DiffService`). Each worktree spawns a couple of
 * git invocations; for a project with many worktrees the calls run in
 * parallel via `Promise.all`.
 *
 * Failure modes: if a project's path no longer exists on disk, that project
 * appears with an empty `worktrees` array. Individual worktrees that fail
 * to resolve (e.g. mid-rebase, broken HEAD) get a record with as much info
 * as we can salvage and `branch` / `dirty` set to `null` / `false`.
 */

interface ParsedWorktree {
  path: string;
  head: string | null;
  branch: string | null;
  isMainCheckout: boolean;
}

export interface EnumerateWorktreesOptions {
  /** Limit to a single project. When omitted, enumerates every registered project. */
  projectId?: string;
}

export async function enumerateWorktrees(
  options: EnumerateWorktreesOptions = {},
): Promise<ProjectWorktrees[]> {
  const repository = new ProjectRepository();
  const projects = options.projectId
    ? [repository.getById(options.projectId)].filter((p) => p !== undefined)
    : repository.list();

  const results: ProjectWorktrees[] = [];
  for (const project of projects) {
    if (!project) continue;
    if (!fs.existsSync(project.path)) {
      results.push({
        projectId: project.id,
        projectName: project.name,
        projectPath: project.path,
        worktrees: [],
      });
      continue;
    }

    const parsed = await parseWorktreeList(project.path);
    const records = await Promise.all(
      parsed.map(async (entry) => buildRecord(entry, project.path)),
    );
    results.push({
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      worktrees: records,
    });
  }
  return results;
}

async function parseWorktreeList(projectPath: string): Promise<ParsedWorktree[]> {
  let raw: string;
  try {
    raw = await simpleGit(projectPath).raw(['worktree', 'list', '--porcelain']);
  } catch {
    return [];
  }
  // Porcelain output is paragraphs separated by blank lines, each starting
  // with `worktree <path>` and followed by `HEAD <sha>`, `branch <ref>`,
  // and optional `bare` / `detached` markers.
  const blocks = raw.split(/\r?\n\r?\n/).map((block) => block.trim()).filter(Boolean);
  const parsed: ParsedWorktree[] = [];
  for (const block of blocks) {
    let path: string | null = null;
    let head: string | null = null;
    let branch: string | null = null;
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) {
        path = line.slice('worktree '.length);
      } else if (line.startsWith('HEAD ')) {
        head = line.slice('HEAD '.length);
      } else if (line.startsWith('branch ')) {
        // `refs/heads/<name>` -> `<name>`
        branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
      }
    }
    if (path) {
      parsed.push({
        path,
        head,
        branch,
        isMainCheckout: path === projectPath,
      });
    }
  }
  return parsed;
}

async function buildRecord(entry: ParsedWorktree, _projectPath: string): Promise<WorktreeRecord> {
  const baseRecord: WorktreeRecord = {
    path: entry.path,
    branch: entry.branch,
    baseRef: null,
    dirty: false,
    commitsAhead: null,
    commitsBehind: null,
    lastCommitTs: null,
    isMainCheckout: entry.isMainCheckout,
  };

  // Worktree may have been removed externally between `worktree list` and now.
  if (!fs.existsSync(entry.path)) {
    return baseRecord;
  }

  const worktreeGit = simpleGit(entry.path);

  // Dirty status. `simple-git`'s status() throws when invoked on a
  // half-broken worktree (mid-rebase, missing HEAD); we treat those as
  // "unknown" rather than fail.
  let dirty = false;
  try {
    const status = await worktreeGit.status();
    dirty = !status.isClean();
  } catch {
    dirty = false;
  }

  // Last commit timestamp on the current branch.
  let lastCommitTs: string | null = null;
  try {
    const isoTimestamp = (await worktreeGit.raw(['log', '-1', '--format=%cI'])).trim();
    lastCommitTs = isoTimestamp || null;
  } catch {
    lastCommitTs = null;
  }

  // Commits ahead/behind the upstream tracking branch. `git rev-list
  // --left-right --count <upstream>...HEAD` returns `<behind>\t<ahead>`.
  let commitsAhead: number | null = null;
  let commitsBehind: number | null = null;
  try {
    const upstream = (
      await worktreeGit.raw(['rev-parse', '--abbrev-ref', '@{upstream}'])
    ).trim();
    if (upstream) {
      const counts = (
        await worktreeGit.raw(['rev-list', '--left-right', '--count', `${upstream}...HEAD`])
      ).trim();
      const [behindStr, aheadStr] = counts.split(/\s+/);
      const behind = Number.parseInt(behindStr ?? '', 10);
      const ahead = Number.parseInt(aheadStr ?? '', 10);
      commitsBehind = Number.isFinite(behind) ? behind : null;
      commitsAhead = Number.isFinite(ahead) ? ahead : null;
    }
  } catch {
    // No upstream configured (common for fresh task worktrees) - leave as null.
  }

  return {
    ...baseRecord,
    dirty,
    lastCommitTs,
    commitsAhead,
    commitsBehind,
  };
}
