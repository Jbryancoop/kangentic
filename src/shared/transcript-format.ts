import type { TranscriptEntry } from './types';
import { sanitizeTranscriptText } from './ansi-strip';

/**
 * Format a parsed transcript as a markdown document suitable for pasting
 * into issues, PRs, chat, or for handing off as cross-agent context. Tool
 * results are inlined under their owning tool_use block by id; any tool
 * result whose owning tool_use is not present (orphaned, e.g. after a resume
 * or compaction) is surfaced in a trailing section instead of being dropped.
 *
 * All rendered content is run through `sanitizeTranscriptText` so terminal
 * escape sequences or stray control bytes captured inside tool output never
 * leak into the markdown.
 *
 * Lives in `shared/` because both the renderer (Transcript tab copy button)
 * and the main process (MCP `get_transcript` structured format) call it.
 */
export function transcriptToMarkdown(entries: TranscriptEntry[]): string {
  const resultsByUseId = new Map<string, { content: string; isError: boolean }>();
  for (const entry of entries) {
    if (entry.kind === 'tool_result' && entry.toolUseId) {
      resultsByUseId.set(entry.toolUseId, { content: entry.content, isError: !!entry.isError });
    }
  }

  // Track which tool_use ids actually appear in an assistant turn so we can
  // detect tool_result entries with no owner and render them rather than
  // silently dropping them.
  const renderedUseIds = new Set<string>();

  const sections: string[] = [];
  for (const entry of entries) {
    if (entry.kind === 'tool_result') continue;
    if (entry.kind === 'system') {
      sections.push(renderSystemEntry(entry.subtype, entry.text));
      continue;
    }
    if (entry.kind === 'user') {
      sections.push(`## User\n\n${sanitizeTranscriptText(entry.text).trim()}`);
      continue;
    }
    // assistant
    const parts: string[] = [];
    parts.push(entry.model ? `## Assistant (${entry.model})` : '## Assistant');
    parts.push('');
    for (const block of entry.blocks) {
      if (block.type === 'text') {
        parts.push(sanitizeTranscriptText(block.text).trim());
        parts.push('');
      } else if (block.type === 'thinking') {
        parts.push('> _thinking_');
        parts.push('');
        parts.push(`> ${sanitizeTranscriptText(block.text).trim().split('\n').join('\n> ')}`);
        parts.push('');
      } else if (block.type === 'tool_use') {
        renderedUseIds.add(block.id);
        parts.push(`**Tool:** \`${block.name}\``);
        parts.push('');
        parts.push('```json');
        parts.push(safeJson(block.input));
        parts.push('```');
        const result = resultsByUseId.get(block.id);
        if (result) {
          parts.push('');
          parts.push(result.isError ? '**Error:**' : '**Result:**');
          parts.push('');
          parts.push('```');
          parts.push(sanitizeTranscriptText(result.content));
          parts.push('```');
        }
        parts.push('');
      }
    }
    sections.push(parts.join('\n').trimEnd());
  }

  // Surface orphaned tool results (a tool_use id never emitted in this file)
  // in a trailing section so the content is visible instead of dropped.
  const orphans = entries.filter(
    (entry): entry is Extract<TranscriptEntry, { kind: 'tool_result' }> =>
      entry.kind === 'tool_result' && (!entry.toolUseId || !renderedUseIds.has(entry.toolUseId)),
  );
  if (orphans.length > 0) {
    const orphanParts: string[] = ['## Orphaned tool results', ''];
    for (const orphan of orphans) {
      const label = orphan.toolUseId ? `\`${orphan.toolUseId}\`` : '(unknown tool)';
      orphanParts.push(orphan.isError ? `**Error for ${label}:**` : `**Result for ${label}:**`);
      orphanParts.push('');
      orphanParts.push('```');
      orphanParts.push(sanitizeTranscriptText(orphan.content));
      orphanParts.push('```');
      orphanParts.push('');
    }
    sections.push(orphanParts.join('\n').trimEnd());
  }

  return sections.join('\n\n').trim() + '\n';
}

/** Render a `kind: 'system'` transcript entry as a markdown section. */
function renderSystemEntry(
  subtype: 'compaction' | 'command' | 'command_output',
  text: string,
): string {
  const clean = sanitizeTranscriptText(text).trim();
  if (subtype === 'compaction') {
    return `## Conversation compacted\n\n${clean}`;
  }
  if (subtype === 'command') {
    return `\`[command: ${clean}]\``;
  }
  // command_output
  return `**Command output:**\n\n\`\`\`\n${clean}\n\`\`\``;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
