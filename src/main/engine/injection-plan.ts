import type { Swimlane, Task } from '../../shared/types';
import type { AgentAdapter } from '../agent/agent-adapter';
import type { SessionRepository } from '../db/repositories/session-repository';
import type { CommandVerifier } from './terminal-submit-scheduler';

/**
 * Per-agent translation of a column-level model/effort change (and an
 * optional auto_command) into a chained sequence of writes plus an
 * appropriate verifier - i.e. the input TerminalSubmitScheduler needs to
 * actually push the writes onto the PTY.
 *
 * Naming convention across the stack:
 * - "sequence" = pure data, agent-declared (adapter.getInjectionSequence,
 *   adapter.getExitSequence). The adapter names a sequence by the
 *   lifecycle event that drives it (injection / exit), not by the
 *   downstream consumer.
 * - "plan"     = the assembled artifact (sequence + verifier) handed to
 *   the executor. The plan is what gets injected.
 * - "scheduler" / "burst" = execution layer (TerminalSubmitScheduler).
 *
 * Centralizes what `task-move.ts` and `board.ts` would otherwise both
 * build by hand:
 *
 * 1. Ask the destination adapter for the writes needed to apply settings
 *    deltas (`getInjectionSequence`).
 * 2. Append the column's auto_command (already interpolated) if any.
 * 3. Ask the adapter for a per-command verifier
 *    (`getSubmissionVerifier('command-injection')`) bound to this task's
 *    session transcript via the captured `agentSessionId` and `cwd`.
 *
 * Returns null when there is nothing to inject (no settings delta, no
 * auto_command). Callers pass the result straight to
 * `terminalSubmitScheduler.scheduleKeystrokes(task.id, sessionId, plan.sequence, { verifier: plan.verifier, verifiedPrefixLength: plan.verifiedPrefixLength })`.
 */
export interface InjectionPlanInput {
  adapter: AgentAdapter | undefined;
  sessionRepo: SessionRepository | null;
  task: Pick<Task, 'id' | 'agent'>;
  fromLane: Swimlane | null;
  toLane: Swimlane | null;
  /** Already-interpolated auto_command from the destination column, or empty. */
  autoCommand?: string;
}

export interface InjectionPlan {
  sequence: string[];
  verifier: CommandVerifier | null;
  /**
   * Number of leading commands in `sequence` that are safe to verify against
   * the agent's transcript. This covers the deterministic adapter-emitted
   * writes (`/model X`, `/effort Y` from `getInjectionSequence`) but excludes
   * any trailing user-supplied auto_command, because the verifier cannot tell
   * a `/`-prefixed user command from a settings command and would risk
   * dropping the user's intended action after retry exhaustion.
   */
  verifiedPrefixLength: number;
}

export function prepareInjectionPlan(input: InjectionPlanInput): InjectionPlan | null {
  const { adapter, sessionRepo, task, fromLane, toLane, autoCommand } = input;

  const sourceModel = fromLane?.model_override ?? null;
  const targetModel = toLane?.model_override ?? null;
  const sourceEffort = fromLane?.effort_override ?? null;
  const targetEffort = toLane?.effort_override ?? null;

  // Settings writes come from the adapter so the IPC layer never names a
  // slash. An adapter without getInjectionSequence contributes none.
  const settingsSequence = adapter?.getInjectionSequence?.({
    model: targetModel,
    modelChanged: targetModel !== sourceModel,
    effort: targetEffort,
    effortChanged: targetEffort !== sourceEffort,
  }) ?? [];

  const trimmedAutoCommand = autoCommand?.trim() ?? '';
  const sequence = trimmedAutoCommand
    ? [...settingsSequence, trimmedAutoCommand]
    : settingsSequence;

  if (sequence.length === 0) return null;

  // Verifier is best-effort: needs adapter support + a captured agent_session_id.
  // null is a documented fallback to time-based settle in
  // TerminalSubmit.submitKeystrokes.
  let verifier: CommandVerifier | null = null;
  if (adapter?.getSubmissionVerifier && sessionRepo) {
    const record = sessionRepo.getLatestForTask(task.id);
    if (record?.agent_session_id && record.cwd) {
      const submissionVerifier = adapter.getSubmissionVerifier('command-injection');
      if (submissionVerifier) {
        // Wrap the SubmissionVerifier (which expects SubmissionContext) as a
        // CommandVerifier (which accepts a command string and sentAt). The
        // wrapper packs both into the SubmissionContext along with the
        // session metadata, so the underlying verifier can bound its scan
        // window to entries written after sentAt.
        verifier = async (command: string, sentAt: number) => {
          return submissionVerifier({
            type: 'command-injection',
            text: command,
            agentSessionId: record.agent_session_id ?? undefined,
            cwd: record.cwd ?? undefined,
            sentAt,
          });
        };
      }
    }
  }

  return { sequence, verifier, verifiedPrefixLength: settingsSequence.length };
}
