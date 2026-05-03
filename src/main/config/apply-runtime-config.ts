import type { SessionManager } from '../pty/session-manager';
import type { ConfigManager } from './config-manager';

/**
 * Push the effective config for `projectPath` into all in-memory services
 * that cache config-derived state. This is the SINGLE place to update when a
 * new runtime-effective setting is added - every IPC handler that mutates
 * config (`config:set`, `config:setProject`, `config:setProjectByPath`,
 * `config:syncDefaultToProjects`) and every project-open path calls this so
 * the running app never lags the config file on disk.
 *
 * Pass `null` for `projectPath` for project-agnostic global updates - the
 * effective config falls back to the global file in that case.
 */
export function applyRuntimeConfig(
  sessionManager: SessionManager,
  configManager: ConfigManager,
  projectPath: string | null,
): void {
  const effective = configManager.getEffectiveConfig(projectPath || undefined);
  sessionManager.setMaxConcurrent(effective.agent.maxConcurrentSessions);
  sessionManager.setShell(effective.terminal.shell);
  sessionManager.setIdleTimeout(effective.agent.idleTimeoutMinutes);
}
