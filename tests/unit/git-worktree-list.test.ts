/**
 * Unit tests for `src/main/git/worktree-list.ts`.
 *
 * The full enumeration depends on simple-git, the project repository, and
 * the on-disk worktree state — too much surface for a focused unit test.
 * What we CAN test cheaply is that calling `enumerateWorktrees` against
 * an empty project list returns an empty result without throwing, which
 * pins the no-projects path that the MCP tool falls into when no project
 * is registered.
 *
 * The integration path (porcelain parse → branch / dirty / commit
 * resolution) is exercised by the diagnostics e2e spec where a real git
 * worktree is available.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: { getVersion: vi.fn(() => '1.0.0'), getPath: vi.fn(() => '/tmp') },
}));

vi.mock('../../src/main/db/database', () => ({
  getGlobalDb: vi.fn(() => ({
    prepare: vi.fn(() => ({
      all: vi.fn(() => []),
      get: vi.fn(() => undefined),
      run: vi.fn(),
    })),
  })),
}));

beforeEach(() => {
  vi.resetModules();
});

describe('worktree-list', () => {
  it('returns an empty array when no projects are registered', async () => {
    const { enumerateWorktrees } = await import('../../src/main/git/worktree-list');
    const result = await enumerateWorktrees();
    expect(result).toEqual([]);
  });

  it('returns an empty array when a specific projectId is unknown', async () => {
    const { enumerateWorktrees } = await import('../../src/main/git/worktree-list');
    const result = await enumerateWorktrees({ projectId: 'does-not-exist' });
    expect(result).toEqual([]);
  });
});
