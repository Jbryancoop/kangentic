/**
 * Tests for prepareInjectionPlan - the central per-task helper that
 * task-move and SWIMLANE_UPDATE both use to translate column-level
 * model/effort/auto_command changes into a chained sequence (with the
 * right per-adapter verifier) for the CommandInjector to push onto the PTY.
 *
 * The whole point of this helper is to keep IPC handlers agent-agnostic.
 * These tests verify that:
 * - Adapters without getInjectionSequence contribute no settings writes
 * - Adapters that DO implement it own the slash syntax (Claude returns
 *   `/model X` and `/effort Y`; a hypothetical Codex could return
 *   `/model X` only, or `/reasoning-effort Y`, etc.)
 * - The verifier is wired up only when the adapter declares one AND a
 *   captured agent_session_id is available
 * - auto_command is appended after settings writes and trimmed
 */
import { describe, it, expect } from 'vitest';
import { prepareInjectionPlan } from '../../src/main/engine/injection-plan';
import type { AgentAdapter, SettingsChangeSpec } from '../../src/main/agent/agent-adapter';
import type { Swimlane } from '../../src/shared/types';

function lane(overrides: Partial<Swimlane> = {}): Swimlane {
  return {
    id: 'lane-1',
    name: 'Lane',
    color: '#000',
    position: 0,
    role: null,
    auto_command: null,
    permission_mode: null,
    agent_override: null,
    model_override: null,
    effort_override: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function fakeAdapter(overrides: Partial<AgentAdapter>): AgentAdapter {
  return {
    name: 'fake',
    displayName: 'Fake',
    sessionType: 'claude_agent',
    supportsCallerSessionId: false,
    permissions: [],
    defaultPermission: 'projectSettings',
    detect: async () => ({ found: false, path: null, version: null }),
    invalidateDetectionCache: () => undefined,
    buildCommand: () => ({ command: '', args: [] }),
    locateSessionHistoryFile: async () => null,
    runtime: { activity: { kind: 'pty' }, sessionIdCapture: { kind: 'none' } },
    ...overrides,
  } as unknown as AgentAdapter;
}

describe('prepareInjectionPlan', () => {
  it('returns null when there are no deltas and no auto_command', () => {
    const adapter = fakeAdapter({
      getInjectionSequence: () => [],
    });
    const plan = prepareInjectionPlan({
      adapter,
      sessionRepo: null,
      task: { id: 't1', agent: 'fake' },
      fromLane: lane({ model_override: 'opus', effort_override: 'high' }),
      toLane: lane({ model_override: 'opus', effort_override: 'high' }),
    });
    expect(plan).toBeNull();
  });

  it('asks the adapter for settings commands - adapters without the hook contribute none', () => {
    const adapter = fakeAdapter({}); // no getInjectionSequence
    const plan = prepareInjectionPlan({
      adapter,
      sessionRepo: null,
      task: { id: 't1', agent: 'fake' },
      fromLane: lane({ model_override: null }),
      toLane: lane({ model_override: 'opus' }),
    });
    expect(plan).toBeNull(); // no auto_command + no settings commands -> null
  });

  it('passes the correct delta spec to the adapter (modelChanged/effortChanged flags)', () => {
    let capturedSpec: SettingsChangeSpec | null = null;
    const adapter = fakeAdapter({
      getInjectionSequence: (spec) => {
        capturedSpec = spec;
        return ['/x'];
      },
    });
    prepareInjectionPlan({
      adapter,
      sessionRepo: null,
      task: { id: 't1', agent: 'fake' },
      fromLane: lane({ model_override: 'haiku', effort_override: 'low' }),
      toLane: lane({ model_override: 'opus', effort_override: 'low' }),
    });
    expect(capturedSpec).toEqual({
      model: 'opus',
      modelChanged: true,
      effort: 'low',
      effortChanged: false,
    });
  });

  it('appends a trimmed auto_command after the adapter-supplied settings commands', () => {
    const adapter = fakeAdapter({
      getInjectionSequence: () => ['/model opus'],
    });
    const plan = prepareInjectionPlan({
      adapter,
      sessionRepo: null,
      task: { id: 't1', agent: 'fake' },
      fromLane: lane({ model_override: 'haiku' }),
      toLane: lane({ model_override: 'opus' }),
      autoCommand: '   review the diff   ',
    });
    expect(plan?.sequence).toEqual(['/model opus', 'review the diff']);
  });

  it('returns just the auto_command when there are no settings deltas', () => {
    const adapter = fakeAdapter({
      getInjectionSequence: () => [],
    });
    const plan = prepareInjectionPlan({
      adapter,
      sessionRepo: null,
      task: { id: 't1', agent: 'fake' },
      fromLane: lane(),
      toLane: lane(),
      autoCommand: 'do thing',
    });
    // verifiedPrefixLength = 0 because settings sequence is empty.
    // The auto_command sits at index 0 and is fire-and-forget.
    expect(plan).toEqual({ sequence: ['do thing'], verifier: null, verifiedPrefixLength: 0 });
  });

  it('verifiedPrefixLength excludes the trailing auto_command so it stays fire-and-forget', () => {
    // The whole point of the prefix split: a `/`-prefixed user auto_command
    // must NOT be subjected to verification (it might not produce a JSONL
    // entry the verifier recognizes, and retry exhaustion would drop it).
    const adapter = fakeAdapter({
      getInjectionSequence: () => ['/model opus', '/effort high'],
    });
    const plan = prepareInjectionPlan({
      adapter,
      sessionRepo: null,
      task: { id: 't1', agent: 'fake' },
      fromLane: lane({ model_override: null, effort_override: null }),
      toLane: lane({ model_override: 'opus', effort_override: 'high' }),
      autoCommand: '/review --strict',
    });
    expect(plan?.sequence).toEqual(['/model opus', '/effort high', '/review --strict']);
    // First two (settings) are verified; auto_command is not.
    expect(plan?.verifiedPrefixLength).toBe(2);
  });

  it('verifier is null when adapter does not implement getCommandInjectionVerifier', () => {
    const adapter = fakeAdapter({
      getInjectionSequence: () => ['/x'],
    });
    const plan = prepareInjectionPlan({
      adapter,
      sessionRepo: {
        // @ts-expect-error stub
        getLatestForTask: () => ({ agent_session_id: 'abc', cwd: '/cwd' }),
      },
      task: { id: 't1', agent: 'fake' },
      fromLane: lane({ model_override: null }),
      toLane: lane({ model_override: 'opus' }),
    });
    expect(plan?.verifier).toBeNull();
  });

  it('verifier is null when no session record has a captured agent_session_id', () => {
    const verifierFn = async (): Promise<boolean> => true;
    const adapter = fakeAdapter({
      getInjectionSequence: () => ['/x'],
      getCommandInjectionVerifier: () => verifierFn,
    });
    const plan = prepareInjectionPlan({
      adapter,
      sessionRepo: {
        // @ts-expect-error stub
        getLatestForTask: () => ({ agent_session_id: null, cwd: '/cwd' }),
      },
      task: { id: 't1', agent: 'fake' },
      fromLane: lane({ model_override: null }),
      toLane: lane({ model_override: 'opus' }),
    });
    expect(plan?.verifier).toBeNull();
  });

  it('wires the adapter verifier when both the hook and a captured session id are available', () => {
    const verifierFn = async (): Promise<boolean> => true;
    let capturedInput: { agentSessionId: string; cwd: string } | null = null;
    const adapter = fakeAdapter({
      getInjectionSequence: () => ['/x'],
      getCommandInjectionVerifier: (input) => {
        capturedInput = input;
        return verifierFn;
      },
    });
    const plan = prepareInjectionPlan({
      adapter,
      sessionRepo: {
        // @ts-expect-error stub
        getLatestForTask: () => ({ agent_session_id: 'sess-uuid', cwd: '/repo' }),
      },
      task: { id: 't1', agent: 'fake' },
      fromLane: lane({ model_override: null }),
      toLane: lane({ model_override: 'opus' }),
    });
    expect(plan?.verifier).toBe(verifierFn);
    expect(capturedInput).toEqual({ agentSessionId: 'sess-uuid', cwd: '/repo' });
  });

  it('handles undefined adapter gracefully (no agent or unknown agent name)', () => {
    const plan = prepareInjectionPlan({
      adapter: undefined,
      sessionRepo: null,
      task: { id: 't1', agent: null },
      fromLane: lane(),
      toLane: lane(),
      autoCommand: 'fallback',
    });
    expect(plan).toEqual({ sequence: ['fallback'], verifier: null, verifiedPrefixLength: 0 });
  });
});
