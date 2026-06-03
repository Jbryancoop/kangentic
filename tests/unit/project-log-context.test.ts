/**
 * Unit tests for `src/main/diagnostics/project-log-context.ts`.
 *
 * The ALS store carries a project name through an async region so the
 * log-mirror chokepoint can prefix `[projectName]` after the timestamp.
 * Verifies:
 *   - no ambient name outside any run (global logs stay untagged);
 *   - the name is visible inside a run, including across `await` boundaries;
 *   - concurrent runs are isolated (each sees only its own name) - the whole
 *     reason ALS is used over the focused-project singleton;
 *   - nested runs shadow the outer name and restore it on exit;
 *   - the combined `[timestamp] [projectName]` prefix stays printf-safe when
 *     fed through log-mirror's `prefixConsoleArgs`.
 */
import { describe, it, expect } from 'vitest';
import {
  runWithProjectLogContext,
  getCurrentProjectLogName,
} from '../../src/main/diagnostics/project-log-context';
import { prefixConsoleArgs } from '../../src/main/diagnostics/log-mirror';

function microtaskDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('project-log-context', () => {
  it('has no ambient project name outside any run', () => {
    expect(getCurrentProjectLogName()).toBeNull();
  });

  it('exposes the project name inside a run', () => {
    const seen = runWithProjectLogContext('kangentic', () => getCurrentProjectLogName());
    expect(seen).toBe('kangentic');
  });

  it('preserves the name across an await boundary', async () => {
    const seen = await runWithProjectLogContext('kangentic', async () => {
      await microtaskDelay();
      return getCurrentProjectLogName();
    });
    expect(seen).toBe('kangentic');
  });

  it('clears the ambient name after the run resolves', async () => {
    await runWithProjectLogContext('kangentic', async () => {
      await microtaskDelay();
    });
    expect(getCurrentProjectLogName()).toBeNull();
  });

  it('isolates concurrent runs - each sees only its own project', async () => {
    const results: Record<string, string | null> = {};
    await Promise.all([
      runWithProjectLogContext('alpha', async () => {
        await microtaskDelay();
        results.alpha = getCurrentProjectLogName();
      }),
      runWithProjectLogContext('beta', async () => {
        await microtaskDelay();
        results.beta = getCurrentProjectLogName();
      }),
    ]);
    expect(results.alpha).toBe('alpha');
    expect(results.beta).toBe('beta');
  });

  it('nested runs shadow the outer name and restore it on exit', () => {
    const inner = runWithProjectLogContext('outer', () => {
      const nested = runWithProjectLogContext('inner', () => getCurrentProjectLogName());
      // After the nested run returns, the outer name is restored.
      expect(getCurrentProjectLogName()).toBe('outer');
      return nested;
    });
    expect(inner).toBe('inner');
  });

  it('keeps printf specifiers aligned when the combined prefix is applied', () => {
    const now = new Date(2026, 5, 3, 13, 46, 49, 123);
    const hhmmss = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}.${String(now.getMilliseconds()).padStart(3, '0')}`;
    const prefix = `[${hhmmss}] [kangentic]`;
    expect(prefixConsoleArgs(['spawned %s for %s', 'claude', 'task-1'], prefix)).toEqual([
      '[13:46:49.123] [kangentic] spawned %s for %s',
      'claude',
      'task-1',
    ]);
    // Object first arg: the combined prefix becomes its own leading arg.
    expect(prefixConsoleArgs([{ taskId: 'abc' }], prefix)).toEqual([prefix, { taskId: 'abc' }]);
  });
});
