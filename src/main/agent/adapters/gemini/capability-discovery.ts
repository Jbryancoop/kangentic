/**
 * Google Gemini CLI capability discovery: detect available models and model override support.
 *
 * Gemini supports:
 * - `--model <model>` or `-m <model>` flag for model selection
 * - `/model` slash command for live session model switching
 * - No effort/reasoning levels (not a separate concept)
 *
 * Models are discovered from:
 * 1. `gemini --help` output (static support detection)
 * 2. Session history in ~/.gemini/tmp directory (JSON files with chat content)
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
 * Parse `gemini --help` to detect if --model flag is supported.
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
 * Scan Gemini's session history for observed models.
 * Sessions are stored in ~/.gemini/tmp/<basename(cwd)>/chats/ with session-*.json files.
 *
 * Each JSON file contains chat history and metadata including model selection.
 */
function scanGeminiSessionHistory(): string[] {
  const models: string[] = [];
  const modelSet = new Set<string>();

  try {
    const tmpDir = path.join(os.homedir(), '.gemini', 'tmp');
    if (!fs.existsSync(tmpDir)) {
      return [];
    }

    // Walk the project directories, ranking by the `chats/` subdirectory's
    // mtime rather than the project root. This keeps test-artifact dirs
    // (which never get a `chats/` written to them) from monopolizing the
    // top-N slots and pushing real sessions out of scan range. Cap at 50
    // to keep total stat cost bounded on installs with thousands of
    // project dirs (we read at most 3 files per dir, 256KB each, so the
    // wall-time cost is dominated by directory walking).
    let projectDirs: string[] = [];
    try {
      const dirEntries = fs.readdirSync(tmpDir, { withFileTypes: true });
      projectDirs = dirEntries
        .filter(e => e.isDirectory())
        .map(e => {
          const projectRoot = path.join(tmpDir, e.name);
          const chatsPath = path.join(projectRoot, 'chats');
          let chatsMtime = 0;
          try {
            chatsMtime = fs.statSync(chatsPath).mtimeMs;
          } catch {
            // No chats subdir - sort to the back so dirs that have actually
            // hosted Gemini sessions are scanned first.
          }
          return { fullPath: projectRoot, chatsMtime };
        })
        .filter(e => e.chatsMtime > 0)
        .sort((a, b) => b.chatsMtime - a.chatsMtime)
        .slice(0, 50)
        .map(e => e.fullPath);
    } catch {
      return [];
    }

    // Scan each project directory for chat session files. Gemini ships
    // both `.json` (single-document) and `.jsonl` (newline-delimited) for
    // its session history; the schema for both has model on each
    // gemini-typed message under `.model`. We accept both so the scan
    // does not regress when Gemini changes its on-disk format.
    for (const projectDir of projectDirs) {
      const chatsDir = path.join(projectDir, 'chats');
      let sessionFiles: { fullPath: string; mtime: number }[] = [];
      try {
        sessionFiles = fs.readdirSync(chatsDir)
          .filter(f => f.startsWith('session-') && (f.endsWith('.json') || f.endsWith('.jsonl')))
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

      // Read up to 3 most recent session files per directory
      for (const { fullPath } of sessionFiles.slice(0, 3)) {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');

          if (fullPath.endsWith('.jsonl')) {
            // Newline-delimited: each line is a record. Look at every
            // line for `model` at top level or inside `messages[]`.
            for (const line of content.split('\n')) {
              if (!line.trim()) continue;
              try {
                const obj = JSON.parse(line);
                if (obj.model && typeof obj.model === 'string') {
                  modelSet.add(obj.model);
                }
                if (Array.isArray(obj.messages)) {
                  for (const msg of obj.messages) {
                    if (msg.model && typeof msg.model === 'string') {
                      modelSet.add(msg.model);
                    }
                  }
                }
              } catch {
                // Ignore unparseable lines
              }
            }
          } else {
            // Single-document JSON
            const obj = JSON.parse(content);
            if (obj.model && typeof obj.model === 'string') {
              modelSet.add(obj.model);
            }
            if (Array.isArray(obj.messages)) {
              for (const msg of obj.messages) {
                if (msg.model && typeof msg.model === 'string') {
                  modelSet.add(msg.model);
                }
              }
            }
          }
        } catch {
          // Ignore file read/parse errors
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
 * Discover Gemini's capabilities: model override support and available models.
 * Returns:
 * - supportsModelOverride: true if --model flag is supported
 * - models: list of discovered models (from history)
 * - effortLevels: empty array (Gemini doesn't have effort levels)
 *
 * Best-effort: always returns a capabilities object even if detection partially fails.
 */
export async function discoverGeminiCapabilities(cliPath: string): Promise<AgentCapabilities> {
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
      discoveredModels = scanGeminiSessionHistory();
    } catch {
      // Session history scan failure - continue with empty list
    }
  }

  return {
    supportsModelOverride,
    models: discoveredModels.length > 0 ? discoveredModels : undefined,
    // Gemini does not have separate effort levels
    effortLevels: [],
  };
}
