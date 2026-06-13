import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleGetTranscript, handleQueryDb } from '../../src/main/agent/commands/inspect-commands';
import type { CommandContext } from '../../src/main/agent/commands/types';
import type { TranscriptEntry } from '../../src/shared/types';
import type { AgentAdapter, ParsedTranscript } from '../../src/main/agent/agent-adapter';

// Vitest hoists vi.mock() calls automatically, so these factories run before
// the inspect-commands module is evaluated. We mock the agent registry (the
// single dispatch point) rather than individual parser modules - the handler
// routes structured transcripts through `agentRegistry.getBySessionType().
// parseTranscript`, with no agent-name branching of its own.

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { getBySessionType: vi.fn() },
}));

vi.mock('../../src/shared/transcript-format', () => ({
  transcriptToMarkdown: vi.fn().mockReturnValue('## User\n\nhello\n\n## Assistant\n\nworld'),
}));

import { agentRegistry } from '../../src/main/agent/agent-registry';
import { transcriptToMarkdown } from '../../src/shared/transcript-format';

/**
 * Build a stub adapter for a session_type. Pass `parseTranscript` to simulate
 * an agent with a structured parser; omit it to simulate an agent that only
 * supports the raw format (Aider, Warp, ...).
 */
function stubAdapter(options: {
  displayName: string;
  parseTranscript?: (agentSessionId: string, cwd: string) => Promise<ParsedTranscript>;
}): AgentAdapter {
  const adapter: Partial<AgentAdapter> = { displayName: options.displayName };
  if (options.parseTranscript) {
    adapter.parseTranscript = vi.fn(options.parseTranscript);
  }
  return adapter as AgentAdapter;
}

// --- Helpers ---

interface MockSessionRow {
  id: string;
  task_id: string;
  session_type?: string;
  agent_session_id?: string | null;
  cwd?: string;
  started_at?: string;
}

function createMockDb(options: {
  tasks?: Array<{ id: string; display_id: number; session_id: string | null }>;
  sessions?: MockSessionRow[];
  transcripts?: Array<{ session_id: string; transcript: string; size_bytes: number; created_at: string; updated_at: string }>;
  queryResults?: Record<string, unknown>[];
} = {}) {
  const { tasks = [], sessions = [], transcripts = [], queryResults = [] } = options;

  const prepareHandlers: Record<string, { get: ReturnType<typeof vi.fn>; all: ReturnType<typeof vi.fn> }> = {};

  // Track PRAGMA query_only state to simulate SQLite's read-only enforcement
  let queryOnly = false;

  // Write statement patterns that SQLite rejects when query_only = ON
  const writePattern = /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE)\b/i;
  // Also catch write statements hidden inside subqueries or CTEs
  const embeddedWritePattern = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE)\b/i;

  const db = {
    pragma: vi.fn((command: string) => {
      if (command === 'query_only = ON') queryOnly = true;
      else if (command === 'query_only = OFF') queryOnly = false;
    }),
    prepare: vi.fn((sql: string) => {
      // Task resolution queries
      if (sql.includes('FROM tasks') && sql.includes('display_id')) {
        return {
          get: vi.fn((displayId: number) => tasks.find((task) => task.display_id === displayId) ?? undefined),
          all: vi.fn(() => tasks),
        };
      }
      if (sql.includes('FROM tasks') && sql.includes('WHERE id')) {
        return {
          get: vi.fn((taskId: string) => tasks.find((task) => task.id === taskId) ?? undefined),
          all: vi.fn(() => tasks),
        };
      }

      // Session queries
      if (sql.includes('FROM sessions') && sql.includes('task_id = ?')) {
        // SessionRepository.getLatestForTask
        return {
          get: vi.fn((taskId: string) => sessions.find((session) => session.task_id === taskId) ?? undefined),
          all: vi.fn(() => sessions),
        };
      }
      if (sql.includes('FROM sessions') && sql.includes('id = ?') && sql.includes('agent_session_id = ?')) {
        // SessionRepository.findByAnyId - id OR agent_session_id, both bound positionally
        return {
          get: vi.fn((idArg: string, agentIdArg: string) =>
            sessions.find((session) => session.id === idArg || session.agent_session_id === agentIdArg) ?? undefined),
          all: vi.fn(() => sessions),
        };
      }

      // Transcript queries
      if (sql.includes('FROM session_transcripts') && sql.includes('*')) {
        return {
          get: vi.fn((sessionId: string) => transcripts.find((transcript) => transcript.session_id === sessionId) ?? undefined),
          all: vi.fn(() => transcripts),
        };
      }
      if (sql.includes('FROM session_transcripts') && sql.includes('transcript')) {
        return {
          get: vi.fn((sessionId: string) => {
            const record = transcripts.find((transcript) => transcript.session_id === sessionId);
            return record ? { transcript: record.transcript } : undefined;
          }),
          all: vi.fn(() => transcripts),
        };
      }

      // Generic query (for query_db) - simulate SQLite read-only enforcement
      const handler = {
        get: vi.fn(() => queryResults[0] ?? undefined),
        all: vi.fn(() => {
          if (queryOnly && (writePattern.test(sql) || embeddedWritePattern.test(sql))) {
            // PRAGMA read-only queries are allowed even when query_only is ON
            if (/^\s*PRAGMA\s+\w+\s*\(/i.test(sql)) return queryResults;
            if (/^\s*PRAGMA\s+(?!.*=)/i.test(sql)) return queryResults;
            throw new Error('attempt to write a read-only database');
          }
          return queryResults;
        }),
      };
      prepareHandlers[sql] = handler;
      return handler;
    }),
  };

  return db;
}

function createMockContext(db: ReturnType<typeof createMockDb>): CommandContext {
  return {
    getProjectDb: () => db as never,
    getProjectPath: () => 'C:/Users/dev/project',
    onTaskCreated: vi.fn(),
    onTaskUpdated: vi.fn(),
    onTaskDeleted: vi.fn(),
    onBacklogChanged: vi.fn(),
    onLabelColorsChanged: vi.fn(),
  };
}

// --- handleGetTranscript ---

describe('handleGetTranscript', () => {
  beforeEach(() => {
    vi.mocked(agentRegistry.getBySessionType).mockReset();
    vi.mocked(transcriptToMarkdown).mockReturnValue('## User\n\nhello\n\n## Assistant\n\nworld');
  });

  it('returns error when no taskId or sessionId provided', async () => {
    const db = createMockDb();
    const context = createMockContext(db);

    const result = await handleGetTranscript({}, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('taskId or sessionId');
  });

  it('returns raw transcript by sessionId when format="raw"', async () => {
    vi.mocked(agentRegistry.getBySessionType).mockReturnValue(stubAdapter({ displayName: 'Claude Code' }));
    const db = createMockDb({
      sessions: [{ id: 'session-abc', task_id: 'task-1', session_type: 'claude_agent' }],
      transcripts: [{
        session_id: 'session-abc',
        transcript: 'Hello world output',
        size_bytes: 18,
        created_at: '2026-04-04T15:00:00Z',
        updated_at: '2026-04-04T15:05:00Z',
      }],
    });
    const context = createMockContext(db);

    const result = await handleGetTranscript({ sessionId: 'session-abc', format: 'raw' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('Hello world output');
    expect(result.message).toContain('session-');
    expect(result.message).toContain('Format: raw');
  });

  it('returns message when no raw transcript exists', async () => {
    vi.mocked(agentRegistry.getBySessionType).mockReturnValue(stubAdapter({ displayName: 'Claude Code' }));
    const db = createMockDb({
      tasks: [{ id: 'task-1', display_id: 1, session_id: 'session-1' }],
      sessions: [{ id: 'session-1', task_id: 'task-1', session_type: 'claude_agent' }],
      transcripts: [],
    });
    const context = createMockContext(db);

    const result = await handleGetTranscript({ taskId: '1', format: 'raw' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('No raw transcript captured');
  });

  it('returns error when task not found', async () => {
    const db = createMockDb({ tasks: [] });
    const context = createMockContext(db);

    const result = await handleGetTranscript({ taskId: '999' }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Task not found');
  });

  it('rejects an unknown format value', async () => {
    const db = createMockDb();
    const context = createMockContext(db);

    const result = await handleGetTranscript({ sessionId: 'x', format: 'pretty' }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid format');
  });

  // --- format='structured' dispatch tests ---

  it('reports structured is unsupported when the adapter has no parseTranscript', async () => {
    // Aider-style adapter: present in the registry but no structured parser.
    vi.mocked(agentRegistry.getBySessionType).mockReturnValue(stubAdapter({ displayName: 'Aider' }));
    const db = createMockDb({
      sessions: [{
        id: 'session-aider',
        task_id: 'task-1',
        session_type: 'aider_agent',
        agent_session_id: 'aider-uuid',
        cwd: 'C:/Users/dev/project',
      }],
    });
    const context = createMockContext(db);

    const result = await handleGetTranscript({ sessionId: 'session-aider', format: 'structured' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('not supported');
    expect(result.message).toContain('Aider');
    expect(result.message).toContain('format="raw"');
  });

  it('reports structured is unsupported when no adapter is registered for the session_type', async () => {
    vi.mocked(agentRegistry.getBySessionType).mockReturnValue(undefined);
    const db = createMockDb({
      sessions: [{
        id: 'session-unknown',
        task_id: 'task-1',
        session_type: 'mystery_agent',
        agent_session_id: 'x',
        cwd: 'C:/Users/dev/project',
      }],
    });
    const context = createMockContext(db);

    const result = await handleGetTranscript({ sessionId: 'session-unknown', format: 'structured' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('not supported');
    expect(result.message).toContain('mystery_agent');
  });

  it('reports native history not yet written when the parser exists but agent_session_id is null', async () => {
    const parseTranscript = vi.fn();
    vi.mocked(agentRegistry.getBySessionType).mockReturnValue(
      stubAdapter({ displayName: 'Droid', parseTranscript }),
    );
    const db = createMockDb({
      sessions: [{ id: 'session-abc', task_id: 'task-1', session_type: 'droid_agent', agent_session_id: null }],
    });
    const context = createMockContext(db);

    const result = await handleGetTranscript({ sessionId: 'session-abc', format: 'structured' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('no agent_session_id');
    // Parser must NOT have been called - the guard fires before dispatch.
    expect(parseTranscript).not.toHaveBeenCalled();
  });

  it('dispatches through the adapter capability and returns structured markdown', async () => {
    const fakeEntries: TranscriptEntry[] = [
      { kind: 'user', uuid: 'u1', ts: 0, text: 'hello' },
      { kind: 'assistant', uuid: 'a1', ts: 1, blocks: [{ type: 'text', text: 'world' }] },
    ];
    const parseTranscript = vi.fn().mockResolvedValue({
      entries: fakeEntries,
      sourcePath: '/fake/.factory/sessions/cwd-slug/droid-session.jsonl',
    });
    vi.mocked(agentRegistry.getBySessionType).mockReturnValue(
      stubAdapter({ displayName: 'Droid', parseTranscript }),
    );

    const db = createMockDb({
      sessions: [{
        id: 'session-droid',
        task_id: 'task-1',
        session_type: 'droid_agent',
        agent_session_id: 'droid-uuid-1234',
        cwd: 'C:/Users/dev/project',
      }],
    });
    const context = createMockContext(db);

    const result = await handleGetTranscript({ sessionId: 'session-droid', format: 'structured' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('Format: structured');
    expect(result.message).toContain('Entries: 2');
    expect(result.message).toContain('## User');
    // The capability is invoked with the agent session id and cwd.
    expect(parseTranscript).toHaveBeenCalledWith('droid-uuid-1234', 'C:/Users/dev/project');
    // Data payload carries the located source path as filePath.
    expect(result.data).toMatchObject({
      sessionId: 'session-droid',
      format: 'structured',
      entryCount: 2,
      filePath: '/fake/.factory/sessions/cwd-slug/droid-session.jsonl',
    });
  });

  it('reports native history not found when the parser returns no entries', async () => {
    const parseTranscript = vi.fn().mockResolvedValue({ entries: [], sourcePath: '/fake/path.jsonl' });
    vi.mocked(agentRegistry.getBySessionType).mockReturnValue(
      stubAdapter({ displayName: 'Droid', parseTranscript }),
    );

    const db = createMockDb({
      sessions: [{
        id: 'session-empty',
        task_id: 'task-4',
        session_type: 'droid_agent',
        agent_session_id: 'droid-uuid-empty',
        cwd: 'C:/Users/dev/project',
      }],
    });
    const context = createMockContext(db);

    const result = await handleGetTranscript({ sessionId: 'session-empty', format: 'structured' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('No structured transcript found');
    expect(result.message).toContain('/fake/path.jsonl');
  });

  it('defaults to format="structured" when format param is omitted', async () => {
    const parseTranscript = vi.fn().mockResolvedValue({
      entries: [{ kind: 'user', uuid: 'u1', ts: 0, text: 'hi' }] satisfies TranscriptEntry[],
      sourcePath: '/fake/path.jsonl',
    });
    vi.mocked(agentRegistry.getBySessionType).mockReturnValue(
      stubAdapter({ displayName: 'Droid', parseTranscript }),
    );

    const db = createMockDb({
      sessions: [{
        id: 'session-default',
        task_id: 'task-5',
        session_type: 'droid_agent',
        agent_session_id: 'droid-uuid-default',
        cwd: 'C:/Users/dev/project',
      }],
    });
    const context = createMockContext(db);

    // No format param - should default to structured.
    const result = await handleGetTranscript({ sessionId: 'session-default' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('Format: structured');
    expect(parseTranscript).toHaveBeenCalledOnce();
  });
});

// --- handleQueryDb ---

describe('handleQueryDb', () => {
  it('returns error when sql is missing', () => {
    const db = createMockDb();
    const context = createMockContext(db);

    const result = handleQueryDb({}, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('sql parameter is required');
  });

  it('blocks INSERT statements', () => {
    const db = createMockDb();
    const context = createMockContext(db);

    const result = handleQueryDb({ sql: "INSERT INTO tasks VALUES ('x')" }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('read-only database');
  });

  it('blocks DELETE statements', () => {
    const db = createMockDb();
    const context = createMockContext(db);

    const result = handleQueryDb({ sql: 'DELETE FROM tasks' }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('read-only database');
  });

  it('blocks DROP statements', () => {
    const db = createMockDb();
    const context = createMockContext(db);

    const result = handleQueryDb({ sql: 'DROP TABLE tasks' }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('read-only database');
  });

  it('blocks UPDATE statements', () => {
    const db = createMockDb();
    const context = createMockContext(db);

    const result = handleQueryDb({ sql: "UPDATE tasks SET title = 'x'" }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('read-only database');
  });

  it('blocks PRAGMA writes', () => {
    const db = createMockDb();
    const context = createMockContext(db);

    const result = handleQueryDb({ sql: 'PRAGMA journal_mode = delete' }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('read-only database');
  });

  it('allows SELECT queries', () => {
    const db = createMockDb({
      queryResults: [
        { id: 'task-1', title: 'Test task' },
        { id: 'task-2', title: 'Another task' },
      ],
    });
    const context = createMockContext(db);

    const result = handleQueryDb({ sql: 'SELECT id, title FROM tasks' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('task-1');
    expect(result.message).toContain('Test task');
    expect(result.message).toContain('2 row(s)');
  });

  it('allows read-only PRAGMA queries', () => {
    const db = createMockDb({
      queryResults: [{ name: 'id', type: 'TEXT' }],
    });
    const context = createMockContext(db);

    const result = handleQueryDb({ sql: 'PRAGMA table_info(tasks)' }, context);

    expect(result.success).toBe(true);
  });

  it('allows WITH (CTE) queries', () => {
    const db = createMockDb({
      queryResults: [{ count: 5 }],
    });
    const context = createMockContext(db);

    const result = handleQueryDb({ sql: 'WITH t AS (SELECT * FROM tasks) SELECT count(*) as count FROM t' }, context);

    expect(result.success).toBe(true);
  });

  it('returns formatted message for empty results', () => {
    const db = createMockDb({ queryResults: [] });
    const context = createMockContext(db);

    const result = handleQueryDb({ sql: 'SELECT * FROM tasks WHERE 1=0' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('0 rows');
  });

  it('truncates long cell values', () => {
    const longValue = 'x'.repeat(200);
    const db = createMockDb({
      queryResults: [{ id: '1', content: longValue }],
    });
    const context = createMockContext(db);

    const result = handleQueryDb({ sql: 'SELECT * FROM data' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('...');
    expect(result.message).not.toContain(longValue);
  });

  it('formats output as markdown table', () => {
    const db = createMockDb({
      queryResults: [{ name: 'tasks', type: 'table' }],
    });
    const context = createMockContext(db);

    const result = handleQueryDb({ sql: "SELECT name, type FROM sqlite_master" }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('| name | type |');
    expect(result.message).toContain('| --- | --- |');
    expect(result.message).toContain('| tasks | table |');
  });

  it('blocks subquery with DELETE', () => {
    const db = createMockDb();
    const context = createMockContext(db);

    const result = handleQueryDb({ sql: 'SELECT * FROM (DELETE FROM tasks RETURNING *)' }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('read-only database');
  });
});
