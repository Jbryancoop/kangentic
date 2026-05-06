/**
 * Unit tests for `src/main/diagnostics/debug-dump-resolver.ts`.
 *
 * Covers the resolution priority:
 *   1. `developer.activityDebugOverlay` on AND project root set →
 *      `<projectRoot>/.kangentic/debug`
 *   2. Fallback to `KANGENTIC_DATA_DIR/../debug` env path
 *   3. `undefined` when neither applies
 *
 * Tests reset modules between cases because `configureDebugDumpResolver`
 * mutates a module-level singleton.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';

const ORIGINAL_DATA_DIR = process.env.KANGENTIC_DATA_DIR;

beforeEach(() => {
  delete process.env.KANGENTIC_DATA_DIR;
  // Reset module cache so each test gets a fresh `configured` singleton.
  vi.resetModules();
});

afterEach(() => {
  if (ORIGINAL_DATA_DIR === undefined) {
    delete process.env.KANGENTIC_DATA_DIR;
  } else {
    process.env.KANGENTIC_DATA_DIR = ORIGINAL_DATA_DIR;
  }
});

describe('debug-dump-resolver', () => {
  it('returns undefined when nothing is configured', async () => {
    const { resolveDebugDumpDir } = await import('../../src/main/diagnostics/debug-dump-resolver');
    expect(resolveDebugDumpDir()).toBeUndefined();
  });

  it('returns <projectRoot>/.kangentic/debug when overlay is on', async () => {
    const { resolveDebugDumpDir, configureDebugDumpResolver } = await import(
      '../../src/main/diagnostics/debug-dump-resolver'
    );
    configureDebugDumpResolver({
      getProjectRoot: () => '/tmp/some-project',
      getActivityDebugOverlayEnabled: () => true,
    });
    expect(resolveDebugDumpDir()).toBe(path.join('/tmp/some-project', '.kangentic', 'debug'));
  });

  it('falls back to env-based path when overlay is off and KANGENTIC_DATA_DIR is set', async () => {
    process.env.KANGENTIC_DATA_DIR = '/var/data/kangentic';
    const { resolveDebugDumpDir, configureDebugDumpResolver } = await import(
      '../../src/main/diagnostics/debug-dump-resolver'
    );
    configureDebugDumpResolver({
      getProjectRoot: () => '/tmp/some-project',
      getActivityDebugOverlayEnabled: () => false,
    });
    expect(resolveDebugDumpDir()).toBe(path.resolve('/var/data/kangentic', '..', 'debug'));
  });

  it('falls back to env-based path when no project root is available even with overlay on', async () => {
    process.env.KANGENTIC_DATA_DIR = '/var/data/kangentic';
    const { resolveDebugDumpDir, configureDebugDumpResolver } = await import(
      '../../src/main/diagnostics/debug-dump-resolver'
    );
    configureDebugDumpResolver({
      getProjectRoot: () => null,
      getActivityDebugOverlayEnabled: () => true,
    });
    expect(resolveDebugDumpDir()).toBe(path.resolve('/var/data/kangentic', '..', 'debug'));
  });

  it('returns undefined when overlay is off, no project, and no env var', async () => {
    const { resolveDebugDumpDir, configureDebugDumpResolver } = await import(
      '../../src/main/diagnostics/debug-dump-resolver'
    );
    configureDebugDumpResolver({
      getProjectRoot: () => null,
      getActivityDebugOverlayEnabled: () => false,
    });
    expect(resolveDebugDumpDir()).toBeUndefined();
  });
});
