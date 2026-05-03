/**
 * Qwen Code capability discovery: detect available models and model override support.
 *
 * Qwen Code supports:
 * - `--model <model>` or `-m <model>` flag for model selection
 * - `/model` slash command for live session model switching (interactive picker)
 * - No effort/reasoning levels
 *
 * Models are discovered from:
 * 1. `qwen --help` output (static support detection)
 * 2. Session history in ~/.qwen/projects directory (JSONL files)
 */

import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AgentCapabilities } from '../../../../shared/types';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const HELP_TIMEOUT_MS = 5000;

/**
 * Run `<cliPath> --help` and capture stdout.
 * On Windows, use shell invocation; on Unix, use direct execFile.
 */
async function readHelpText(cliPath: string): Promise<string> {
  if (process.platform === 'win32') {
    const { stdout } = await execAsync(`"${cliPath}" --help`, {
      timeout: HELP_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  }
  const { stdout } = await execFileAsync(cliPath, ['--help'], {
    timeout: HELP_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

/**
 * Parse `qwen --help` to detect if --model flag is supported.
 * Returns true if the help text mentions a --model flag.
 */
async function detectModelFlagSupport(cliPath: string): Promise<boolean> {
  try {
    const helpText = await readHelpText(cliPath);
    // Look for --model or -m flag pattern
    return /--model\s+<|--model\s+[A-Za-z]|-m\s+<|-m\s+[A-Za-z]/.test(helpText);
  } catch {
    // If help fails, assume no model support
    return false;
  }
}

/**
 * Scan Qwen's JSONL session history for observed models.
 * Sessions are stored in `~/.qwen/projects/<project-hash>/chats/<sessionId>.jsonl`
 * (verified empirically against qwen 0.15.3 - flat `chats/` subdirectory,
 * one JSONL file per session, NOT a per-session subdirectory).
 *
 * Models surface on `assistant`-type events at top-level `obj.model`, and
 * on `ui_telemetry` events under `systemPayload.uiEvent.model` (qwen-code's
 * observability stream). We probe both to be schema-drift resilient.
 */
function scanQwenSessionHistory(): string[] {
  const modelSet = new Set<string>();

  try {
    const projectsDir = path.join(os.homedir(), '.qwen', 'projects');
    if (!fs.existsSync(projectsDir)) {
      return [];
    }

    // Rank project directories by their `chats/` subdirectory's mtime so
    // test-artifact dirs (which never write to chats/) are skipped first.
    // Cap at 50 to bound stat cost on heavy installs.
    const dirEntries = fs.readdirSync(projectsDir, { withFileTypes: true });
    const dirs = dirEntries
      .filter(e => e.isDirectory())
      .map(e => {
        const projectRoot = path.join(projectsDir, e.name);
        const chatsPath = path.join(projectRoot, 'chats');
        let chatsMtime = 0;
        try {
          chatsMtime = fs.statSync(chatsPath).mtimeMs;
        } catch {
          // No chats subdir - sort to the back.
        }
        return { fullPath: projectRoot, chatsMtime };
      })
      .filter(e => e.chatsMtime > 0)
      .sort((a, b) => b.chatsMtime - a.chatsMtime)
      .slice(0, 50);

    for (const projectDir of dirs) {
      const chatsDir = path.join(projectDir.fullPath, 'chats');
      let jsonlFiles: { fullPath: string; mtime: number }[] = [];
      try {
        jsonlFiles = fs.readdirSync(chatsDir)
          .filter(f => f.endsWith('.jsonl'))
          .map(f => {
            const fullPath = path.join(chatsDir, f);
            let mtime = 0;
            try { mtime = fs.statSync(fullPath).mtimeMs; } catch { /* skip */ }
            return { fullPath, mtime };
          })
          .sort((a, b) => b.mtime - a.mtime);
      } catch {
        continue;
      }

      // Read up to 3 most-recent session files per project
      for (const { fullPath } of jsonlFiles.slice(0, 3)) {
        try {
          // Only read first 256KB to avoid huge files
          const stats = fs.statSync(fullPath);
          const size = Math.min(stats.size, 256 * 1024);
          const buffer = Buffer.alloc(size);
          const fd = fs.openSync(fullPath, 'r');
          fs.readSync(fd, buffer, 0, size, null);
          fs.closeSync(fd);

          const content = buffer.toString('utf-8');
          for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            try {
              const obj = JSON.parse(line);
              // Top-level: assistant messages carry `model`.
              if (typeof obj.model === 'string' && obj.model.length > 0) {
                modelSet.add(obj.model);
              }
              // ui_telemetry events nest model under systemPayload.uiEvent.
              const systemPayload = (obj as { systemPayload?: unknown }).systemPayload;
              if (systemPayload && typeof systemPayload === 'object') {
                const uiEvent = (systemPayload as { uiEvent?: unknown }).uiEvent;
                if (uiEvent && typeof uiEvent === 'object') {
                  const m = (uiEvent as { model?: unknown }).model;
                  if (typeof m === 'string' && m.length > 0) {
                    modelSet.add(m);
                  }
                }
              }
            } catch {
              // Ignore unparseable lines
            }
          }
        } catch {
          // Ignore file read errors
        }
      }
    }
  } catch {
    // Session history scan is best-effort
  }

  // Ascending alphabetical: groups by family naturally (shared prefix
  // clusters together) and keeps the order consistent across all agents.
  return Array.from(modelSet).sort();
}

/**
 * Discover Qwen Code's capabilities: model override support and available models.
 * Returns:
 * - supportsModelOverride: true if --model flag is supported
 * - models: list of discovered models (from history)
 * - effortLevels: empty array (Qwen has no effort levels)
 *
 * Best-effort: always returns a capabilities object even if detection partially fails.
 */
export async function discoverQwenCapabilities(cliPath: string): Promise<AgentCapabilities> {
  let supportsModelOverride = false;
  try {
    supportsModelOverride = await detectModelFlagSupport(cliPath);
  } catch {
    // Flag detection failure - continue with assumed no support
  }

  // Discover models from session history (best-effort)
  let discoveredModels: string[] = [];
  if (supportsModelOverride) {
    try {
      discoveredModels = scanQwenSessionHistory();
    } catch {
      // Session history scan failure - continue with empty list
    }
  }

  return {
    supportsModelOverride,
    models: discoveredModels.length > 0 ? discoveredModels : undefined,
    // Qwen has no effort levels
    effortLevels: [],
  };
}
