/**
 * Unit tests for `resolveProjectContext` in
 * src/main/ipc/helpers/project-repos.ts.
 *
 * This helper is the core of the cross-project Done-drop fix: it resolves
 * the (projectId, projectPath) pair a task-scoped handler should operate on,
 * preferring the explicit `projectId` stamped by the renderer at interaction
 * time so that a project switch between the user's action and the handler
 * running cannot reroute the mutation to the wrong project's DB.
 *
 * `resolveProjectContext` is a pure function - it only reads from the context
 * object. All cases are covered with a minimal typed IpcContext stub; no
 * Electron process, DB, or PTY required.
 *
 * Covers:
 *   1. Cross-project (bug-fix path): explicit projectId != currentProjectId
 *      resolves path via projectRepo.getById, NOT currentProjectPath
 *   2. Same-project: explicit projectId === currentProjectId returns
 *      currentProjectPath without calling projectRepo.getById
 *   3. Omitted projectId (undefined): falls back to ambient context values,
 *      no getById call
 *   4. Explicit null projectId: behaves identically to omitted (null coalesces
 *      to currentProjectId)
 *   5. No project open: omitted projectId AND currentProjectId === null ->
 *      { projectId: null, projectPath: null }, no getById call
 *   6. Unknown cross-project id: getById returns undefined ->
 *      { projectId: <id>, projectPath: null }, does NOT throw
 */

import { describe, it, expect, vi } from 'vitest';
import { resolveProjectContext } from '../../src/main/ipc/helpers/project-repos';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { Project } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

function makeProject(id: string, projectPath: string): Project {
  return {
    id,
    name: 'Test Project',
    path: projectPath,
    github_url: null,
    default_agent: 'claude',
    group_id: null,
    position: 0,
    last_opened: '2026-01-01T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z',
  };
}

/**
 * Build a minimal IpcContext stub with only the fields
 * `resolveProjectContext` touches: `currentProjectId`, `currentProjectPath`,
 * and `projectRepo.getById`. Cast via `as unknown as IpcContext` so we do not
 * need to satisfy the full interface.
 */
function makeContext(opts: {
  currentProjectId: string | null;
  currentProjectPath: string | null;
  getByIdResult?: Project | undefined;
}): { context: IpcContext; getById: ReturnType<typeof vi.fn> } {
  const getById = vi.fn(() => opts.getByIdResult);
  const context = {
    currentProjectId: opts.currentProjectId,
    currentProjectPath: opts.currentProjectPath,
    projectRepo: { getById },
  } as unknown as IpcContext;
  return { context, getById };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveProjectContext', () => {
  const CURRENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const CURRENT_PATH = '/mock/projects/current';
  const OTHER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const OTHER_PATH = '/mock/projects/other';

  // -------------------------------------------------------------------------
  // Case 1: cross-project (the bug-fix branch)
  // -------------------------------------------------------------------------

  it('cross-project: resolves to the explicit projectId and looks up its path via projectRepo.getById', () => {
    const otherProject = makeProject(OTHER_ID, OTHER_PATH);
    const { context, getById } = makeContext({
      currentProjectId: CURRENT_ID,
      currentProjectPath: CURRENT_PATH,
      getByIdResult: otherProject,
    });

    const result = resolveProjectContext(context, OTHER_ID);

    expect(result.projectId).toBe(OTHER_ID);
    expect(result.projectPath).toBe(OTHER_PATH);
    // Must call getById with the explicit id to look up the path
    expect(getById).toHaveBeenCalledTimes(1);
    expect(getById).toHaveBeenCalledWith(OTHER_ID);
  });

  it('cross-project: does NOT return the ambient currentProjectPath for a different explicit projectId', () => {
    const otherProject = makeProject(OTHER_ID, OTHER_PATH);
    const { context } = makeContext({
      currentProjectId: CURRENT_ID,
      currentProjectPath: CURRENT_PATH,
      getByIdResult: otherProject,
    });

    const result = resolveProjectContext(context, OTHER_ID);

    // The path must be OTHER_PATH (from the repo), not CURRENT_PATH
    expect(result.projectPath).not.toBe(CURRENT_PATH);
    expect(result.projectPath).toBe(OTHER_PATH);
  });

  // -------------------------------------------------------------------------
  // Case 2: same-project
  // -------------------------------------------------------------------------

  it('same-project: returns currentProjectId and currentProjectPath when explicit projectId matches the current project', () => {
    const { context, getById } = makeContext({
      currentProjectId: CURRENT_ID,
      currentProjectPath: CURRENT_PATH,
    });

    const result = resolveProjectContext(context, CURRENT_ID);

    expect(result.projectId).toBe(CURRENT_ID);
    expect(result.projectPath).toBe(CURRENT_PATH);
    // Must NOT call getById - the live context already has the path
    expect(getById).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Case 3: omitted projectId (undefined) - the existing-callers path
  // -------------------------------------------------------------------------

  it('omitted projectId: falls back to currentProjectId and currentProjectPath without calling getById', () => {
    const { context, getById } = makeContext({
      currentProjectId: CURRENT_ID,
      currentProjectPath: CURRENT_PATH,
    });

    // Call without the second argument
    const result = resolveProjectContext(context);

    expect(result.projectId).toBe(CURRENT_ID);
    expect(result.projectPath).toBe(CURRENT_PATH);
    expect(getById).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Case 4: explicit null projectId
  // -------------------------------------------------------------------------

  it('explicit null projectId: behaves identically to omitted - falls back to current project', () => {
    const { context, getById } = makeContext({
      currentProjectId: CURRENT_ID,
      currentProjectPath: CURRENT_PATH,
    });

    // null coalesces to currentProjectId via ??
    const result = resolveProjectContext(context, null);

    expect(result.projectId).toBe(CURRENT_ID);
    expect(result.projectPath).toBe(CURRENT_PATH);
    expect(getById).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Case 5: no project open (currentProjectId === null, projectId omitted)
  // -------------------------------------------------------------------------

  it('no project open: returns { projectId: null, projectPath: null } without touching projectRepo', () => {
    const { context, getById } = makeContext({
      currentProjectId: null,
      currentProjectPath: null,
    });

    const result = resolveProjectContext(context);

    expect(result.projectId).toBeNull();
    expect(result.projectPath).toBeNull();
    expect(getById).not.toHaveBeenCalled();
  });

  it('no project open with explicit null: also returns { projectId: null, projectPath: null }', () => {
    const { context, getById } = makeContext({
      currentProjectId: null,
      currentProjectPath: null,
    });

    const result = resolveProjectContext(context, null);

    expect(result.projectId).toBeNull();
    expect(result.projectPath).toBeNull();
    expect(getById).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Case 6: unknown cross-project id (stale-move-after-project-delete path)
  // -------------------------------------------------------------------------

  it('unknown cross-project id: returns { projectId: <id>, projectPath: null } and does NOT throw', () => {
    // getById returns undefined (project row deleted after the action was queued)
    const { context, getById } = makeContext({
      currentProjectId: CURRENT_ID,
      currentProjectPath: CURRENT_PATH,
      getByIdResult: undefined,
    });

    let result: ReturnType<typeof resolveProjectContext> | undefined;
    expect(() => {
      result = resolveProjectContext(context, OTHER_ID);
    }).not.toThrow();

    expect(result!.projectId).toBe(OTHER_ID);
    expect(result!.projectPath).toBeNull();
    // getById must still have been called (the lookup is attempted)
    expect(getById).toHaveBeenCalledWith(OTHER_ID);
  });
});
