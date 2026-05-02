/**
 * Unit tests for src/main/agent/submission-evidence.ts.
 *
 * The helper is Electron-free and only depends on agentRegistry.
 * Tests cover:
 *   - Unknown session (getSessionAgentName returns undefined) -> fallback { minBytes: 50 }
 *   - Unknown adapter name (name not in registry) -> fallback { minBytes: 50 }
 *   - Known adapter (claude) -> returns adapter's own submissionEvidence
 *   - Known adapter (codex) -> returns adapter's own submissionEvidence (hook + bytes)
 *   - Known bytes-only adapter (aider) -> returns { minBytes: 100 }
 */
import { describe, it, expect } from 'vitest';
import { resolveSubmissionEvidence } from '../../src/main/agent/submission-evidence';
import { EventType } from '../../src/shared/types';

// Minimal stub that satisfies SessionAgentNameLookup
function makeSessionManager(agentNameBySessionId: Record<string, string | undefined>) {
  return {
    getSessionAgentName(sessionId: string): string | undefined {
      return agentNameBySessionId[sessionId];
    },
  };
}

describe('resolveSubmissionEvidence', () => {
  it('returns { minBytes: 50 } fallback when session is unknown', () => {
    const sessionManager = makeSessionManager({});
    const evidence = resolveSubmissionEvidence(sessionManager, 'no-such-session');
    expect(evidence).toEqual({ minBytes: 50 });
  });

  it('returns { minBytes: 50 } fallback when adapter name is not in registry', () => {
    const sessionManager = makeSessionManager({ 'session-1': 'totally-unknown-agent' });
    const evidence = resolveSubmissionEvidence(sessionManager, 'session-1');
    expect(evidence).toEqual({ minBytes: 50 });
  });

  it('returns claude adapter evidence (hookEventType only) for a claude session', () => {
    const sessionManager = makeSessionManager({ 'session-claude': 'claude' });
    const evidence = resolveSubmissionEvidence(sessionManager, 'session-claude');
    expect(evidence.hookEventType).toBe(EventType.Prompt);
    expect(evidence.minBytes).toBeUndefined();
  });

  it('returns codex adapter evidence (hookEventType + minBytes: 100) for a codex session', () => {
    const sessionManager = makeSessionManager({ 'session-codex': 'codex' });
    const evidence = resolveSubmissionEvidence(sessionManager, 'session-codex');
    expect(evidence.hookEventType).toBe(EventType.Prompt);
    expect(evidence.minBytes).toBe(100);
  });

  it('returns aider adapter evidence (minBytes: 100 only) for an aider session', () => {
    const sessionManager = makeSessionManager({ 'session-aider': 'aider' });
    const evidence = resolveSubmissionEvidence(sessionManager, 'session-aider');
    expect(evidence.minBytes).toBe(100);
    expect(evidence.hookEventType).toBeUndefined();
  });
});
