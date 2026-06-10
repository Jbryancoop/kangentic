import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { toForwardSlash, replacePathPrefix } from '../../../../shared/paths';
import { claudeProjectSlug } from './transcript-parser';
import { withClaudeJsonLock } from './trust-manager';

/**
 * Migrate Claude Code's per-project data when a Kangentic project is relocated.
 *
 * Claude Code keys two stores to the absolute project path, both living OUTSIDE
 * the project folder, so a move or rename orphans them (sessions then fail to
 * resume with "No conversation found with session ID"):
 *
 * 1. Transcripts + auto-memory under `~/.claude/projects/<slug>/`, where
 *    `<slug>` is derived from the cwd (see `claudeProjectSlug`).
 * 2. Per-project state in `~/.claude.json` under the top-level `projects`
 *    object, keyed by the absolute path (trust decision, allowed tools, MCP
 *    approvals, prompt history).
 *
 * Claude is spawned with cwd = the project root AND with cwd = each worktree
 * under `<project>/.kangentic/worktrees/`, so both stores hold one entry per
 * cwd. The worktrees move with the project folder, so we reconstruct their old
 * paths by listing the relocated folder; deleted worktrees that still have a
 * `~/.claude.json` key are caught by scanning the keys directly.
 *
 * Safety: best-effort and non-destructive. Directories are renamed or merged
 * (never deleted); `~/.claude.json` is backed up to `~/.claude.json.kangentic-backup`
 * and written atomically before the original is replaced. Every step is wrapped
 * in try/catch so a partial failure degrades to today's behavior (orphaned
 * data), never to data loss.
 *
 * Concurrency caveat: a live Claude session in ANOTHER project or an external
 * terminal keeps `~/.claude.json` in memory and may overwrite our key rewrite
 * when it next saves. That cannot be detected without violating the adapter
 * boundary, and blocking relocation on unrelated sessions would be hostile, so
 * we proceed. The consequence is limited to a re-shown trust prompt and lost
 * prompt history for the relocated project; session resume still works because
 * the transcript directory rename is independent of `~/.claude.json`. The
 * backup mitigates the rest. The module lock only guards Kangentic's own
 * writers (`ensureWorktreeTrust` / `ensureMcpServerTrust`).
 */
export async function migrateClaudeProjectData(oldProjectPath: string, newProjectPath: string): Promise<void> {
  return withClaudeJsonLock(() => migrateClaudeProjectDataSync(oldProjectPath, newProjectPath));
}

interface PathPair {
  oldAbsolute: string;
  newAbsolute: string;
}

function migrateClaudeProjectDataSync(oldProjectPath: string, newProjectPath: string): void {
  const oldResolved = path.resolve(oldProjectPath);
  const newResolved = path.resolve(newProjectPath);

  const pairs = collectMigrationPairs(oldResolved, newResolved);
  migrateTranscriptDirectories(pairs);
  rewriteClaudeJson(oldResolved, newResolved);
}

/**
 * Collect every (oldAbsolute, newAbsolute) pair whose Claude data must move:
 * the project root, every worktree found on disk under the relocated folder,
 * and every `~/.claude.json` projects key that resolves under the old project
 * path (catches worktrees deleted from disk whose keys/transcripts persist).
 * Deduplicated by the forward-slash form of the resolved old path.
 */
function collectMigrationPairs(oldResolved: string, newResolved: string): PathPair[] {
  const pairs = new Map<string, PathPair>();
  const addPair = (oldAbsolute: string, newAbsolute: string): void => {
    pairs.set(toForwardSlash(path.resolve(oldAbsolute)), {
      oldAbsolute: path.resolve(oldAbsolute),
      newAbsolute: path.resolve(newAbsolute),
    });
  };

  // 1. Project root.
  addPair(oldResolved, newResolved);

  // 2. Worktrees present on disk. They moved with the folder, so listing the
  //    NEW location reconstructs the OLD paths via the same relative subpath.
  try {
    const worktreesRoot = path.join(newResolved, '.kangentic', 'worktrees');
    for (const entry of fs.readdirSync(worktreesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      addPair(
        path.join(oldResolved, '.kangentic', 'worktrees', entry.name),
        path.join(newResolved, '.kangentic', 'worktrees', entry.name),
      );
    }
  } catch {
    // No worktrees directory (or unreadable): nothing to add from disk.
  }

  // 3. ~/.claude.json keys under the old path (covers worktrees deleted from
  //    disk). Exact prefix matching via replacePathPrefix, never slug-prefix
  //    string matching (`.` also maps to `-`, ambiguous against siblings).
  try {
    const claudeJsonPath = path.join(os.homedir(), '.claude.json');
    const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8')) as Record<string, unknown>;
    const projects = data.projects;
    if (projects && typeof projects === 'object') {
      for (const key of Object.keys(projects)) {
        const rewritten = replacePathPrefix(key, oldResolved, newResolved);
        if (rewritten) addPair(key, rewritten);
      }
    }
  } catch {
    // Missing or unparsable ~/.claude.json: keys handled (or skipped) later.
  }

  return [...pairs.values()];
}

/**
 * Rename each pair's transcript directory under `~/.claude/projects/` from the
 * old slug to the new slug. When the target already exists (the user opened
 * Claude at the new location before relocating in Kangentic), merge the source
 * entries in rather than skipping, so old transcripts are never orphaned.
 */
function migrateTranscriptDirectories(pairs: PathPair[]): void {
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');

  for (const pair of pairs) {
    try {
      const sourceDir = resolveSourceTranscriptDir(projectsRoot, pair.oldAbsolute);
      if (!sourceDir) continue; // No transcripts for this cwd; common, skip silently.
      const targetDir = path.join(projectsRoot, claudeProjectSlug(pair.newAbsolute));
      if (sourceDir === targetDir) continue;

      if (!fs.existsSync(targetDir)) {
        // The existsSync guard is load-bearing on Windows: renaming a directory
        // ONTO an existing directory fails there (EPERM/ENOTEMPTY). Only the
        // absent-target case is a plain rename; the collision case merges below.
        fs.renameSync(sourceDir, targetDir);
        continue;
      }

      // Target exists: merge per entry. Transcript filenames are session UUIDs,
      // so collisions are effectively impossible; any colliding entry is left
      // in the source rather than overwritten.
      mergeTranscriptDir(sourceDir, targetDir);
    } catch (err) {
      console.warn(`[CLAUDE_RELOCATE] Failed to migrate transcripts for ${pair.oldAbsolute}:`, err);
    }
  }
}

/**
 * Find the existing transcript directory for an old cwd. The slug is
 * separator-agnostic for the common case, but a path long enough to be
 * truncated carries a hash of the original string whose separator form (native
 * vs forward-slash) we cannot know, so probe both candidates.
 */
function resolveSourceTranscriptDir(projectsRoot: string, oldAbsolute: string): string | null {
  const candidates = [
    path.join(projectsRoot, claudeProjectSlug(oldAbsolute)),
    path.join(projectsRoot, claudeProjectSlug(toForwardSlash(oldAbsolute))),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function mergeTranscriptDir(sourceDir: string, targetDir: string): void {
  for (const entry of fs.readdirSync(sourceDir)) {
    const targetEntry = path.join(targetDir, entry);
    if (fs.existsSync(targetEntry)) continue; // Keep the existing target entry.
    fs.renameSync(path.join(sourceDir, entry), targetEntry);
  }
  // Remove the source only if everything moved out (rmdir fails if non-empty).
  try {
    fs.rmdirSync(sourceDir);
  } catch {
    // Source not empty (a colliding entry stayed behind, or a nested
    // subdirectory): leave the source directory in place.
  }
}

/**
 * Rewrite `~/.claude.json` projects keys from old paths to new paths, backing
 * the file up first and writing atomically. Keys are re-emitted in forward-slash
 * form (Claude's convention on all platforms) with their values carried verbatim.
 */
function rewriteClaudeJson(oldResolved: string, newResolved: string): void {
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');

  let original: string;
  let data: Record<string, unknown>;
  try {
    original = fs.readFileSync(claudeJsonPath, 'utf-8');
    data = JSON.parse(original) as Record<string, unknown>;
  } catch {
    return; // Missing or unparsable: leave it untouched. Transcripts already moved.
  }

  const projects = data.projects;
  if (!projects || typeof projects !== 'object') return;
  const projectEntries = projects as Record<string, unknown>;

  // Compute rewrites first; if nothing matches, do not touch the file at all.
  const rewrites = new Map<string, string>();
  for (const key of Object.keys(projectEntries)) {
    const rewritten = replacePathPrefix(key, oldResolved, newResolved);
    if (rewritten) rewrites.set(key, toForwardSlash(rewritten));
  }
  if (rewrites.size === 0) return;

  // Rebuild projects preserving entry order. When a destination key already
  // exists (Claude already ran at the new path), keep the fresher destination
  // value and drop the dead old key.
  const rebuilt: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(projectEntries)) {
    const target = rewrites.get(key);
    if (!target) {
      if (!(key in rebuilt)) rebuilt[key] = value;
      continue;
    }
    if (target in projectEntries || target in rebuilt) continue; // Destination already present; keep it.
    rebuilt[target] = value;
  }
  data.projects = rebuilt;

  try {
    fs.copyFileSync(claudeJsonPath, `${claudeJsonPath}.kangentic-backup`);
  } catch (err) {
    console.warn('[CLAUDE_RELOCATE] Failed to back up ~/.claude.json; aborting key rewrite:', err);
    return; // Without a backup, do not risk the in-place rewrite.
  }

  // Atomic write: serialize to a temp file then rename over the original.
  // fs.renameSync replaces an existing destination on win32/darwin/linux.
  const tempPath = `${claudeJsonPath}.kangentic-tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tempPath, claudeJsonPath);
  } catch (err) {
    console.warn('[CLAUDE_RELOCATE] Failed to rewrite ~/.claude.json:', err);
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Best-effort temp cleanup.
    }
  }
}
