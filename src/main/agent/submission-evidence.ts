// Pure helper - no Electron imports. Safe to import from unit tests.
//
// Resolves the SubmissionEvidence for a given PTY session by looking up
// the session's adapter name via the session manager, then fetching the
// adapter from the agent registry.
//
// Both `browser.ts` and `command-injector.ts` share this same three-line
// pattern. Extracting it here keeps the logic in one place, makes the
// fallback value visible and testable, and lets the unit tests instantiate
// adapters directly without touching Electron or I/O.

import type { SubmissionEvidence } from '../../shared/types';
import { agentRegistry } from './agent-registry';

/** Minimal interface so the helper can accept MockSessionManager in tests
 *  without importing the real SessionManager (which pulls in node-pty). */
export interface SessionAgentNameLookup {
  getSessionAgentName(sessionId: string): string | undefined;
}

/**
 * Resolve the per-adapter SubmissionEvidence for a running PTY session.
 *
 * Falls back to `{ minBytes: 50 }` when the session's adapter is unknown
 * (brand-new adapter that forgets to declare `submissionEvidence`, or a
 * session that predates adapter-name tracking). The 50-byte floor is a
 * universal safety net: it filters single-cursor blips without requiring
 * any adapter-specific knowledge.
 *
 * @param sessionManager - anything that exposes `getSessionAgentName`
 * @param sessionId      - the PTY session whose evidence config to fetch
 */
export function resolveSubmissionEvidence(
  sessionManager: SessionAgentNameLookup,
  sessionId: string,
): SubmissionEvidence {
  const adapterName = sessionManager.getSessionAgentName(sessionId);
  const adapter = adapterName ? agentRegistry.get(adapterName) : undefined;
  return adapter?.submissionEvidence ?? { minBytes: 50 };
}
