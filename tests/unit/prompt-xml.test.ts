import { describe, it, expect } from 'vitest';
import {
  escapeXml,
  buildTaskXml,
  buildHandoffXml,
} from '../../src/main/agent/shared/prompt-xml';

describe('escapeXml', () => {
  it('escapes the five XML metacharacters', () => {
    expect(escapeXml(`a & b < c > d "e" 'f'`))
      .toBe('a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;');
  });

  it('returns input unchanged when no metacharacters are present', () => {
    expect(escapeXml('plain text 123')).toBe('plain text 123');
  });

  it('handles empty strings', () => {
    expect(escapeXml('')).toBe('');
  });

  it('escapes ampersands first to avoid double-encoding', () => {
    // If the order were wrong, '&lt;' itself would become '&amp;lt;'.
    expect(escapeXml('<')).toBe('&lt;');
    expect(escapeXml('&')).toBe('&amp;');
  });
});

describe('buildTaskXml', () => {
  it('wraps title and description in a <task> envelope', () => {
    const xml = buildTaskXml({ title: 'Add login flow', description: 'Use OAuth' });
    expect(xml).toBe([
      '<task>',
      '  <title>Add login flow</title>',
      '  <description>Use OAuth</description>',
      '</task>',
    ].join('\n'));
  });

  it('self-closes <description /> when description is empty', () => {
    const xml = buildTaskXml({ title: 'Just a title', description: '' });
    expect(xml).toContain('<description />');
    expect(xml).not.toContain('<description>');
  });

  it('self-closes <description /> when description is whitespace-only', () => {
    const xml = buildTaskXml({ title: 'Title', description: '   \n\t' });
    expect(xml).toContain('<description />');
  });

  it('escapes XML special characters in title', () => {
    const xml = buildTaskXml({ title: 'Fix <a href="x"> & escape', description: '' });
    expect(xml).toContain('<title>Fix &lt;a href=&quot;x&quot;&gt; &amp; escape</title>');
  });

  it('escapes XML special characters in description', () => {
    const xml = buildTaskXml({ title: 'Title', description: 'Use <code>&amp;</code>' });
    expect(xml).toContain('<description>Use &lt;code&gt;&amp;amp;&lt;/code&gt;</description>');
  });
});

describe('buildHandoffXml', () => {
  it('places instruction prose at the top and structured fields in <handoff_context>', () => {
    const out = buildHandoffXml({
      sourceDisplayName: 'Claude Code',
      sessionFilePath: '/sessions/foo.jsonl',
      targetHasMcpAccess: false,
    });

    const lines = out.split('\n');
    expect(lines[0]).toContain('You are continuing work');
    expect(lines[0]).toContain('Claude Code');
    expect(out).toContain('<handoff_context>');
    expect(out).toContain('<source_agent>Claude Code</source_agent>');
    expect(out).toContain('<session_history_path>/sessions/foo.jsonl</session_history_path>');
    expect(out).toContain('</handoff_context>');
  });

  it('omits MCP hint when target lacks MCP access', () => {
    const out = buildHandoffXml({
      sourceDisplayName: 'Codex CLI',
      sessionFilePath: '/path/file.jsonl',
      targetHasMcpAccess: false,
    });
    expect(out).not.toContain('kangentic_get_session_history');
  });

  it('includes MCP hint when target has MCP access', () => {
    const out = buildHandoffXml({
      sourceDisplayName: 'Codex CLI',
      sessionFilePath: '/path/file.jsonl',
      targetHasMcpAccess: true,
    });
    expect(out).toContain('`kangentic_get_session_history`');
  });

  it('self-closes <session_history_path /> when no file path is available', () => {
    const out = buildHandoffXml({
      sourceDisplayName: 'Aider',
      sessionFilePath: null,
      targetHasMcpAccess: false,
    });
    expect(out).toContain('<session_history_path />');
    expect(out).toContain('No session history file is available');
    expect(out).toContain('git log');
  });

  it('escapes XML special chars in source display name and file path', () => {
    const out = buildHandoffXml({
      sourceDisplayName: 'Agent <X> & "Y"',
      sessionFilePath: '/tmp/<weird>/path"with".jsonl',
      targetHasMcpAccess: false,
    });
    expect(out).toContain('<source_agent>Agent &lt;X&gt; &amp; &quot;Y&quot;</source_agent>');
    expect(out).toContain('<session_history_path>/tmp/&lt;weird&gt;/path&quot;with&quot;.jsonl</session_history_path>');
  });
});
