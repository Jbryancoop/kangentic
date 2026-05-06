/**
 * Unit tests for `src/main/diagnostics/source-map-resolver.ts`.
 *
 * V1 of this module is intentionally a pass-through: in dev mode Vite
 * already serves modules with native source-map URLs so renderer error
 * stacks point to the original source files. Production-build source-map
 * resolution is a follow-up. These tests pin the contract so the V1
 * shape is preserved (no accidental mutation of the input record).
 */
import { describe, it, expect } from 'vitest';
import {
  resolveCrashRecord,
  resolveLogEntry,
  resolveStack,
} from '../../src/main/diagnostics/source-map-resolver';
import type { CrashRecord, LogEntry } from '../../src/shared/types';

describe('source-map-resolver (V1 pass-through)', () => {
  it('returns the stack string unchanged', () => {
    const stack = 'Error: boom\n    at handler (file:///abc.js:10:20)';
    expect(resolveStack(stack)).toBe(stack);
  });

  it('returns null when stack is null', () => {
    expect(resolveStack(null)).toBeNull();
  });

  it('returns the LogEntry unchanged', () => {
    const entry: LogEntry = {
      ts: '2026-05-06T12:00:00.000Z',
      level: 'error',
      source: 'main',
      args: ['boom'],
    };
    expect(resolveLogEntry(entry)).toEqual(entry);
  });

  it('returns CrashRecord with same stack when present', () => {
    const record: CrashRecord = {
      ts: '2026-05-06T12:00:00.000Z',
      kind: 'main-uncaught-exception',
      source: 'main',
      message: 'boom',
      stack: 'at file:///abc.js:1:1',
      origin: null,
      context: null,
      versions: { kangentic: '1.0.0', electron: '41.0.0', node: '24.0.0', chrome: '128' },
    };
    expect(resolveCrashRecord(record).stack).toBe(record.stack);
  });

  it('preserves a null stack on CrashRecord', () => {
    const record: CrashRecord = {
      ts: '2026-05-06T12:00:00.000Z',
      kind: 'render-process-gone',
      source: 'renderer',
      message: 'killed',
      stack: null,
      origin: 'http://localhost:5173/',
      context: { reason: 'killed', exitCode: 1 },
      versions: { kangentic: '1.0.0', electron: '41.0.0', node: '24.0.0', chrome: '128' },
    };
    expect(resolveCrashRecord(record).stack).toBeNull();
  });
});
