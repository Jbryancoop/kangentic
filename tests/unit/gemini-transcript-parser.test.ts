import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseGeminiTranscript } from '../../src/main/agent/adapters/gemini/transcript-parser';

function writeFixture(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-transcript-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}

describe('parseGeminiTranscript', () => {
  let tmpFile: string | null = null;
  afterEach(() => {
    if (tmpFile) {
      try { fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true }); } catch { /* ignore */ }
      tmpFile = null;
    }
  });

  it('returns [] for a missing file', async () => {
    const entries = await parseGeminiTranscript(path.join(os.tmpdir(), 'gemini-missing.jsonl'));
    expect(entries).toEqual([]);
  });

  it('dedupes a re-emitted message by id, last emission wins', async () => {
    tmpFile = writeFixture([
      JSON.stringify({ sessionId: 's', startTime: 't', kind: 'main' }),
      JSON.stringify({ id: 'g1', type: 'gemini', content: '', model: 'gemini-3-pro', thoughts: [] }),
      JSON.stringify({ id: 'g1', type: 'gemini', content: 'final text', model: 'gemini-3-pro', thoughts: [] }),
    ]);
    const entries = await parseGeminiTranscript(tmpFile);
    // Exactly one assistant entry, carrying the LAST emission's content.
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'assistant', blocks: [{ type: 'text', text: 'final text' }] });
  });

  it('skips the injected session_context opening turn', async () => {
    tmpFile = writeFixture([
      JSON.stringify({ sessionId: 's', startTime: 't' }),
      JSON.stringify({ $set: { messages: [{ id: 'seed', type: 'user', content: [{ text: '<session_context>\nintro\n</session_context>' }] }] } }),
      JSON.stringify({ id: 'u1', type: 'user', content: [{ text: 'real prompt' }] }),
    ]);
    const entries = await parseGeminiTranscript(tmpFile);
    expect(entries).toEqual([
      { kind: 'user', uuid: 'u1', ts: expect.any(Number), text: 'real prompt' },
    ]);
  });

  it('parses the pinned fixture: thoughts -> thinking, toolCalls -> tool_use + tool_result', async () => {
    const fixturePath = path.join(__dirname, '..', 'fixtures', 'gemini-real-session.jsonl');
    const entries = await parseGeminiTranscript(fixturePath);
    expect(entries.map((entry) => entry.kind)).toEqual(['user', 'assistant', 'tool_result']);
    expect(entries[0]).toMatchObject({ kind: 'user', text: 'List the files in this directory.' });
    expect(entries[1]).toMatchObject({
      kind: 'assistant',
      model: 'gemini-3-pro-preview',
      blocks: [
        { type: 'thinking', text: 'Planning the listing: I will enumerate the workspace files.' },
        { type: 'text', text: 'Here are the files.' },
        { type: 'tool_use', id: 'call_g1', name: 'list_dir' },
      ],
    });
    expect(entries[2]).toMatchObject({ kind: 'tool_result', toolUseId: 'call_g1', content: 'file1.txt\nfile2.txt' });
  });
});
