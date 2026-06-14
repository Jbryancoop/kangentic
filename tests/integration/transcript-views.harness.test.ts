/**
 * Local confirmation harness for the cross-agent transcript views
 * (kangentic_get_transcript: view / tail / search / maxChars budget).
 *
 * Lives in tests/integration (opt-in, NOT part of `npm run test:unit`) because
 * the real-data section reads the local machine's Claude session history. Run
 * it explicitly:
 *
 *   npx vitest run tests/integration/transcript-views.harness.test.ts
 *
 * Two sections:
 *
 * 1. Synthetic (always runs): a deterministic transcript with the same shape
 *    real sessions have (text answers buried under thinking + large tool
 *    output). Asserts the view/search/budget invariants and logs the char
 *    counts so the token reduction is visible.
 *
 * 2. Real Claude session (auto-skips when none is found): discovers the
 *    largest `*.jsonl` under `~/.claude/projects/` via os.homedir() (no
 *    hardcoded paths), parses it with the SAME parser the MCP handler uses,
 *    and reports full-vs-responses-vs-result-vs-budget sizes on real data.
 *
 * The MCP handler's orchestration (session resolution, framing note, raw
 * nudge, edge messages) is covered separately by
 * tests/unit/inspect-commands.test.ts; this harness confirms the
 * agent-agnostic rendering pipeline that handler composes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  transcriptToMarkdown,
  filterTranscriptView,
  searchTranscript,
  renderTranscriptBudgeted,
  TRANSCRIPT_CHAR_BUDGET,
} from '../../src/shared/transcript-format';
import { parseClaudeTranscript } from '../../src/main/agent/adapters/claude/transcript-parser';
import type { TranscriptEntry } from '../../src/shared/types';

function pct(part: number, whole: number): string {
  if (whole === 0) return '0%';
  return `${((part / whole) * 100).toFixed(1)}%`;
}

/** A transcript shaped like a real session: small text answers buried under
 *  thinking blocks and large tool output (the bulk of the tokens). */
function syntheticSession(turns: number): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (let index = 0; index < turns; index++) {
    entries.push({ kind: 'user', uuid: `u${index}`, ts: index * 10, text: `Please do step ${index}` });
    entries.push({
      kind: 'assistant',
      uuid: `a${index}`,
      ts: index * 10 + 1,
      blocks: [
        { type: 'thinking', text: `Considering the approach for step ${index}. `.repeat(20) },
        { type: 'text', text: `Done with step ${index}: applied the change and verified it.` },
        { type: 'tool_use', id: `t${index}`, name: 'Bash', input: { command: `run-step-${index}` } },
      ],
    });
    entries.push({
      kind: 'tool_result',
      uuid: `r${index}`,
      ts: index * 10 + 2,
      toolUseId: `t${index}`,
      content: `tool output line for step ${index}\n`.repeat(40),
    });
  }
  return entries;
}

describe('transcript views - synthetic confirmation', () => {
  const entries = syntheticSession(20);

  it('views shrink output toward just the answers, and counts are honest', () => {
    const full = transcriptToMarkdown(entries);
    const responses = transcriptToMarkdown(filterTranscriptView(entries, 'responses'));
    const result = transcriptToMarkdown(filterTranscriptView(entries, 'result'));

    console.log('[synthetic] entries:', entries.length);
    console.log('[synthetic] full chars:', full.length);
    console.log('[synthetic] responses chars:', responses.length, `(${pct(responses.length, full.length)} of full)`);
    console.log('[synthetic] result chars:', result.length, `(${pct(result.length, full.length)} of full)`);

    // The whole point: dropping tool/thinking noise is a large reduction.
    expect(responses.length).toBeLessThan(full.length * 0.5);
    // result (one final answer) is a subset of responses (all answers).
    expect(result.length).toBeLessThanOrEqual(responses.length);
    // No tool output leaks into the responses view.
    expect(responses).not.toContain('tool output line');
    expect(responses).toContain('applied the change');
  });

  it('search returns only the matching turns', () => {
    const matched = searchTranscript(entries, 'step 7');
    const rendered = transcriptToMarkdown(matched);
    console.log('[synthetic] search "step 7": matched entries', matched.length);
    expect(rendered).toContain('step 7');
    expect(rendered).not.toContain('Done with step 3');
  });

  it('the size budget keeps the most recent entries with honest omission counts', () => {
    const budgeted = renderTranscriptBudgeted(entries, { charBudget: 5000 });
    console.log(
      '[synthetic] budget(5k): rendered',
      budgeted.renderedEntries,
      'of',
      budgeted.totalEntries,
      '| omittedByBudget',
      budgeted.omittedByBudget,
      '| chars',
      budgeted.markdown.length,
      '| truncated',
      budgeted.truncated,
    );
    expect(budgeted.truncated).toBe(true);
    expect(budgeted.markdown.length).toBeLessThanOrEqual(5000 + 500);
    // Most recent kept, oldest dropped.
    expect(budgeted.markdown).toContain('step 19');
    expect(budgeted.markdown).not.toContain('step 0');
  });
});

// --- Real Claude session (opt-in, auto-skips when none is found) ---

function discoverLargestClaudeJsonl(): string | null {
  try {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(projectsDir)) return null;
    let best: { filePath: string; size: number } | null = null;
    for (const slug of fs.readdirSync(projectsDir)) {
      const slugDir = path.join(projectsDir, slug);
      let slugStat: fs.Stats;
      try {
        slugStat = fs.statSync(slugDir);
      } catch {
        continue;
      }
      if (!slugStat.isDirectory()) continue;
      let fileNames: string[];
      try {
        fileNames = fs.readdirSync(slugDir);
      } catch {
        continue;
      }
      for (const fileName of fileNames) {
        if (!fileName.endsWith('.jsonl')) continue;
        const filePath = path.join(slugDir, fileName);
        // Skip a single unreadable file (Windows EPERM on a junction/symlink,
        // a race-deleted file) rather than aborting the whole scan.
        let size: number;
        try {
          size = fs.statSync(filePath).size;
        } catch {
          continue;
        }
        if (!best || size > best.size) best = { filePath, size };
      }
    }
    return best?.filePath ?? null;
  } catch {
    return null;
  }
}

const realJsonl = discoverLargestClaudeJsonl();

describe('transcript views - real Claude session', () => {
  (realJsonl ? it : it.skip)('parses a real session and reports view + budget sizes', async () => {
    const entries = await parseClaudeTranscript(realJsonl as string);

    const full = transcriptToMarkdown(entries);
    const responses = transcriptToMarkdown(filterTranscriptView(entries, 'responses'));
    const result = transcriptToMarkdown(filterTranscriptView(entries, 'result'));
    const budgetedDefault = renderTranscriptBudgeted(entries, { charBudget: TRANSCRIPT_CHAR_BUDGET });
    const budgetedTiny = renderTranscriptBudgeted(entries, { charBudget: 5000 });

    console.log('[real] file:', path.basename(realJsonl as string));
    console.log('[real] entries:', entries.length);
    console.log('[real] full structured chars:', full.length);
    console.log('[real] responses chars:', responses.length, `(${pct(responses.length, full.length)} of full)`);
    console.log('[real] result chars:', result.length);
    console.log(
      '[real] budget(50k): rendered',
      budgetedDefault.renderedEntries,
      'of',
      budgetedDefault.totalEntries,
      '| chars',
      budgetedDefault.markdown.length,
      '| truncated',
      budgetedDefault.truncated,
    );
    console.log(
      '[real] budget(5k): rendered',
      budgetedTiny.renderedEntries,
      'of',
      budgetedTiny.totalEntries,
      '| chars',
      budgetedTiny.markdown.length,
      '| truncated',
      budgetedTiny.truncated,
    );

    // Invariants that hold regardless of the session's content.
    expect(entries.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(responses.length + 50);
    expect(budgetedDefault.markdown.length).toBeLessThanOrEqual(TRANSCRIPT_CHAR_BUDGET + 500);
    expect(budgetedTiny.markdown.length).toBeLessThanOrEqual(5000 + 500);
  });
});
