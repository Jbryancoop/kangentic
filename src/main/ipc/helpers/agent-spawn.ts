import { TaskRepository } from '../../db/repositories/task-repository';
import { SwimlaneRepository } from '../../db/repositories/swimlane-repository';
import { ActionRepository } from '../../db/repositories/action-repository';
import { AttachmentRepository } from '../../db/repositories/attachment-repository';
import { SessionRepository } from '../../db/repositories/session-repository';
import { HandoffRepository } from '../../db/repositories/handoff-repository';
import { TransitionEngine } from '../../engine/transition-engine';
import { getProjectDb } from '../../db/database';
import { interpolateTemplate } from '../../agent/shared';
import { agentRegistry } from '../../agent/agent-registry';
import { buildSessionHistoryReference } from '../../agent/handoff/session-history-reference';
import { DEFAULT_AGENT } from '../../../shared/types';
import type { Task, Swimlane } from '../../../shared/types';
import type { IpcContext } from '../ipc-context';
import { isAbortError } from '../../../shared/abort-utils';
import { resolveTargetAgent } from '../../engine/agent-resolver';
import { canResume as checkCanResume } from '../../engine/session-lifecycle';
import { emitSpawnProgress } from '../../engine/spawn-progress';
import { ensureTaskWorktree, ensureTaskBranchCheckout } from './task-git';
import { getProjectRepos } from './project-repos';
import { withTaskLock } from '../task-lifecycle-lock';

/** Build template variables for auto-command interpolation. */
export function buildAutoCommandVars(task: Task): Record<string, string> {
  return {
    title: task.title,
    description: task.description,
    taskId: task.id,
    worktreePath: task.worktree_path || '',
    branchName: task.branch_name || '',
  };
}

/** Create a TransitionEngine wired to explicit project context (not singletons). */
export function createTransitionEngine(
  context: IpcContext,
  actions: ActionRepository,
  tasks: TaskRepository,
  sessionRepo: SessionRepository,
  attachments: AttachmentRepository,
  projectId: string,
  projectPath: string | null,
): TransitionEngine {
  return new TransitionEngine(
    context.sessionManager, actions, tasks,
    () => {
      const config = context.configManager.getEffectiveConfig(projectPath || undefined);
      const gitConfig = { ...config.git };
      // Overlay board config's defaultBaseBranch (team-shared) onto gitConfig
      const boardDefaultBranch = context.boardConfigManager.getDefaultBaseBranch();
      if (boardDefaultBranch) {
        gitConfig.defaultBaseBranch = boardDefaultBranch;
      }
      const project = context.projectRepo.getById(projectId);
      return {
        permissionMode: config.agent.permissionMode,
        projectPath,
        projectId,
        gitConfig,
        mcpServerEnabled: config.mcpServer?.enabled ?? true,
        mcpServerUrl: context.mcpServerHandle?.urlForProject(projectId),
        mcpServerToken: context.mcpServerHandle?.token,
        defaultAgent: project?.default_agent ?? DEFAULT_AGENT,
        cliPathOverrides: config.agent.cliPaths,
      };
    },
    sessionRepo,
    attachments,
  );
}

export interface AgentSpawnOptions {
  context: IpcContext;
  engine: TransitionEngine;
  tasks: TaskRepository;
  sessionRepo: SessionRepository;
  task: Task;
  fromSwimlaneId: string;
  toLane: Swimlane;
  skipPromptTemplate?: boolean;
  signal?: AbortSignal;
  /** Project ID for handoff context resolution. Resolved from caller's context. */
  projectId?: string;
  /** Project filesystem path for handoff context resolution. */
  projectPath?: string | null;
}

/**
 * Single entry point for spawning or resuming an agent session for a task.
 *
 * Implements the "ensure" pattern: idempotent, safe to call multiple times.
 * 1. Runs configured transition actions (which may spawn via spawn_agent action)
 * 2. Verifies whether a session was created (re-reads from DB)
 * 3. If not, spawns or resumes a session as fallback
 * 4. Schedules auto_command injection when appropriate
 *
 * No-ops when: toLane.auto_spawn is false, task already has a session, or
 * task was deleted mid-operation. AbortError always propagates for cancellation.
 */
export async function spawnAgent(options: AgentSpawnOptions): Promise<void> {
  const { context, engine, tasks, sessionRepo, task, fromSwimlaneId, toLane, skipPromptTemplate, signal } = options;

  // Guard: if the target column doesn't want agents, no-op
  if (!toLane.auto_spawn) return;

  // Guard: if the user manually paused this task, don't auto-resume.
  // The user must explicitly click Resume (SESSION_RESUME) to restart.
  const latestSession = sessionRepo.getLatestForTask(task.id);
  if (latestSession?.status === 'suspended' && latestSession.suspended_by === 'user') {
    console.log(`[spawnAgent] Skipping auto-spawn for task ${task.id.slice(0, 8)} (manually paused by user)`);
    return;
  }

  // --- Resolve target agent ONCE (single source of truth) ---
  const project = options.projectId ? context.projectRepo.getById(options.projectId) : null;
  const { agent: targetAgent, isHandoff } = resolveTargetAgent({
    columnAgent: toLane.agent_override,
    taskAgent: task.agent,
    projectDefaultAgent: project?.default_agent ?? null,
  });

  // Handoff also requires a previous session to exist, a project context,
  // and the target column's handoff_context toggle to be enabled (default: false).
  // When disabled (default), the agent change is still detected but no context
  // is packaged - the new agent starts fresh with just the task title/description.
  const hasHandoffContext = toLane.handoff_context !== false
    && isHandoff
    && options.projectId !== undefined
    && sessionRepo.getLatestForTask(task.id) !== null;

  console.log(`[spawnAgent] task=${task.id.slice(0, 8)} targetAgent=${targetAgent} isHandoff=${isHandoff} hasHandoffContext=${hasHandoffContext}`);

  // --- Handoff path: locate source session file and spawn target agent ---
  if (hasHandoffContext) {
    // Guard: hasHandoffContext implies isHandoff which implies task.agent !== null
    const sourceAgent = task.agent!;
    console.log(`[spawnAgent] Handoff: ${sourceAgent} -> ${targetAgent} for task ${task.id.slice(0, 8)}`);
    emitSpawnProgress(context.mainWindow, task.id, 'packaging-handoff');
    signal?.throwIfAborted();

    let handoffPromptPrefix: string | undefined;
    let handoffId: string | undefined;
    const handoffProjectId = options.projectId!;
    const handoffDb = getProjectDb(handoffProjectId);

    try {
      // Locate the source agent's native session history file.
      // The file path is derived from the session's agent_session_id + cwd.
      const latestSessionRecord = sessionRepo.getLatestForTask(task.id);
      let sessionFilePath: string | null = null;

      if (latestSessionRecord?.agent_session_id) {
        const sourceAdapter = agentRegistry.get(sourceAgent);
        if (sourceAdapter) {
          sessionFilePath = await sourceAdapter.locateSessionHistoryFile(
            latestSessionRecord.agent_session_id,
            latestSessionRecord.cwd,
          );
        }
      }

      // Determine if the target agent has MCP access (currently only Claude).
      const targetAdapter = agentRegistry.get(targetAgent);
      const targetHasMcpAccess = targetAdapter?.name === 'claude';

      handoffPromptPrefix = buildSessionHistoryReference({
        sourceAgent,
        sessionFilePath,
        targetHasMcpAccess,
      });

      // Store a handoff record for audit trail.
      try {
        const handoffRepo = new HandoffRepository(handoffDb);
        const handoffRecord = handoffRepo.insert({
          task_id: task.id,
          from_session_id: latestSessionRecord?.id ?? null,
          to_session_id: null, // Filled after target agent spawns
          from_agent: sourceAgent,
          to_agent: targetAgent,
          trigger: 'column_transition',
          session_history_path: sessionFilePath,
        });
        handoffId = handoffRecord.id;
      } catch (handoffDbError) {
        console.error('[spawnAgent] Failed to store handoff record:', handoffDbError);
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
      console.error('[spawnAgent] Handoff preparation failed (continuing without context):', error);
    }

    emitSpawnProgress(context.mainWindow, task.id, 'detecting-agent');

    try {
      await engine.resumeSuspendedSession(
        task, toLane.permission_mode, skipPromptTemplate, undefined, signal,
        targetAgent,
        handoffPromptPrefix,
        { model: toLane.model_override, effort: toLane.effort_override },
      );
    } catch (error) {
      if (isAbortError(error)) throw error;
      console.error('[spawnAgent] Failed to start handoff session:', error);
      return;
    }

    // Post-spawn: link handoff record to the target session.
    const currentTask = tasks.getById(task.id);
    if (currentTask?.session_id) {
      try {
        if (handoffId) {
          const handoffRepo = new HandoffRepository(handoffDb);
          const targetSessionRecord = sessionRepo.getLatestForTask(currentTask.id);
          if (targetSessionRecord) {
            handoffRepo.updateToSession(handoffId, targetSessionRecord.id);
          }
        }
      } catch (error) {
        console.error('[spawnAgent] Failed to finalize handoff:', error);
      }

      if (toLane.auto_command?.trim()) {
        const vars = buildAutoCommandVars(currentTask);
        const interpolated = interpolateTemplate(toLane.auto_command, vars);
        context.commandInjector.schedule(currentTask.id, currentTask.session_id, interpolated, { freshlySpawned: true });
      }
    }

    return;
  }

  // --- Normal path: execute transition actions then fallback ---
  // targetAgent is passed through so spawn_agent actions use the correct agent.

  try {
    await engine.executeTransition(
      task, fromSwimlaneId, toLane.id, toLane.permission_mode, skipPromptTemplate, signal, targetAgent,
      { model: toLane.model_override, effort: toLane.effort_override },
    );
  } catch (error) {
    if (isAbortError(error)) throw error;
    console.error('[spawnAgent] Transition engine error (continuing to fallback):', error);
  }

  let currentTask = tasks.getById(task.id);
  if (!currentTask || currentTask.session_id) return;

  // Fallback: no transition spawned a session - resume or spawn fresh
  console.log(`[spawnAgent] No session after transitions, spawning ${targetAgent} for task ${task.id.slice(0, 8)}`);

  const resumeCheck = checkCanResume(task.id, sessionRepo);
  const resumePrompt = (toLane.auto_command?.trim() && resumeCheck.resumable)
    ? interpolateTemplate(toLane.auto_command, buildAutoCommandVars(currentTask))
    : undefined;

  try {
    // Always pass targetAgent so the column's agent_override is respected.
    // Without this, first-time spawns (task.agent=null, isHandoff=false)
    // would fall through to the project default or 'claude' hardcoded fallback.
    await engine.resumeSuspendedSession(
      currentTask, toLane.permission_mode, skipPromptTemplate, resumePrompt, signal,
      targetAgent,
      undefined,
      { model: toLane.model_override, effort: toLane.effort_override },
    );
  } catch (error) {
    if (isAbortError(error)) throw error;
    console.error('[spawnAgent] Failed to start session:', error);
    return;
  }

  currentTask = tasks.getById(task.id);

  if (currentTask?.session_id && toLane.auto_command?.trim() && !resumePrompt) {
    const vars = buildAutoCommandVars(currentTask);
    const interpolated = interpolateTemplate(toLane.auto_command, vars);
    context.commandInjector.schedule(currentTask.id, currentTask.session_id, interpolated, { freshlySpawned: true });
  }
}

/**
 * Auto-spawn an agent session for a newly created task when the target
 * swimlane has `auto_spawn` enabled. Handles worktree setup, branch checkout,
 * transition engine execution, session resume fallback, and auto-command
 * injection.
 *
 * Called from both the SessionManager `task-created` event (internal MCP
 * bridge) and the external CommandBridge `onTaskCreated` callback.
 */
export async function autoSpawnForTask(
  context: IpcContext,
  projectId: string,
  task: { id: string; title: string },
  swimlaneId: string,
): Promise<void> {
  // Serialize against any other task-lifecycle op (suspend/resume/move/kill)
  // so an MCP-created auto-spawn can't race a user drag of the same task.
  return withTaskLock(task.id, async () => {
    try {
      const db = getProjectDb(projectId);
      const swimlaneRepo = new SwimlaneRepository(db);
      const toLane = swimlaneRepo.getById(swimlaneId);
      if (!toLane?.auto_spawn) return;

      const project = context.projectRepo.getById(projectId);
      const projectPath = project?.path ?? null;
      if (!projectPath) return;

      const { tasks, actions, attachments } = getProjectRepos(context, projectId);
      const fullTask = tasks.getById(task.id);
      if (!fullTask) return;

      try {
        await ensureTaskWorktree(context, fullTask, tasks, projectPath);
      } catch (worktreeError) {
        console.error('[MCP auto-spawn] Worktree creation failed:', worktreeError);
        return;
      }

      // Checkout branch for non-worktree tasks (may fail if another session is active)
      if (fullTask.base_branch && !fullTask.worktree_path) {
        try {
          // Inlined from guardActiveNonWorktreeSessions to avoid circular import with task-move.ts
          const activeSessions = context.sessionManager.listSessions()
            .filter(session => session.taskId !== fullTask.id && (session.status === 'running' || session.status === 'queued'));
          const otherNonWorktreeSessions = activeSessions.filter(session => {
            const otherTask = tasks.getById(session.taskId);
            return otherTask && !otherTask.worktree_path;
          });
          if (otherNonWorktreeSessions.length > 0) {
            throw new Error(
              `Cannot switch to branch '${fullTask.base_branch}': another task is running in the main repo. `
              + `Enable worktree mode for branch isolation.`
            );
          }
          await ensureTaskBranchCheckout(fullTask, projectPath);
        } catch (checkoutError) {
          console.error('[MCP auto-spawn] Branch checkout failed:', checkoutError);
          return;
        }
      }

      const sessionRepo = new SessionRepository(db);
      const engine = createTransitionEngine(context, actions, tasks, sessionRepo, attachments, projectId, projectPath);

      await spawnAgent({ context, engine, tasks, sessionRepo, task: fullTask, fromSwimlaneId: '*', toLane, projectId, projectPath });

      console.log(`[MCP auto-spawn] Spawned agent for "${task.title}" in ${toLane.name}`);
    } catch (err) {
      console.error('[MCP auto-spawn] Failed:', err);
    }
  });
}
