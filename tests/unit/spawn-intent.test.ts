import { describe, it, expect, vi } from 'vitest';
import { resolveSpawnIntent } from '../../src/main/engine/spawn-intent';

/** Minimal mock session record for testing. */
function mockSessionRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rec-1',
    task_id: 'task-1',
    session_type: 'claude_agent',
    agent_session_id: 'agent-uuid-A',
    command: 'claude --session-id agent-uuid-A',
    cwd: '/project',
    permission_mode: 'default',
    prompt: 'Test prompt',
    status: 'suspended',
    exit_code: null,
    started_at: '2026-01-01T00:00:00Z',
    suspended_at: '2026-01-01T01:00:00Z',
    exited_at: null,
    suspended_by: 'system',
    ...overrides,
  };
}

/** Minimal mock session repository. */
function mockSessionRepo(record: ReturnType<typeof mockSessionRecord> | undefined = undefined) {
  return {
    getLatestForTaskByType: vi.fn().mockReturnValue(record),
  } as unknown as Parameters<typeof resolveSpawnIntent>[0]['sessionRepo'];
}

describe('resolveSpawnIntent', () => {
  const baseOptions = {
    taskId: 'task-1',
    sessionType: 'claude_agent',
    promptTemplate: '{{title}}{{description}}',
    templateVars: { title: 'Fix bug', description: ': login broken' },
    resumePrompt: undefined as string | undefined,
  };

  it('resumes when a suspended session of the same type exists', () => {
    const record = mockSessionRecord({ status: 'suspended' });
    const intent = resolveSpawnIntent({
      ...baseOptions,
      sessionRepo: mockSessionRepo(record),
    });

    expect(intent.mode).toBe('resume');
    expect(intent.agentSessionId).toBe('agent-uuid-A');
    expect(intent.retireRecordId).toBe('rec-1');
    expect(intent.prompt).toBeUndefined();
  });

  it('passes resumePrompt through when resuming', () => {
    const record = mockSessionRecord({ status: 'suspended' });
    const intent = resolveSpawnIntent({
      ...baseOptions,
      sessionRepo: mockSessionRepo(record),
      resumePrompt: '/review',
    });

    expect(intent.mode).toBe('resume');
    expect(intent.prompt).toBe('/review');
  });

  it('spawns fresh when no session exists for the agent type', () => {
    const intent = resolveSpawnIntent({
      ...baseOptions,
      sessionRepo: mockSessionRepo(undefined),
    });

    expect(intent.mode).toBe('fresh');
    expect(intent.agentSessionId).toBeNull();
    expect(intent.retireRecordId).toBeNull();
    expect(intent.prompt).toBe('Fix bug: login broken');
  });

  it('spawns fresh when session repo is null', () => {
    const intent = resolveSpawnIntent({
      ...baseOptions,
      sessionRepo: null,
    });

    expect(intent.mode).toBe('fresh');
    expect(intent.agentSessionId).toBeNull();
    expect(intent.prompt).toBe('Fix bug: login broken');
  });

  it('spawns fresh when matching session has no agent_session_id', () => {
    const record = mockSessionRecord({ agent_session_id: null });
    const intent = resolveSpawnIntent({
      ...baseOptions,
      sessionRepo: mockSessionRepo(record),
    });

    expect(intent.mode).toBe('fresh');
  });

  it('spawns fresh when matching session is queued (never started)', () => {
    const record = mockSessionRecord({ status: 'queued' });
    const intent = resolveSpawnIntent({
      ...baseOptions,
      sessionRepo: mockSessionRepo(record),
    });

    expect(intent.mode).toBe('fresh');
  });

  it('spawns fresh when matching session is a run_script', () => {
    const record = mockSessionRecord({ session_type: 'run_script' });
    const intent = resolveSpawnIntent({
      ...baseOptions,
      sessionRepo: mockSessionRepo(record),
    });

    expect(intent.mode).toBe('fresh');
  });

  it('resumes orphaned sessions (crash recovery)', () => {
    const record = mockSessionRecord({ status: 'orphaned' });
    const intent = resolveSpawnIntent({
      ...baseOptions,
      sessionRepo: mockSessionRepo(record),
    });

    expect(intent.mode).toBe('resume');
    expect(intent.agentSessionId).toBe('agent-uuid-A');
  });

  it('resumes exited sessions (agent exited but transcript exists)', () => {
    const record = mockSessionRecord({ status: 'exited' });
    const intent = resolveSpawnIntent({
      ...baseOptions,
      sessionRepo: mockSessionRepo(record),
    });

    expect(intent.mode).toBe('resume');
    expect(intent.agentSessionId).toBe('agent-uuid-A');
  });

  it('resumes Codex session when agent_session_id was captured from hooks', () => {
    const record = mockSessionRecord({ status: 'suspended', session_type: 'codex_agent', agent_session_id: 'thr_abc123' });
    const intent = resolveSpawnIntent({
      ...baseOptions,
      sessionType: 'codex_agent',
      sessionRepo: mockSessionRepo(record),
    });

    expect(intent.mode).toBe('resume');
    expect(intent.agentSessionId).toBe('thr_abc123');
  });

  it('resumes Codex session with UUID format session ID', () => {
    const record = mockSessionRecord({ status: 'suspended', session_type: 'codex_agent', agent_session_id: '019d60ac-b67c-7a22-bcbb-af55c8295c38' });
    const intent = resolveSpawnIntent({
      ...baseOptions,
      sessionType: 'codex_agent',
      sessionRepo: mockSessionRepo(record),
    });

    expect(intent.mode).toBe('resume');
    expect(intent.agentSessionId).toBe('019d60ac-b67c-7a22-bcbb-af55c8295c38');
  });

  it('resumes Gemini session when agent_session_id was captured from hooks', () => {
    const record = mockSessionRecord({ status: 'suspended', session_type: 'gemini_agent', agent_session_id: '4231e6aa-5409-4749-9272-270e9aab079b' });
    const intent = resolveSpawnIntent({
      ...baseOptions,
      sessionType: 'gemini_agent',
      sessionRepo: mockSessionRepo(record),
    });

    expect(intent.mode).toBe('resume');
    expect(intent.agentSessionId).toBe('4231e6aa-5409-4749-9272-270e9aab079b');
  });

  it('spawns fresh when agent_session_id was never captured (null)', () => {
    const record = mockSessionRecord({ status: 'suspended', agent_session_id: null });
    const intent = resolveSpawnIntent({
      ...baseOptions,
      sessionRepo: mockSessionRepo(record),
    });

    expect(intent.mode).toBe('fresh');
    expect(intent.agentSessionId).toBeNull();
  });

  it('uses promptTemplate for fresh spawn, not for resume', () => {
    const freshIntent = resolveSpawnIntent({
      ...baseOptions,
      sessionRepo: mockSessionRepo(undefined),
    });
    expect(freshIntent.prompt).toBe('Fix bug: login broken');

    const resumeIntent = resolveSpawnIntent({
      ...baseOptions,
      sessionRepo: mockSessionRepo(mockSessionRecord()),
      resumePrompt: '/test',
    });
    expect(resumeIntent.prompt).toBe('/test');
  });

  it('returns undefined prompt on fresh spawn with no template', () => {
    const intent = resolveSpawnIntent({
      ...baseOptions,
      promptTemplate: undefined,
      sessionRepo: mockSessionRepo(undefined),
    });

    expect(intent.mode).toBe('fresh');
    expect(intent.prompt).toBeUndefined();
  });

  it('queries by session type for agent-aware lookup', () => {
    const sessionRepo = mockSessionRepo(undefined);
    resolveSpawnIntent({
      ...baseOptions,
      sessionType: 'codex_agent',
      sessionRepo,
    });

    expect(sessionRepo!.getLatestForTaskByType).toHaveBeenCalledWith('task-1', 'codex_agent');
  });

  it('expands {{task_xml}} placeholder through the fresh-spawn path', () => {
    // buildTaskXml omits <description> entirely when empty (no self-closing tag).
    // This value matches what the engine produces for a task with no description.
    const taskXmlValue = '<task>\n  <title>Hello</title>\n</task>';
    const intent = resolveSpawnIntent({
      taskId: 'task-1',
      sessionType: 'claude_agent',
      promptTemplate: '{{task_xml}}{{attachments}}',
      templateVars: { task_xml: taskXmlValue, attachments: '' },
      resumePrompt: undefined,
      sessionRepo: mockSessionRepo(undefined),
    });

    expect(intent.mode).toBe('fresh');
    expect(intent.prompt).toContain('<task>');
    expect(intent.prompt).toContain('<title>Hello</title>');
    expect(intent.prompt).not.toContain('<description');
  });
});
