import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCodexTranscript, locateCodexTranscriptFile } from '../../src/main/agent/adapters/codex/transcript-parser';

function writeFixture(lines: object[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-transcript-'));
  const file = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n'));
  return file;
}

describe('parseCodexTranscript', () => {
  let tmpFile: string | null = null;
  afterEach(() => {
    if (tmpFile) {
      try { fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true }); } catch { /* ignore */ }
      tmpFile = null;
    }
  });

  it('returns [] for a missing file', async () => {
    const entries = await parseCodexTranscript(path.join(os.tmpdir(), 'codex-missing.jsonl'));
    expect(entries).toEqual([]);
  });

  it('skips developer messages and injected user context wrappers', async () => {
    tmpFile = writeFixture([
      { type: 'response_item', timestamp: '2026-06-12T10:00:00Z', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>x' }] } },
      { type: 'response_item', timestamp: '2026-06-12T10:00:01Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n<cwd>C:/Users/dev/p</cwd>\n</environment_context>' }] } },
      { type: 'response_item', timestamp: '2026-06-12T10:00:02Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'real prompt' }] } },
    ]);
    const entries = await parseCodexTranscript(tmpFile);
    expect(entries).toEqual([
      { kind: 'user', uuid: expect.any(String), ts: expect.any(Number), text: 'real prompt' },
    ]);
  });

  it('drops empty (encrypted-only) reasoning and keeps populated summaries', async () => {
    tmpFile = writeFixture([
      { type: 'response_item', timestamp: '2026-06-12T10:00:00Z', payload: { type: 'reasoning', summary: [], encrypted_content: 'gAAA' } },
      { type: 'response_item', timestamp: '2026-06-12T10:00:01Z', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'plan the work' }] } },
    ]);
    const entries = await parseCodexTranscript(tmpFile);
    expect(entries).toEqual([
      { kind: 'assistant', uuid: expect.any(String), ts: expect.any(Number), model: undefined, blocks: [{ type: 'thinking', text: 'plan the work' }] },
    ]);
  });

  it('maps function_call (parsed args) and function_call_output to a tool_use / tool_result pair', async () => {
    tmpFile = writeFixture([
      { type: 'turn_context', timestamp: '2026-06-12T10:00:00Z', payload: { model: 'gpt-5-codex' } },
      { type: 'response_item', timestamp: '2026-06-12T10:00:01Z', payload: { type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}', call_id: 'call_1' } },
      { type: 'response_item', timestamp: '2026-06-12T10:00:02Z', payload: { type: 'function_call_output', call_id: 'call_1', output: 'a.txt' } },
    ]);
    const entries = await parseCodexTranscript(tmpFile);
    expect(entries[0]).toMatchObject({ kind: 'assistant', model: 'gpt-5-codex', blocks: [{ type: 'tool_use', id: 'call_1', name: 'shell', input: { command: ['ls'] } }] });
    expect(entries[1]).toMatchObject({ kind: 'tool_result', toolUseId: 'call_1', content: 'a.txt' });
  });

  it('parses the pinned rollout fixture, ignoring duplicate event_msg entries', async () => {
    const fixturePath = path.join(__dirname, '..', 'fixtures', 'codex-real-rollout.jsonl');
    const entries = await parseCodexTranscript(fixturePath);
    expect(entries.map((entry) => entry.kind)).toEqual([
      'user', 'assistant', 'assistant', 'assistant', 'tool_result', 'assistant',
    ]);
    expect(entries[0]).toMatchObject({ kind: 'user', text: 'List the files in this directory.' });
    expect(entries[1]).toMatchObject({ blocks: [{ type: 'thinking', text: 'I should run a directory listing.' }] });
    expect(entries[3]).toMatchObject({ blocks: [{ type: 'tool_use', id: 'call_abc123', name: 'shell' }] });
    expect(entries[4]).toMatchObject({ kind: 'tool_result', toolUseId: 'call_abc123', content: 'file1.txt\nfile2.txt' });
  });
});

describe('locateCodexTranscriptFile', () => {
  it('returns null when no rollout matches the session id', () => {
    // A synthetic id that cannot exist on disk. Asserting null keeps the test
    // hermetic (no writes into the real ~/.codex/sessions tree).
    expect(locateCodexTranscriptFile('00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});
