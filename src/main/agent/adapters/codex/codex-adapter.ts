import { CodexDetector } from './detector';
import { CodexCommandBuilder } from './command-builder';
import { removeHooks as removeCodexHooks } from './hook-manager';
import { CodexSessionHistoryParser } from './session-history-parser';
import { CodexStatusParser } from './status-parser';
import { discoverCodexCapabilities } from './capability-discovery';
import { runCliPrintSummarize, buildSummarizePrompt } from '../../shared/auto-name';
import type { AgentAdapter, AgentInfo, SpawnCommandOptions, SettingsChangeSpec } from '../../agent-adapter';
import type { AgentPermissionEntry, PermissionMode, AdapterRuntimeStrategy, SubmissionContextType, SubmissionVerifier, AgentCapabilities } from '../../../../shared/types';
import { ActivityDetection } from '../../../../shared/types';

/**
 * Codex CLI adapter - wraps CodexDetector, CodexCommandBuilder, and
 * codex-hook-manager behind the generic AgentAdapter interface.
 */
export class CodexAdapter implements AgentAdapter {
  readonly name = 'codex';
  readonly displayName = 'Codex CLI';
  readonly sessionType = 'codex_agent';
  readonly supportsCallerSessionId = false;
  readonly permissions: AgentPermissionEntry[] = [
    { mode: 'plan', label: 'Safe Read-Only Browsing' },
    { mode: 'dontAsk', label: 'Read-Only Non-Interactive (CI)' },
    { mode: 'default', label: 'Automatically Edit, Ask for Untrusted' },
    { mode: 'acceptEdits', label: 'Auto (Preset)' },
    { mode: 'bypassPermissions', label: 'Dangerous Full Access' },
  ];
  readonly defaultPermission: PermissionMode = 'acceptEdits';

  private readonly detector = new CodexDetector();
  private readonly commandBuilder = new CodexCommandBuilder();
  // Set of taskIds currently holding hook injections per project root.
  // Codex writes hooks to a project-shared `.codex/hooks.json`, so we must
  // avoid stripping hooks while another concurrent session still needs
  // them. See GeminiAdapter.hookHolders for the same pattern. Note: Codex
  // 0.118 does not honor `.codex/hooks.json` in practice today, but the
  // refcount is kept for forward compatibility with future Codex versions
  // that may enable the hook pipeline.
  private readonly hookHolders = new Map<string, Set<string>>();

  async detect(overridePath?: string | null): Promise<AgentInfo> {
    return this.detector.detect(overridePath);
  }

  invalidateDetectionCache(): void {
    this.detector.invalidateCache();
  }

  async ensureTrust(_workingDirectory: string): Promise<void> {
    // Codex does not have a trust dialog - no pre-approval needed.
  }

  buildCommand(options: SpawnCommandOptions): string {
    const { agentPath, model, effort, ...rest } = options;
    const command = this.commandBuilder.buildCodexCommand({
      codexPath: agentPath,
      model,
      effort,
      ...rest,
    });
    // buildCodexCommand writes hooks into .codex/hooks.json whenever
    // eventsOutputPath is present. Retain a reference keyed by the
    // project root (same key removeHooks uses) so concurrent sessions
    // serialize their cleanup.
    if (options.eventsOutputPath) {
      const projectRoot = options.projectRoot || options.cwd;
      this.retainHooks(projectRoot, options.taskId);
    }
    return command;
  }

  private retainHooks(directory: string, taskId: string): void {
    let holders = this.hookHolders.get(directory);
    if (!holders) {
      holders = new Set<string>();
      this.hookHolders.set(directory, holders);
    }
    holders.add(taskId);
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return this.commandBuilder.interpolateTemplate(template, variables);
  }

  /**
   * Runtime strategy: how Codex exposes activity state and session IDs.
   *
   * - Activity: PTY silence timer as fallback. The sessionHistory hook
   *   below provides authoritative task_started/task_complete events
   *   from the rollout JSONL; the PTY tracker is suppressed once the
   *   first history event arrives.
   * - Session ID (fromHook): CODEX_THREAD_ID env var (openai/codex#10096)
   *   captured via hook-manager's `env:thread_id=CODEX_THREAD_ID` directive.
   * - Session ID (fromOutput): Codex v0.118+ prints "session id: <uuid>" in
   *   the startup header; older versions printed "codex resume thr_..." at exit.
   *   This UUID is used to locate the rollout file on disk.
   * - sessionHistory: tails ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*-<id>.jsonl
   *   for real-time model, context window, and token counts. See CodexSessionHistoryParser.
   */
  readonly runtime: AdapterRuntimeStrategy = {
    // Hook-driven events.jsonl pipeline. Codex has no status line
    // (parseStatus returns null), but the event-bridge hook output is
    // parsed via parseEvent so tool_start/idle events drive activity
    // transitions when hooks fire. Codex 0.118 does not honor
    // .codex/hooks.json, but newer versions may - this wiring ensures
    // hook events flow into the state machine when available.
    statusFile: {
      parseStatus: CodexStatusParser.parseStatus,
      parseEvent: CodexStatusParser.parseEvent,
      isFullRewrite: false,
    },
    // Codex idle detection: silence timer only (no detectIdle callback).
    //
    // The `›` (U+203A) guillemet is NOT idle-specific - it's always visible
    // in the Codex Ink TUI's prompt area, even during active tool execution.
    // Using it for detectIdle causes false idle transitions during active
    // work (state oscillates thinking↔idle on every frame). Empirically
    // verified: Codex goes completely SILENT when idle (no TUI redraws),
    // so the 10-second silence timer in PtyActivityTracker fires reliably.
    //
    // Content deduplication in SessionManager provides an agent-agnostic
    // safety net: if any TUI agent does continuously redraw, repeated
    // frames with identical stripped text are filtered automatically.
    activity: ActivityDetection.pty(),
    sessionId: {
      fromHook(hookContext) {
        try {
          const context = JSON.parse(hookContext);
          const threadId = context.thread_id ?? context.threadId;
          if (typeof threadId === 'string') {
            console.log(`[codex] Captured thread ID from hook: ${threadId.slice(0, 16)}...`);
            return threadId;
          }
          console.warn(`[codex] SessionStart hookContext missing thread_id. Keys: ${Object.keys(context).join(', ')}`);
          return null;
        } catch {
          console.warn('[codex] Failed to parse SessionStart hookContext');
          return null;
        }
      },
      fromOutput(data) {
        const headerMatch = data.match(/session id:\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
        if (headerMatch) return headerMatch[1];
        const resumeMatch = data.match(/codex\s+resume\s+(thr_\S+)/);
        return resumeMatch ? resumeMatch[1] : null;
      },
      // Codex 0.118 neither prints the session UUID in PTY output nor
      // fires `.codex/hooks.json` (both verified empirically - see the
      // fixtures in tests/fixtures/agent-pty/codex.txt). The only
      // source-of-truth for the session ID is the rollout JSONL file
      // Codex writes synchronously at session start. This scan is
      // what actually captures the ID on real spawns today.
      fromFilesystem: CodexSessionHistoryParser.captureSessionIdFromFilesystem,
    },
    sessionHistory: {
      locate: CodexSessionHistoryParser.locate,
      parse: CodexSessionHistoryParser.parse,
      isFullRewrite: false,
    },
  };

  removeHooks(directory: string, taskId?: string): void {
    const holders = this.hookHolders.get(directory);
    if (holders && taskId) {
      holders.delete(taskId);
      if (holders.size > 0) {
        // Another session in this directory still needs the hooks.
        return;
      }
      this.hookHolders.delete(directory);
    }
    removeCodexHooks(directory);
  }

  getSubmissionVerifier(_contextType: SubmissionContextType): SubmissionVerifier | null {
    // Codex declares a UserPromptSubmit hook that emits EventType.Prompt, but
    // Codex 0.118 does not actually honor `.codex/hooks.json` in practice.
    // Callers fall back to time-based settle (paste) or time-settle (command-injection).
    return null;
  }

  clearSettingsCache(): void {
    // No settings cache to clear - Codex uses config.toml, not merged
    // settings files.
  }

  getExitSequence(): string[] {
    // Codex sessions are API-backed (server-side threads) - no local
    // conversation state to flush. Ctrl+C is sufficient.
    return ['\x03'];
  }

  detectFirstOutput(data: string): boolean {
    // Codex CLI hides the cursor when its TUI takes over the terminal.
    // Detecting ESC[?25l fires after the shell prompt noise but before
    // the TUI draws the startup banner. This keeps the shell command
    // hidden behind the shimmer overlay.
    return data.includes('\x1b[?25l');
  }

  async locateSessionHistoryFile(agentSessionId: string, cwd: string): Promise<string | null> {
    return CodexSessionHistoryParser.locate({ agentSessionId, cwd });
  }

  async discoverCapabilities(cliPath: string): Promise<AgentCapabilities> {
    return discoverCodexCapabilities(cliPath);
  }

  getInjectionSequence(_spec: SettingsChangeSpec): string[] {
    // Codex does not support live `/model` or `/reasoning-effort` slash commands.
    // Model/effort changes require respawn (handled by task-move.ts fallback).
    return [];
  }

  async summarize(prompt: string, cliPath: string, cwd: string): Promise<string> {
    // `codex exec` runs non-interactively. The `--skip-git-repo-check` flag avoids
    // failing in non-git working directories. Prompt is delivered via stdin.
    return runCliPrintSummarize({
      cliPath,
      args: ['exec', '--skip-git-repo-check'],
      prompt: buildSummarizePrompt(prompt),
      cwd,
    });
  }
}
