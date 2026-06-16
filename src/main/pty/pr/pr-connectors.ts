/**
 * PR Connector Registry - platform-agnostic PR URL detection.
 *
 * Each hosting platform (GitHub, GitLab, Bitbucket, Azure DevOps) implements
 * the PRConnector interface. The registry exposes two functions that the rest
 * of the codebase calls without knowing which platforms are registered:
 *
 *   matchesPRCommand(detail)  - used by PRCommandDetector to flag relevant Bash commands
 *   detectPR(scrollback)      - used by session-manager to extract PR URLs
 *
 * To add a new platform:
 * 1. Create a connector file (e.g. gitlab-mr-detector.ts)
 * 2. Export a PRConnector object
 * 3. Import and add it to the `connectors` array below
 */

import type { PRState } from '../../../shared/types';

export type { PRState };
// Re-export so existing importers (`pr-linking.ts`) keep a stable surface. The
// classes live in a leaf module to avoid a connector <-> registry import cycle.
export { PRResolverUnavailableError, PRResolverTransientError } from './pr-errors';

export interface DetectedPR {
  url: string;
  number: number;
}

/**
 * Authoritative resolver result - richer than DetectedPR because it comes from a
 * structured API query (e.g. `gh pr list --json`) rather than scrollback text.
 */
export interface ResolvedPR {
  url: string;
  number: number;
  state: PRState;
  baseRefName?: string;
  updatedAt?: string;
}

export interface PRConnector {
  /** Platform name for logging (e.g. "GitHub", "GitLab") */
  name: string;

  /** Does this Bash command detail look like a PR command for this platform? */
  matchesCommand(commandDetail: string): boolean;

  /** Extract a PR URL + number from raw PTY scrollback text. */
  extract(scrollback: string): DetectedPR | null;

  /**
   * Extract the single canonical PR reference from authored text (a task
   * description), or null when the text names zero or several distinct PRs.
   * Unlike `extract` - which returns the most recent of many scrollback URLs -
   * this is deliberately conservative: it returns a match only when there is no
   * ambiguity, so a description is never guessed at. Optional per platform.
   */
  extractCanonical?(text: string): DetectedPR | null;

  /**
   * Authoritatively resolve the PR for a branch via the platform API, run from
   * inside the repo/worktree at `repoCwd`. Returns null when no PR matches the
   * head ref; throws `PRResolverUnavailableError` when the CLI is unavailable so
   * the caller can degrade to `extract`. Optional - platforms without an API
   * resolver are skipped.
   */
  resolveForBranch?(repoCwd: string, branchName: string, baseBranch?: string): Promise<ResolvedPR | null>;

  /**
   * Resolve a PR by its number - the most exact anchor, immune to branch renames.
   * Used to refresh an already-linked PR's state. Returns null if the number no
   * longer exists; throws `PRResolverUnavailableError` when the CLI is unavailable.
   */
  resolveByNumber?(repoCwd: string, prNumber: number): Promise<ResolvedPR | null>;

  /**
   * Resolve the PR associated with a commit SHA. An immutable anchor that
   * survives worktree deletion and branch renames - used to backfill Done /
   * no-worktree tasks. `branchHint` (the task's known branch) disambiguates when
   * a commit belongs to several PRs and guards against linking an unrelated PR
   * that merely contains the same commit. Returns null when no PR matches; throws
   * `PRResolverUnavailableError` when the CLI is unavailable.
   */
  resolveByCommit?(repoCwd: string, commitSha: string, branchHint?: string): Promise<ResolvedPR | null>;
}

// --- Registry: add new connectors here ---
import { gitHubPRConnector } from './github-pr-detector';

const connectors: PRConnector[] = [
  gitHubPRConnector,
  // Future: gitLabMRConnector, bitbucketPRConnector, azureDevOpsPRConnector
];

// --- Platform-agnostic API ---

/** Check if a Bash command detail matches any registered PR connector. */
export function matchesPRCommand(commandDetail: string): boolean {
  return connectors.some((connector) => connector.matchesCommand(commandDetail));
}

/** Try all registered connectors against scrollback, return first match. */
export function detectPR(scrollback: string): DetectedPR | null {
  for (const connector of connectors) {
    const result = connector.extract(scrollback);
    if (result) return result;
  }
  return null;
}

/**
 * Extract a single canonical PR reference from authored text (a task
 * description) via the first connector that recognizes exactly one PR. Returns
 * null when no connector finds an unambiguous match - so a description that
 * names several PRs, or none, is never guessed at.
 */
export function detectCanonicalPR(text: string): DetectedPR | null {
  for (const connector of connectors) {
    if (!connector.extractCanonical) continue;
    const result = connector.extractCanonical(text);
    if (result) return result;
  }
  return null;
}

/**
 * Authoritatively resolve the PR for a branch via the first registered connector
 * that supports `resolveForBranch` and returns a match. Connector errors
 * (`PRResolverUnavailableError`) propagate so the caller can degrade to `detectPR`.
 */
export async function resolvePRForBranch(
  repoCwd: string,
  branchName: string,
  baseBranch?: string,
): Promise<ResolvedPR | null> {
  for (const connector of connectors) {
    if (!connector.resolveForBranch) continue;
    const result = await connector.resolveForBranch(repoCwd, branchName, baseBranch);
    if (result) return result;
  }
  return null;
}

/** Resolve a PR by number via the first connector that supports it. */
export async function resolvePRByNumber(repoCwd: string, prNumber: number): Promise<ResolvedPR | null> {
  for (const connector of connectors) {
    if (!connector.resolveByNumber) continue;
    const result = await connector.resolveByNumber(repoCwd, prNumber);
    if (result) return result;
  }
  return null;
}

/** Resolve the PR associated with a commit SHA via the first connector that supports it. */
export async function resolvePRByCommit(repoCwd: string, commitSha: string, branchHint?: string): Promise<ResolvedPR | null> {
  for (const connector of connectors) {
    if (!connector.resolveByCommit) continue;
    const result = await connector.resolveByCommit(repoCwd, commitSha, branchHint);
    if (result) return result;
  }
  return null;
}
