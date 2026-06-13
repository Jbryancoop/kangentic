import type { SessionRecord, Swimlane, Task } from '../../shared/types';
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
  /**
   * `model_override` and `effort_override` are read so that a task with an
   * explicit per-task override (set via the ContextBar popover) is treated as
   * a no-op for that field on column transitions - the user's choice wins
   * over the column's setting.
   */
  task: Pick<Task, 'id' | 'agent' | 'model_override' | 'effort_override'>;
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
  /**
   * The model/effort the live session will be at once this burst applies -
   * present only for fields whose value actually changed to a concrete target
   * (i.e. a `/model` / `/effort` slash was emitted). The caller persists these
   * via `sessionRepo.updateAppliedSettings` after scheduling so the next column
   * transition diffs against the session's true running value. Absent when the
   * burst carries only an auto_command (no settings delta).
   */
  appliedSettings?: { model?: string; effort?: string };
}

export function prepareInjectionPlan(input: InjectionPlanInput): InjectionPlan | null {
  const { adapter, sessionRepo, task, toLane, autoCommand } = input;

  // SOURCE is the model/effort the live session is ACTUALLY running at, read
  // from the session record (`applied_model` / `applied_effort`), NOT the
  // leaving column's config. The leaving column disagrees after an in-flight
  // ContextBar switch or a kangentic.json column-config edit, which is what
  // produced the spurious `/effort` injection. A per-task override still wins:
  // the session was spawned/switched to the pin, so source = target = pin and no
  // slash fires for that field (preserving the ContextBar contract). When no
  // record exists (unit stubs, a session predating this column) the applied
  // value is null, i.e. "agent default".
  const record = sessionRepo?.getLatestForTask(task.id) ?? null;
  const sourceModel = task.model_override ?? record?.applied_model ?? null;
  const targetModel = task.model_override ?? toLane?.model_override ?? null;
  const sourceEffort = task.effort_override ?? record?.applied_effort ?? null;
  const targetEffort = task.effort_override ?? toLane?.effort_override ?? null;

  const modelChanged = targetModel !== sourceModel;
  const effortChanged = targetEffort !== sourceEffort;

  // Settings writes come from the adapter so the IPC layer never names a
  // slash. An adapter without getInjectionSequence contributes none.
  const settingsSequence = adapter?.getInjectionSequence?.({
    model: targetModel,
    modelChanged,
    effort: targetEffort,
    effortChanged,
  }) ?? [];

  const trimmedAutoCommand = autoCommand?.trim() ?? '';
  const sequence = trimmedAutoCommand
    ? [...settingsSequence, trimmedAutoCommand]
    : settingsSequence;

  if (sequence.length === 0) return null;

  // Verifier is best-effort: needs adapter support + a captured agent_session_id.
  // null is a documented fallback to time-based settle in
  // TerminalSubmit.submitKeystrokes. Pass the record we already read so the
  // verifier builder does not re-query.
  const verifier = adapter && sessionRepo
    ? buildCommandInjectionVerifier(adapter, sessionRepo, task.id, record)
    : null;

  // What the session will be at after this burst: only fields that changed to a
  // concrete value (i.e. a slash was actually emitted). A change to a null
  // target ("Default" column) emits no slash and leaves the session as-is, so
  // it is not recorded.
  const appliedSettings: { model?: string; effort?: string } = {};
  if (modelChanged && targetModel !== null) appliedSettings.model = targetModel;
  if (effortChanged && targetEffort !== null) appliedSettings.effort = targetEffort;
  const hasApplied = appliedSettings.model !== undefined || appliedSettings.effort !== undefined;

  return {
    sequence,
    verifier,
    verifiedPrefixLength: settingsSequence.length,
    ...(hasApplied ? { appliedSettings } : {}),
  };
}

/**
 * Wrap an adapter's `command-injection` `SubmissionVerifier` as the
 * `CommandVerifier` shape that `TerminalSubmit.submitKeystrokes` expects.
 *
 * Returns `null` when (a) the adapter doesn't implement
 * `getSubmissionVerifier('command-injection')`, or (b) the latest session
 * record for the task lacks `agent_session_id` / `cwd` (e.g. a fresh spawn
 * whose session ID hasn't been captured yet). In both cases callers should
 * fall back to the time-based settle path inside `TerminalSubmit`.
 *
 * Shared between `prepareInjectionPlan` (column-transition slash bursts) and
 * the `task:setRuntimeOverride` IPC handler (user-driven model/effort
 * picks). Without a shared helper both call sites would re-implement the
 * same record lookup + closure capture, and a fix in one would silently
 * miss the other.
 *
 * `prefetchedRecord` lets a caller that already read the latest session record
 * (e.g. `prepareInjectionPlan` reading it for the delta source) pass it through
 * to avoid a second query. Omit it to read fresh.
 */
export function buildCommandInjectionVerifier(
  adapter: AgentAdapter,
  sessionRepo: SessionRepository,
  taskId: string,
  prefetchedRecord?: SessionRecord | null,
): CommandVerifier | null {
  if (!adapter.getSubmissionVerifier) return null;
  const submissionVerifier = adapter.getSubmissionVerifier('command-injection');
  if (!submissionVerifier) return null;
  const record = prefetchedRecord !== undefined ? prefetchedRecord : sessionRepo.getLatestForTask(taskId);
  if (!record?.agent_session_id || !record.cwd) return null;
  const agentSessionId = record.agent_session_id;
  const cwd = record.cwd;
  return async (command: string, sentAt: number) => submissionVerifier({
    type: 'command-injection',
    text: command,
    agentSessionId,
    cwd,
    sentAt,
  });
}
