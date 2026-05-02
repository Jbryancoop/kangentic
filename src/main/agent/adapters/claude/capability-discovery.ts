import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentCapabilities } from '../../../../shared/types';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

const HELP_TIMEOUT_MS = 5000;

/**
 * Run `<cliPath> --help` and capture stdout. Mirrors `execVersion`'s Windows
 * vs Unix split: Windows .cmd shims need a shell, Unix can call the binary
 * directly.
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

// Caps for the historical-session scan. The walk runs at agents.list() time
// (cached afterwards) so it must complete quickly even on a heavily-used
// install. These limits trade exhaustive coverage for predictable latency:
// the most-recent N projects/sessions are nearly always representative of
// the models a user picks from.
const MAX_PROJECT_DIRS_TO_SCAN = 30;
const MAX_SESSIONS_PER_PROJECT = 3;
const MAX_BYTES_PER_SESSION_FILE = 256 * 1024;

/**
 * Read up to `lookupBytes` from the head of a JSONL file and collect every
 * distinct `message.model` value found on assistant records, decoding lazily
 * so we never load multi-MB transcripts. Claude's native session JSONLs lead
 * with summary and user records, so we cannot stop at the first line - we
 * iterate until we either run out of head bytes or find at least one
 * assistant turn with a model. Returns an empty set on any read failure.
 */
function readModelsFromHead(filePath: string, lookupBytes: number): Set<string> {
  const found = new Set<string>();
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(lookupBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, lookupBytes, 0);
    const text = buffer.toString('utf-8', 0, bytesRead);
    // Drop the final element after split: the head buffer almost certainly
    // truncated the last line mid-record, and parsing a half-line would
    // throw. Whole-line records still parse correctly because JSONL writes
    // a newline after every record.
    const lines = text.split('\n');
    if (lines.length > 0) lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== 'object') continue;
      const record = parsed as Record<string, unknown>;
      if (record.type !== 'assistant') continue;
      const message = record.message as Record<string, unknown> | undefined;
      if (!message || typeof message.model !== 'string' || message.model.length === 0) continue;
      // Claude Code uses angle-bracket sentinels (e.g. `<synthetic>`) on
      // assistant records that did not come from a real API call - tool
      // result framing, replays, error placeholders. They are not valid
      // values for `--model`, so drop anything wrapped in `<...>`.
      if (message.model.startsWith('<') && message.model.endsWith('>')) continue;
      // Preserve the exact form Claude wrote into the transcript. Empirical
      // probe (scripts/probe-claude-model-forms.js) showed that
      // `claude-haiku-4-5` and `claude-haiku-4-5-20251001` are NOT aliased on
      // the API side - Claude echoes back whatever you pass. Stripping the
      // dated suffix would silently turn a pinned build into "latest", which
      // loses reproducibility for users who want to port back to a specific
      // version.
      found.add(message.model);
    }
  } catch {
    // Read failure - leave the set empty.
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* swallow */ }
    }
  }
  return found;
}

/**
 * Walk Claude Code's native session JSONL store at `~/.claude/projects/` and
 * collect distinct model identifiers from the assistant messages. This gives
 * the user a dropdown populated with models they have actually used, with no
 * configuration needed - a fresh install with zero sessions returns undefined
 * and the renderer falls back to a free-form text input.
 *
 * Bounded: walks the most-recent project dirs and the most-recent session
 * files per dir, reads only a small head of each file, and stops as soon as
 * it finds a model. Returns undefined on any directory listing failure or
 * when no models could be extracted.
 */
function discoverHistoricalModels(): string[] | undefined {
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  let projectDirs: fs.Dirent[];
  try {
    projectDirs = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }

  // Sort projects by directory mtime (proxy for "recently active") so we scan
  // the freshest data first when capped by MAX_PROJECT_DIRS_TO_SCAN.
  const dirEntries = projectDirs
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const fullPath = path.join(projectsRoot, entry.name);
      let mtime = 0;
      try {
        mtime = fs.statSync(fullPath).mtimeMs;
      } catch {
        // Stat failure - keep the entry but sort it to the back.
      }
      return { fullPath, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_PROJECT_DIRS_TO_SCAN);

  const models = new Set<string>();
  for (const projectDir of dirEntries) {
    let sessionFiles: string[];
    try {
      sessionFiles = fs.readdirSync(projectDir.fullPath).filter((name) => name.endsWith('.jsonl'));
    } catch {
      continue;
    }

    const ranked = sessionFiles
      .map((name) => {
        const fullPath = path.join(projectDir.fullPath, name);
        let mtime = 0;
        try {
          mtime = fs.statSync(fullPath).mtimeMs;
        } catch {
          // Skip unreadable files.
        }
        return { fullPath, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, MAX_SESSIONS_PER_PROJECT);

    for (const sessionFile of ranked) {
      // Native Claude session JSONL stores the model on assistant messages
      // under `message.model` (see transcript-parser.ts:92 for the canonical
      // shape). Sessions lead with summary/user records, so we have to scan
      // past those to reach the first assistant turn.
      const fileModels = readModelsFromHead(sessionFile.fullPath, MAX_BYTES_PER_SESSION_FILE);
      for (const modelId of fileModels) models.add(modelId);
    }
  }

  if (models.size === 0) return undefined;
  // Sort descending so newer versions surface first in the picker (e.g.
  // `claude-opus-4-7` before `claude-opus-4-6`). Lexicographic descending
  // is sufficient for Claude's `<family>-<major>-<minor>[-date]` scheme
  // because higher numbers and later date suffixes compare greater. The
  // "Default" entry is prepended by the renderer separately.
  return Array.from(models).sort((a, b) => b.localeCompare(a));
}

/**
 * Parse the `--help` output of the live CLI for the static capability bits:
 * effort levels (enumerated in the help text) and `--model` flag presence.
 * These do not change between dialog opens for a given binary, so callers
 * cache the result keyed by `cliPath`. Returns an empty object on any read
 * or parse failure so the rest of detection can still succeed.
 */
export async function discoverClaudeStaticCapabilities(cliPath: string): Promise<AgentCapabilities> {
  let helpText: string;
  try {
    helpText = await readHelpText(cliPath);
  } catch {
    return {};
  }

  const capabilities: AgentCapabilities = {};

  // The `--effort` line in Claude Code's help output looks like:
  //   --effort <level>     Effort level for the current session (low, medium, high, xhigh, max)
  // The parenthesized choice list is the source of truth - parse it directly
  // so any future addition (e.g. a new "ultra" level) shows up automatically.
  const effortMatch = helpText.match(/--effort\s+<[^>]+>\s+[^(\n]*\(([^)]+)\)/);
  if (effortMatch) {
    const levels = effortMatch[1]
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (levels.length > 0) capabilities.effortLevels = levels;
  }

  // The `--model` flag is documented in --help but its valid values are
  // open-ended (aliases plus full model IDs). We only record presence here;
  // the enumerable model list is discovered separately from session history
  // so the dropdown picks up newly-used models without restarting Kangentic.
  if (/--model\s+<[^>]+>/.test(helpText)) {
    capabilities.supportsModelOverride = true;
  }

  return capabilities;
}

/**
 * Live scan of the user's `~/.claude/projects/` session store. Always runs
 * fresh (no cache) so the dropdown picks up models the user just used in
 * another window since the last time the dialog opened. Returns undefined
 * when the store is missing or no models could be extracted, in which case
 * the renderer falls back to a free-form text input.
 */
export function rescanClaudeModels(): string[] | undefined {
  return discoverHistoricalModels();
}

/**
 * Discover Claude Code's full runtime capabilities by combining the cached
 * static bits with a fresh model rescan. Used by the IPC layer when no
 * caller-managed cache exists - tests and ad-hoc callers.
 */
export async function discoverClaudeCapabilities(cliPath: string): Promise<AgentCapabilities> {
  const capabilities = await discoverClaudeStaticCapabilities(cliPath);
  if (capabilities.supportsModelOverride) {
    const models = rescanClaudeModels();
    if (models) capabilities.models = models;
  }
  return capabilities;
}
