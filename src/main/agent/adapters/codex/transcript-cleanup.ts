/**
 * Codex CLI transcript cleanup.
 *
 * Codex renders a header box (╭╮╰╯│) with model/directory info, then the
 * conversation below it with › prompts and • responses. On every update it
 * redraws the viewport, producing multiple copies.
 *
 * Codex also shows tool execution narration (• I'll..., • Running..., • Ran...)
 * and indented tool output (git status, file paths, JSON, XML) which must be
 * distinguished from actual conversation responses.
 *
 * Markers: › (user prompt), • (assistant response)
 *
 * Strategy:
 * 1. Strip box borders
 * 2. Filter comprehensive noise (spinners, TUI chrome, handoff fragments,
 *    tool narration, tool output)
 * 3. Remove auto-prompts (repeated 3+ times = TUI redraws)
 * 4. Find the last content response and its prompt
 * 5. Dedup response blocks within the prompt section
 */

import { filterNoiseLines, finalizeTranscript } from '../../handoff/transcript-cleanup';

const CODEX_NOISE_PATTERNS: RegExp[] = [
  // ── Spinner/Working indicators ──
  /^[•◦]\s*Working\s*\(/,
  /^[•◦]\s*$/,
  /^[•◦]\w+\s*$/,  // • or ◦ followed by garbled text (no space = not a real response)
  /^\s*\w{1,8}\s*$/,  // Short standalone gibberish from spinner char-by-char redraws

  // ��─ Tips, hints, status bar ──
  /^›\s*Use \/\w+/,
  /^\s*Tip:\s/,
  /gpt-\S+.*·.*%\s*left/,
  /\d+%\s*context\s*left/,
  /tab to queu/,
  /esc\s*to\s*int/,

  // ── Codex banner ──
  /^>_\s*OpenAI Codex/,
  /^model:\s+gpt-/,
  /^directory:\s/,

  // ── Resume/token ──
  /^To continue this session.*codex resume/,
  /^Token usage:\s*total=/,

  // ── Continuation markers ──
  /^\s*↳\s/,
  /^\s*└\s/,
  /^\s*…\s+\+\d+\s+lines/,

  // ── Handoff prompt fragments ──
  // When the long handoff prompt wraps, continuation lines survive auto-prompt removal
  /context is at:/,
  /\.kangentic\/sessions\//,
  /Prior work/,
  /Read this file before continuing/,

  // ── Tool narration (• + first-person action description) ──
  // Codex narrates its tool execution with • prefix, same as real responses.
  // These patterns match narration but not factual answers.
  /^•\s+I[''\u2019]ll\b/,
  /^•\s+I[''\u2019]ve\b/,
  /^•\s+I[''\u2019]m\b/,
  /^•\s+I\s+(?:found|loaded|checked|read|see|noticed|need)\b/i,
  /^•\s+(?:Git|Global)\s/,
  /^•\s+(?:Ran|Running)\s/,
  /^•\s+Here[''\u2019]s what\b/,

  // ── Tool output (indented content from tool execution) ──
  /^\s+['"]?[A-Z]:[\\/]/,        // Windows absolute paths
  /^\s+.*\.git['"/\\\s]/,         // .git references
  /^\s+.*safe\.directory/,        // Git safe directory config
  /^\s+.*Permission denied/,      // Permission errors
  /^\s+.*warning:\s/i,            // Git warnings
  /^\s+.*git config/,             // Git commands
  /^\s+.*is owned by/,            // Git ownership check
  /^\s+.*branch is up to date/,   // Git status
  /^\s*<\/?\w+>\s*$/,             // Standalone XML tags (</handoff> etc.)
  /^\s+"[a-z_]+"\s*:/,            // JSON keys
  /^\s+[{}]\s*$/,                 // JSON braces
  /^\s+tests[/\\]/,               // Test file paths
  /^\s+M\s+\.\w/,                 // Git modified files (  M .file)
  /^\s+\?\?\s+\w/,                // Git untracked files (?? file)
];

/** Codex prompt marker: › followed by content. */
const CODEX_PROMPT = /^›\s+\S/;

/**
 * Codex content response marker: • followed by actual answer content.
 * Excludes tool narration (I'll, I've, Running, Git, etc.) which also uses •.
 * Multiline flag for gap scanning across joined lines.
 */
const CODEX_CONTENT_RESPONSE = /^•\s+(?!I[''\u2019](?:ll|ve|m)\b|I\s+(?:found|loaded|checked|read|see|noticed|need)\b|(?:Working|Running|Ran|Git|Global|Here[''\u2019]s what)\s)/m;

export function cleanCodexTranscript(rawText: string): string | null {
  const lines = rawText.split('\n');
  const processedLines: string[] = [];

  // Step 1: Strip box borders, extract inner content from │...│ lines
  for (const line of lines) {
    const boxMatch = line.match(/^│\s?(.*?)\s*│$/);
    if (boxMatch) {
      const inner = boxMatch[1].trimEnd();
      if (inner) processedLines.push(inner);
      continue;
    }
    processedLines.push(line);
  }

  // Step 2: Filter noise patterns (spinners, TUI chrome, tool narration, tool output)
  const filtered = filterNoiseLines(processedLines, CODEX_NOISE_PATTERNS);

  // Step 3: Remove auto-prompts (prompt text appearing 3+ times = TUI redraws)
  const promptCounts = new Map<string, number>();
  for (const line of filtered) {
    if (CODEX_PROMPT.test(line)) {
      promptCounts.set(line, (promptCounts.get(line) || 0) + 1);
    }
  }
  const autoPrompts = new Set<string>();
  for (const [text, count] of promptCounts) {
    if (count >= 3) autoPrompts.add(text);
  }
  const withoutAutoPrompts = filtered.filter(
    (line) => !autoPrompts.has(line),
  );

  const text = withoutAutoPrompts.join('\n').replace(/\n{3,}/g, '\n\n');
  const cleanLines = text.split('\n');

  // Step 4: Find the last CONTENT response (not tool narration).
  // After noise filtering, any surviving • line should be content,
  // but double-check with the content response pattern.
  let lastContentLine = -1;
  for (let index = cleanLines.length - 1; index >= 0; index--) {
    if (CODEX_CONTENT_RESPONSE.test(cleanLines[index])) {
      lastContentLine = index;
      break;
    }
  }

  if (lastContentLine === -1) return finalizeTranscript(text);

  // Step 5: Find the nearest user prompt before the content response
  let promptStart = -1;
  for (let index = lastContentLine - 1; index >= 0; index--) {
    if (CODEX_PROMPT.test(cleanLines[index])) {
      promptStart = index;
      break;
    }
  }

  // Walk backward to include earlier turns (multi-turn conversation)
  if (promptStart >= 0) {
    for (let index = promptStart - 1; index >= 0; index--) {
      if (CODEX_PROMPT.test(cleanLines[index])) {
        // Check for a content response between this prompt and the next
        const gapText = cleanLines.slice(index, promptStart).join('\n');
        if (CODEX_CONTENT_RESPONSE.test(gapText)) {
          // Content dedup: skip if this prompt text is duplicated later
          const candidateText = cleanLines[index];
          const isDuplicate = cleanLines.slice(index + 1).some(
            (laterLine) => laterLine === candidateText,
          );
          if (isDuplicate) break;
          promptStart = index;
        } else {
          break;
        }
      }
    }
  }

  // Step 6: Extract the conversation, dedup response blocks, strip trailing dupes
  const startLine = promptStart >= 0 ? promptStart : lastContentLine;
  const conversation = cleanLines.slice(startLine).join('\n');
  const deduped = deduplicateResponseBlocks(conversation);
  const trimmed = stripTrailingDuplicateLines(deduped);

  return finalizeTranscript(trimmed);
}

/**
 * Codex redraws the full response on its final render, producing two copies
 * under the same prompt: first the streamed version (with blank lines between
 * items), then the compact final render. Both start with •.
 *
 * For each prompt section (› to next ›), if there are multiple • blocks,
 * keep only the last one (most complete). Different prompts' • blocks are
 * separate turns and must all be kept.
 */
function deduplicateResponseBlocks(text: string): string {
  const lines = text.split('\n');

  // Split into prompt sections: each starts at a › line
  const sections: Array<{ promptLines: string[]; responseBlocks: string[][] }> = [];
  let currentPromptLines: string[] = [];
  let currentResponseBlocks: string[][] = [];
  let currentResponseBlock: string[] | null = null;

  for (const line of lines) {
    if (CODEX_PROMPT.test(line)) {
      // Save previous section if it had responses
      if (currentPromptLines.length > 0 || currentResponseBlocks.length > 0) {
        if (currentResponseBlock) currentResponseBlocks.push(currentResponseBlock);
        sections.push({ promptLines: currentPromptLines, responseBlocks: currentResponseBlocks });
      }
      currentPromptLines = [line];
      currentResponseBlocks = [];
      currentResponseBlock = null;
    } else if (CODEX_CONTENT_RESPONSE.test(line)) {
      // New • block within current prompt section
      if (currentResponseBlock) currentResponseBlocks.push(currentResponseBlock);
      currentResponseBlock = [line];
    } else if (currentResponseBlock) {
      currentResponseBlock.push(line);
    } else {
      currentPromptLines.push(line);
    }
  }
  // Flush last section
  if (currentResponseBlock) currentResponseBlocks.push(currentResponseBlock);
  if (currentPromptLines.length > 0 || currentResponseBlocks.length > 0) {
    sections.push({ promptLines: currentPromptLines, responseBlocks: currentResponseBlocks });
  }

  // Rebuild: for each section, keep prompt + only the LAST • response block
  const result: string[] = [];
  for (const section of sections) {
    result.push(...section.promptLines);
    if (section.responseBlocks.length > 0) {
      result.push(...section.responseBlocks[section.responseBlocks.length - 1]);
    }
  }

  return result.join('\n');
}

/**
 * Strip trailing lines whose content already appeared earlier in the text.
 * Codex TUI redraws append partial response copies (e.g. items 3-5 repeated
 * after the full 1-5 response). Walk backward, removing lines that are
 * duplicates of earlier content. Stop at the first unique line.
 */
function stripTrailingDuplicateLines(text: string): string {
  const lines = text.split('\n');
  let keepCount = lines.length;

  for (let index = lines.length - 1; index > 0; index--) {
    const trimmed = lines[index].trim();
    if (!trimmed) { keepCount = index; continue; }

    // Check if this exact trimmed content appears in an earlier line
    const earlierText = lines.slice(0, index).map((line) => line.trim());
    if (earlierText.includes(trimmed)) {
      keepCount = index;
    } else {
      break;
    }
  }

  return lines.slice(0, keepCount).join('\n');
}
