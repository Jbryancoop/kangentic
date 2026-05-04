export { getProjectRepos } from './project-repos';
export { ensureGitignore } from './project-setup';
export { ensureTaskWorktree, ensureTaskBranchCheckout } from './task-git';
export { buildAutoCommandVars, createTransitionEngine, spawnAgent, autoSpawnForTask, resolveSpawnOverrides } from './agent-spawn';
export type { AgentSpawnOptions } from './agent-spawn';
export { cleanupTaskSession, cleanupTaskResources, deleteTaskWorktree } from './task-cleanup';
