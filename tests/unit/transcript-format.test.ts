import { describe, it, expect } from 'vitest';
import { transcriptToMarkdown } from '../../src/shared/transcript-format';
import { sanitizeTranscriptText } from '../../src/shared/ansi-strip';
import type { TranscriptEntry } from '../../src/shared/types';

// Build escape/control sequences from char codes so no raw control bytes
// live in this source file (keeps it clean for the no-control-byte scanners).
const ESC = String.fromCharCode(27); // \x1b
const BEL = String.fromCharCode(7); // \x07
const sgr = (code: string): string => `${ESC}[${code}m`;

describe('transcriptToMarkdown - system entries', () => {
  it('renders a compaction system entry as a "Conversation compacted" section', () => {
    const md = transcriptToMarkdown([
      { kind: 'system', uuid: 's1', ts: 0, subtype: 'compaction', text: 'Conversation compacted (auto, 1000 tokens before compaction)' },
    ]);
    expect(md).toContain('## Conversation compacted');
    expect(md).toContain('1000 tokens before compaction');
  });

  it('renders a command system entry as a compact inline marker, not raw XML', () => {
    const md = transcriptToMarkdown([
      { kind: 'system', uuid: 's1', ts: 0, subtype: 'command', text: '/exit' },
    ]);
    expect(md).toContain('`[command: /exit]`');
    expect(md).not.toContain('## User');
  });

  it('renders a command_output system entry as a fenced Command output block', () => {
    const md = transcriptToMarkdown([
      { kind: 'system', uuid: 's1', ts: 0, subtype: 'command_output', text: 'Goodbye!' },
    ]);
    expect(md).toContain('**Command output:**');
    expect(md).toContain('Goodbye!');
  });
});

describe('transcriptToMarkdown - orphaned tool results', () => {
  it('renders an orphaned tool_result (no matching tool_use) in a trailing section', () => {
    const md = transcriptToMarkdown([
      { kind: 'user', uuid: 'u1', ts: 0, text: 'do it' },
      { kind: 'tool_result', uuid: 'r1', ts: 1, toolUseId: 'toolu_missing', content: 'orphaned output here' },
    ]);
    expect(md).toContain('## Orphaned tool results');
    expect(md).toContain('toolu_missing');
    expect(md).toContain('orphaned output here');
  });

  it('does not add an orphan section when every tool_result is paired', () => {
    const md = transcriptToMarkdown([
      {
        kind: 'assistant',
        uuid: 'a1',
        ts: 0,
        blocks: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
      },
      { kind: 'tool_result', uuid: 'r1', ts: 1, toolUseId: 't1', content: 'a.txt' },
    ]);
    expect(md).not.toContain('## Orphaned tool results');
    expect(md).toContain('**Result:**');
    expect(md).toContain('a.txt');
  });

  it('flags an orphaned error result', () => {
    const md = transcriptToMarkdown([
      { kind: 'tool_result', uuid: 'r1', ts: 0, toolUseId: 'toolu_x', content: 'boom', isError: true },
    ]);
    expect(md).toContain('## Orphaned tool results');
    expect(md).toContain('**Error for `toolu_x`:**');
  });
});

describe('transcriptToMarkdown - sanitization', () => {
  it('strips ANSI escape sequences from rendered user text', () => {
    const md = transcriptToMarkdown([
      { kind: 'user', uuid: 'u1', ts: 0, text: `${sgr('31')}red prompt${sgr('0')}` },
    ]);
    expect(md).toContain('red prompt');
    expect(md).not.toContain(ESC);
  });

  it('strips ANSI escapes and control bytes from tool output content', () => {
    const entries: TranscriptEntry[] = [
      {
        kind: 'assistant',
        uuid: 'a1',
        ts: 0,
        blocks: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }],
      },
      { kind: 'tool_result', uuid: 'r1', ts: 1, toolUseId: 't1', content: `${sgr('32')}ok${sgr('0')} done${BEL}` },
    ];
    const md = transcriptToMarkdown(entries);
    expect(md).toContain('ok');
    expect(md).toContain('done');
    expect(md).not.toContain(ESC);
    expect(md).not.toContain(BEL);
  });
});

describe('sanitizeTranscriptText', () => {
  it('removes CSI color codes and the BEL control byte', () => {
    expect(sanitizeTranscriptText(`${sgr('1;32')}hello${sgr('0')}${BEL}`)).toBe('hello');
  });

  it('preserves newlines and tabs', () => {
    expect(sanitizeTranscriptText('a\n\tb')).toBe('a\n\tb');
  });
});
