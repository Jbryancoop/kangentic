import type { BrowserWindow } from 'electron';
import type { ProjectRepository } from '../db/repositories/project-repository';
import type { ProjectGroupRepository } from '../db/repositories/project-group-repository';
import type { SessionManager } from '../pty/session-manager';
import type { ConfigManager } from '../config/config-manager';
import type { BoardConfigManager } from '../config/board-config-manager';
import type { GitDetector } from '../git/git-detector';
import type { ShellResolver } from '../pty/spawn/shell-resolver';
import type { CommandInjector } from '../engine/command-injector';
import type { PasteEngine } from '../pty/paste-engine';
import type { McpHttpServerHandle } from '../agent/mcp-http-server';

export interface IpcContext {
  mainWindow: BrowserWindow;
  projectRepo: ProjectRepository;
  projectGroupRepo: ProjectGroupRepository;
  sessionManager: SessionManager;
  configManager: ConfigManager;
  boardConfigManager: BoardConfigManager;
  gitDetector: GitDetector;
  shellResolver: ShellResolver;
  commandInjector: CommandInjector;
  /**
   * Deterministic text-paste-and-submit primitive used by the embedded
   * browser pane (and slated to replace the wall-clock submit chains in
   * `CommandInjector` in a follow-up).
   */
  pasteEngine: PasteEngine;
  currentProjectId: string | null;
  currentProjectPath: string | null;
  /**
   * In-process MCP HTTP server handle. Set once at app startup before
   * any project opens; null only during the brief startup window before
   * the server has bound its port.
   */
  mcpServerHandle: McpHttpServerHandle | null;
}
