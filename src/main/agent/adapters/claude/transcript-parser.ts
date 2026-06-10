import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TranscriptEntry, TranscriptBlock } from '../../../../shared/types';

// Maximum slug length before Claude Code truncates and appends a hash suffix.
// Matches the `jgH`/`NmK` constant in the shipped CLI (Claude Code 2.x).
const CLAUDE_SLUG_MAX_LENGTH = 200;

/**
 * Java-style string hash (`h = h * 31 + charCode | 0`) over the ORIGINAL,
 * un-sanitized path string. Claude Code uses this to disambiguate slugs that
 * collide after truncation. Reproduced exactly from the shipped CLI.
 */
function claudeStringHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index++) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash = hash | 0;
  }
  return hash;
}

/**
 * Compute Claude Code's `~/.claude/projects/<slug>/` directory name from a cwd.
 *
 * The algorithm was extracted from the shipped Claude Code CLI binary
 * (verified against Claude Code 2.x, 2026-06) and validated against the local
 * transcript directories: replace EVERY non-alphanumeric character with `-`
 * (so `/`, `\`, `:`, `.`, `_`, spaces, and unicode all become `-`); if the
 * result exceeds 200 characters, truncate to 200 and append `-<base36 hash>`
 * where the hash is taken over the original path string.
 *
 * Because both `/` and `\` map to `-`, the slug is separator-agnostic for any
 * path whose sanitized form is at most 200 characters (the overwhelming case).
 */
export function claudeProjectSlug(cwd: string): string {
  const sanitized = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (sanitized.length <= CLAUDE_SLUG_MAX_LENGTH) return sanitized;
  const suffix = Math.abs(claudeStringHash(cwd)).toString(36);
  return `${sanitized.slice(0, CLAUDE_SLUG_MAX_LENGTH)}-${suffix}`;
}

/**
 * Parse Claude Code's native session JSONL into a list of full transcript
 * entries (user prompts, assistant turns with text/thinking/tool_use blocks,
 * and tool results). Runs on demand from the renderer's Transcript tab.
 *
 * Telemetry (tokens, model, events) for Claude comes exclusively from the
 * hook-driven `statusFile` pipeline (status.json + events.jsonl), so this
 * file is the only consumer of the native session JSONL.
 */
export async function parseClaudeTranscript(filePath: string): Promise<TranscriptEntry[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return [];
  }

  const entries: TranscriptEntry[] = [];
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    if (line.length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(raw)) continue;

    const uuid = typeof raw.uuid === 'string' ? raw.uuid : '';
    const ts = parseTimestamp(raw.timestamp);
    const type = raw.type;

    if (type === 'user') {
      const message = raw.message;
      if (!isRecord(message)) continue;
      const messageContent = message.content;

      // String shorthand: pure user prompt.
      if (typeof messageContent === 'string') {
        if (messageContent.length === 0) continue;
        entries.push({ kind: 'user', uuid, ts, text: messageContent });
        continue;
      }

      // Array form: may contain text blocks (user message) and/or
      // tool_result blocks (synthetic user turns the SDK injects after
      // a tool runs).
      if (Array.isArray(messageContent)) {
        const textParts: string[] = [];
        for (const block of messageContent) {
          if (!isRecord(block)) continue;
          if (block.type === 'tool_result') {
            entries.push({
              kind: 'tool_result',
              uuid,
              ts,
              toolUseId: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
              content: stringifyToolResultContent(block.content),
              isError: block.is_error === true,
            });
          } else if (block.type === 'text' && typeof block.text === 'string') {
            textParts.push(block.text);
          }
        }
        if (textParts.length > 0) {
          entries.push({ kind: 'user', uuid, ts, text: textParts.join('\n') });
        }
      }
      continue;
    }

    if (type === 'assistant') {
      const message = raw.message;
      if (!isRecord(message)) continue;
      const model = typeof message.model === 'string' ? message.model : undefined;
      const blocks: TranscriptBlock[] = [];

      const messageContent = message.content;
      if (Array.isArray(messageContent)) {
        for (const block of messageContent) {
          if (!isRecord(block)) continue;
          if (block.type === 'text' && typeof block.text === 'string') {
            blocks.push({ type: 'text', text: block.text });
          } else if (block.type === 'thinking') {
            // Real Claude Code session JSONL never persists thinking text
            // (it stores only an encrypted `signature`). Empty thinking
            // blocks would render as useless empty disclosures, so skip
            // them. Kept the branch in case a future Claude version starts
            // persisting plaintext thinking - then it will be captured.
            if (typeof block.thinking === 'string' && block.thinking.length > 0) {
              blocks.push({ type: 'thinking', text: block.thinking });
            }
          } else if (block.type === 'tool_use') {
            blocks.push({
              type: 'tool_use',
              id: typeof block.id === 'string' ? block.id : '',
              name: typeof block.name === 'string' ? block.name : 'tool',
              input: block.input,
            });
          }
        }
      }

      if (blocks.length === 0) continue;
      entries.push({ kind: 'assistant', uuid, ts, model, blocks });
    }
  }

  return entries;
}

/**
 * Locate the JSONL file for a Claude session given its agent session id
 * and original cwd. Returns null if the file does not exist (no polling -
 * unlike SessionHistoryReader.locate, this is called on demand and the
 * caller already knows the session has run).
 */
export function locateClaudeTranscriptFile(agentSessionId: string, cwd: string): string {
  return path.join(
    os.homedir(),
    '.claude',
    'projects',
    claudeProjectSlug(cwd),
    `${agentSessionId}.jsonl`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTimestamp(value: unknown): number {
  if (typeof value !== 'string') return Date.now();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/**
 * Tool result content can be a plain string or an array of content blocks.
 * Observed shapes in real Claude Code session JSONL:
 *
 * - Plain string (most common, ~97% of tool results)
 * - Array of `text` blocks (e.g. multi-paragraph Bash output)
 * - Array containing `tool_reference` blocks (e.g. ExitPlanMode results
 *   reference the approved tool by name as a sibling to text content)
 * - Array containing `image` blocks (rare, e.g. screenshot tools)
 *
 * Anything else collapses to an empty string. Unknown block types are
 * elided rather than dropped silently so the user can see something
 * happened.
 */
function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block);
      } else if (isRecord(block)) {
        if (block.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text);
        } else if (block.type === 'image') {
          parts.push('[image]');
        } else if (block.type === 'tool_reference' && typeof block.tool_name === 'string') {
          parts.push(`[tool_reference: ${block.tool_name}]`);
        }
      }
    }
    return parts.join('\n');
  }
  return '';
}
