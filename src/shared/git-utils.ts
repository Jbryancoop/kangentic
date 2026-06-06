/**
 * Validate a git branch name according to git-check-ref-format rules.
 * Returns true if the name is valid, false otherwise.
 *
 * Rejects: leading `-`, `..`, spaces, control chars, `~^:*?[\`,
 * `@{`, consecutive or trailing slashes, `.lock` suffix, trailing `.`,
 * and empty/whitespace-only input.
 */
export function isValidGitBranchName(name: string): boolean {
  if (!name || !name.trim()) return false;

  // No ASCII control characters or space, DEL
  if (/[\x00-\x1f\x7f ]/.test(name)) return false;

  // Forbidden characters: ~ ^ : * ? [ \
  if (/[~^:*?[\\]/.test(name)) return false;

  // No `..` anywhere
  if (name.includes('..')) return false;

  // No `@{` anywhere
  if (name.includes('@{')) return false;

  // Cannot start with `-` or `/`
  if (name.startsWith('-') || name.startsWith('/')) return false;

  // Cannot end with `/` or `.`
  if (name.endsWith('/') || name.endsWith('.')) return false;

  // Cannot end with `.lock`
  if (name.endsWith('.lock')) return false;

  // No consecutive slashes
  if (name.includes('//')) return false;

  // No component can start with `.`
  if (name.split('/').some(component => component.startsWith('.'))) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Worktree path helpers (pure string, no Node APIs)
// ---------------------------------------------------------------------------

const WORKTREE_MARKER = '.kangentic/worktrees/';

/**
 * Check whether a path is a Kangentic-managed worktree checkout.
 * Pure string check - works in both main and renderer processes.
 *
 * Checks that the path ENDS with `.kangentic/worktrees/<slug>` (the last
 * two parent segments), not just that the marker appears anywhere in the
 * path. This avoids false positives when the app itself runs from inside
 * a worktree (e.g. CWD contains `.kangentic/worktrees/` early in the path).
 */
export function isWorktreePath(projectPath: string): boolean {
  const normalized = projectPath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length < 3) return false;
  return segments[segments.length - 2] === 'worktrees' && segments[segments.length - 3] === '.kangentic';
}

/**
 * Resolve a worktree path to the main repository root.
 * Strips the `.kangentic/worktrees/<slug>` suffix.
 * Returns the original path if it's not a worktree.
 */
export function resolveProjectRoot(projectPath: string): string {
  if (!isWorktreePath(projectPath)) return projectPath;
  // Find the last occurrence of the marker to handle edge cases where
  // the marker appears earlier in the path (e.g. nested worktrees).
  const normalized = projectPath.replace(/\\/g, '/');
  const markerIndex = normalized.lastIndexOf(WORKTREE_MARKER);
  return projectPath.slice(0, markerIndex).replace(/[/\\]$/, '');
}
