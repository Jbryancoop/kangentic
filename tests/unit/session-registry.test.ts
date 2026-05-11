/**
 * Unit tests for SessionRegistry.
 *
 * Covers:
 *   - getSessionAgentName: returns the stored agentName or undefined when
 *     absent/missing.
 *   - findLiveSessionByTaskId: returns running/queued Session DTOs and
 *     undefined for suspended/exited entries; proves the multi-entry
 *     invariant that a suspended placeholder cannot mask a live spawn for
 *     the same taskId regardless of insertion order.
 */

import { describe, it, expect } from 'vitest';
import { SessionRegistry } from '../../src/main/pty/session-registry';
import type { ManagedSession } from '../../src/main/pty/session-registry';

/** Build a minimal ManagedSession with only the fields relevant to this test. */
function makeManagedSession(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: 'session-001',
    taskId: 'task-001',
    projectId: 'project-001',
    pty: null,
    status: 'running',
    shell: '/bin/bash',
    cwd: '/home/dev/project',
    startedAt: new Date().toISOString(),
    exitCode: null,
    resuming: false,
    transient: false,
    exitSequence: ['\x03'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// findLiveSessionByTaskId
// ---------------------------------------------------------------------------

describe('SessionRegistry.findLiveSessionByTaskId', () => {
  it('returns undefined when the registry is empty', () => {
    const registry = new SessionRegistry();
    expect(registry.findLiveSessionByTaskId('task-x')).toBeUndefined();
  });

  it('returns undefined when only a suspended entry exists for the taskId', () => {
    const registry = new SessionRegistry();
    registry.set('sess-suspended', makeManagedSession({
      id: 'sess-suspended',
      taskId: 'task-paused',
      status: 'suspended',
    }));
    expect(registry.findLiveSessionByTaskId('task-paused')).toBeUndefined();
  });

  it('returns undefined when only an exited entry exists for the taskId', () => {
    const registry = new SessionRegistry();
    registry.set('sess-exited', makeManagedSession({
      id: 'sess-exited',
      taskId: 'task-done',
      status: 'exited',
    }));
    expect(registry.findLiveSessionByTaskId('task-done')).toBeUndefined();
  });

  it('returns a Session DTO when a single running entry exists', () => {
    const registry = new SessionRegistry();
    registry.set('sess-running', makeManagedSession({
      id: 'sess-running',
      taskId: 'task-active',
      status: 'running',
    }));

    const result = registry.findLiveSessionByTaskId('task-active');

    expect(result).toBeDefined();
    expect(result!.id).toBe('sess-running');
    expect(result!.taskId).toBe('task-active');
    expect(result!.status).toBe('running');
  });

  it('returns a Session DTO when a single queued entry exists', () => {
    const registry = new SessionRegistry();
    registry.set('sess-queued', makeManagedSession({
      id: 'sess-queued',
      taskId: 'task-waiting',
      status: 'queued',
    }));

    const result = registry.findLiveSessionByTaskId('task-waiting');

    expect(result).toBeDefined();
    expect(result!.id).toBe('sess-queued');
    expect(result!.status).toBe('queued');
  });

  it('returned Session DTO does not have a pty field (it is a projected DTO, not a ManagedSession)', () => {
    const registry = new SessionRegistry();
    registry.set('sess-dto', makeManagedSession({
      id: 'sess-dto',
      taskId: 'task-dto',
      status: 'running',
      pty: null,
    }));

    const result = registry.findLiveSessionByTaskId('task-dto');

    expect(result).toBeDefined();
    // Session DTO must not expose the internal pty handle field
    expect('pty' in result!).toBe(false);
  });

  it('multi-entry invariant: suspended-first then running - returns the running one', () => {
    // This is the core bug shape the production fix is designed to prevent.
    // An idle-timeout suspend registers a suspended placeholder while the
    // fresh spawn is already in the registry. findLiveSessionByTaskId must
    // return the running entry regardless of insertion order.
    const registry = new SessionRegistry();

    // Insert the suspended placeholder first, then the live running spawn.
    registry.set('sess-stale', makeManagedSession({
      id: 'sess-stale',
      taskId: 'task-dual',
      status: 'suspended',
    }));
    registry.set('sess-live', makeManagedSession({
      id: 'sess-live',
      taskId: 'task-dual',
      status: 'running',
    }));

    const result = registry.findLiveSessionByTaskId('task-dual');

    expect(result).toBeDefined();
    expect(result!.id).toBe('sess-live');
    expect(result!.status).toBe('running');
  });

  it('multi-entry invariant: running-first then suspended - returns the running one', () => {
    // Same invariant, opposite insertion order. Proves the filter on
    // status is what guards the result, not the Map iteration order.
    const registry = new SessionRegistry();

    // Insert the live running spawn first, then the suspended placeholder.
    registry.set('sess-live', makeManagedSession({
      id: 'sess-live',
      taskId: 'task-reverse',
      status: 'running',
    }));
    registry.set('sess-stale', makeManagedSession({
      id: 'sess-stale',
      taskId: 'task-reverse',
      status: 'suspended',
    }));

    const result = registry.findLiveSessionByTaskId('task-reverse');

    expect(result).toBeDefined();
    expect(result!.id).toBe('sess-live');
    expect(result!.status).toBe('running');
  });

  it('does not return entries belonging to a different taskId', () => {
    const registry = new SessionRegistry();
    registry.set('sess-other', makeManagedSession({
      id: 'sess-other',
      taskId: 'task-other',
      status: 'running',
    }));

    expect(registry.findLiveSessionByTaskId('task-unrelated')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getSessionAgentName
// ---------------------------------------------------------------------------

describe('SessionRegistry.getSessionAgentName', () => {
  it('returns the stored agentName when the session exists and agentName is set', () => {
    const registry = new SessionRegistry();
    const session = makeManagedSession({ id: 'session-a', agentName: 'claude' });
    registry.set('session-a', session);

    expect(registry.getSessionAgentName('session-a')).toBe('claude');
  });

  it('returns undefined when the session id is not in the registry', () => {
    const registry = new SessionRegistry();
    // Nothing registered under this id.
    expect(registry.getSessionAgentName('session-missing')).toBeUndefined();
  });

  it('returns undefined when the session exists but agentName was not set', () => {
    const registry = new SessionRegistry();
    // Omitting agentName entirely so the field is undefined on the object.
    const session = makeManagedSession({ id: 'session-b' });
    delete (session as Partial<ManagedSession>).agentName;
    registry.set('session-b', session);

    expect(registry.getSessionAgentName('session-b')).toBeUndefined();
  });
});
