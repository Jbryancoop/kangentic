/**
 * Codex CLI capability discovery: detect available models and model override support.
 *
 * Codex supports:
 * - `--model <model>` or `-m <model>` flag for model selection
 * - `model_reasoning_effort` config in config.toml (config-file only, not CLI)
 * - No documented live `/model` slash command
 *
 * Models are discovered from:
 * 1. `codex --help` output (static support detection)
 * 2. Session history in ~/.codex/sessions directory (JSONL init events + turn_context)
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
 * Parse `codex --help` to detect if --model flag is supported.
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
 * Scan Codex's JSONL session history for observed models.
 * Sessions are stored in `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl`
 * (verified against codex 0.128.0 - three levels of date directories).
 *
 * The model field lives on `turn_context` events at `payload.model`.
 * `session_meta` does NOT carry the model in current Codex - if it did
 * historically, the broader `payload.model` check below still picks it
 * up so the parser is forward-compatible.
 */
function listMostRecentDirs(parent: string, maxEntries: number): string[] {
  const entries = fs.readdirSync(parent, { withFileTypes: true });
  return entries
    .filter(e => e.isDirectory())
    .sort((a, b) => {
      const aTime = fs.statSync(path.join(parent, a.name)).mtimeMs;
      const bTime = fs.statSync(path.join(parent, b.name)).mtimeMs;
      return bTime - aTime;
    })
    .slice(0, maxEntries)
    .map(e => e.name);
}

function scanCodexSessionHistory(): string[] {
  const modelSet = new Set<string>();

  try {
    const sessionsDir = path.join(os.homedir(), '.codex', 'sessions');
    if (!fs.existsSync(sessionsDir)) {
      return [];
    }

    // Walk YYYY/MM/DD/. Cap each level so a long-running install doesn't
    // pay an unbounded scan cost.
    const yearDirs = listMostRecentDirs(sessionsDir, 2);
    for (const year of yearDirs) {
      const yearPath = path.join(sessionsDir, year);
      let monthDirs: string[];
      try {
        monthDirs = listMostRecentDirs(yearPath, 3);
      } catch {
        continue;
      }
      for (const month of monthDirs) {
        const monthPath = path.join(yearPath, month);
        let dayDirs: string[];
        try {
          dayDirs = listMostRecentDirs(monthPath, 5);
        } catch {
          continue;
        }
        for (const day of dayDirs) {
          const dayPath = path.join(monthPath, day);
          let files: string[];
          try {
            files = fs.readdirSync(dayPath).filter(f => f.endsWith('.jsonl'));
          } catch {
            continue;
          }
          // Read up to 3 most recent JSONL files per day
          const ranked = files
            .map(name => {
              const fullPath = path.join(dayPath, name);
              let mtime = 0;
              try { mtime = fs.statSync(fullPath).mtimeMs; } catch { /* skip */ }
              return { fullPath, mtime };
            })
            .sort((a, b) => b.mtime - a.mtime)
            .slice(0, 3);

          for (const { fullPath } of ranked) {
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
                  // Codex 0.128.0+: `turn_context` events carry
                  // `payload.model`. Older builds may have placed it on
                  // `session_meta`; checking any event with
                  // `payload.model` covers both shapes without us having
                  // to enumerate event types.
                  const payload = (obj as { payload?: unknown }).payload;
                  if (payload && typeof payload === 'object') {
                    const model = (payload as { model?: unknown }).model;
                    if (typeof model === 'string' && model.length > 0) {
                      modelSet.add(model);
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
 * Discover Codex's capabilities: model override support and available models.
 * Returns:
 * - supportsModelOverride: true if --model flag is supported
 * - models: list of discovered models (from history)
 * - effortLevels: empty array (Codex effort is config-file only, not CLI)
 *
 * Best-effort: always returns a capabilities object even if detection partially fails.
 */
export async function discoverCodexCapabilities(cliPath: string): Promise<AgentCapabilities> {
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
      discoveredModels = scanCodexSessionHistory();
    } catch {
      // Session history scan failure - continue with empty list
    }
  }

  return {
    supportsModelOverride,
    models: discoveredModels.length > 0 ? discoveredModels : undefined,
    // Codex effort/reasoning is config-file only (config.toml: model_reasoning_effort)
    // No CLI flag, so effortLevels is always empty
    effortLevels: [],
  };
}
