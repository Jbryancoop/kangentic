/**
 * Spawn intent resolver for agent sessions.
 *
 * Determines whether to resume an existing session or spawn fresh based on
 * agent type. The core simplification: always querying by session_type makes
 * cross-agent resume mismatches structurally impossible (no guard needed).
 *
 * Resume is only attempted when `agent_session_id` is non-null, meaning the
 * real CLI session ID has been captured (pre-specified for Claude, captured
 * from hooks for Gemini/Codex). If the ID was never captured (session killed
 * too fast, or agent doesn't expose it), `agent_session_id` stays null and
 * a fresh session is spawned.
 *
 * This is a pure function with no side effects - easy to unit test.
 */

import { interpolateTemplate } from '../agent/shared';
import type { SessionRecord } from '../../shared/types';
import type { SessionRepository } from '../db/repositories/session-repository';

export interface SpawnIntent {
  mode: 'resume' | 'fresh';
  agentSessionId: string | null;
  prompt: string | undefined;
  /** Session record to retire when resuming (same agent type only). Null for fresh spawns. */
  retireRecordId: string | null;
}

export interface SpawnIntentOptions {
  taskId: string;
  /** The target adapter's session type (e.g. 'claude_agent', 'codex_agent'). */
  sessionType: string;
  /**
   * The isolated swimlane to scope the resume lookup to. Defaults to null (the
   * task's main session). An 'isolated'-strategy column passes its own swimlane id
   * to resume its separate session.
   */
  isolatedSwimlaneId?: string | null;
  sessionRepo: SessionRepository | null | undefined;
  promptTemplate: string | undefined;
  templateVars: Record<string, string>;
  /** Pre-computed prompt for resumed sessions (typically the auto_command). */
  resumePrompt: string | undefined;
}

/**
 * Check whether a session record is eligible for resume via --resume.
 *
 * Requires a real agent_session_id (captured or pre-specified), excludes
 * run_script sessions (no conversation to resume), and excludes queued
 * sessions (never started, no transcript).
 */
export function isResumeEligible(record: SessionRecord | undefined): boolean {
  return !!record?.agent_session_id
    && record.session_type !== 'run_script'
    && record.status !== 'queued';
}

/**
 * Resolve the spawn strategy for a task and target agent.
 *
 * Looks for a resumable session matching the target agent's session_type
 * that has a captured agent_session_id (real CLI session ID, not a placeholder).
 * If found, returns 'resume' with the agent's session ID.
 * If not, returns 'fresh'.
 *
 * Cross-agent safety is structural: the WHERE clause filters by session_type,
 * so a Claude lookup never finds a Codex session and vice versa. The isolation
 * filter adds the same structural separation between a task's main session and its
 * per-column isolated sessions.
 */
export function resolveSpawnIntent(options: SpawnIntentOptions): SpawnIntent {
  const {
    taskId, sessionType, sessionRepo, promptTemplate, templateVars, resumePrompt,
    isolatedSwimlaneId = null,
  } = options;

  const match = sessionRepo?.getLatestForTaskByTypeAndIsolation(taskId, sessionType, isolatedSwimlaneId);
  const canResume = isResumeEligible(match);

  if (canResume) {
    return {
      mode: 'resume',
      agentSessionId: match!.agent_session_id!,
      prompt: resumePrompt,
      retireRecordId: match!.id,
    };
  }

  return {
    mode: 'fresh',
    agentSessionId: null,
    prompt: promptTemplate
      ? interpolateTemplate(promptTemplate, templateVars)
      : undefined,
    retireRecordId: null,
  };
}
