import { describe, it, expect } from 'vitest';
import { isPlaceholderTitle } from '../../src/renderer/lib/placeholder-title';

describe('isPlaceholderTitle', () => {
  it('treats empty and whitespace-only titles as placeholders', () => {
    expect(isPlaceholderTitle('', 'task-1')).toBe(true);
    expect(isPlaceholderTitle('   ', 'task-1')).toBe(true);
    expect(isPlaceholderTitle(null, 'task-1')).toBe(true);
    expect(isPlaceholderTitle(undefined, 'task-1')).toBe(true);
  });

  it('treats common placeholder words as placeholders (case-insensitive)', () => {
    expect(isPlaceholderTitle('fix', 'task-1')).toBe(true);
    expect(isPlaceholderTitle('Fix Bug', 'task-1')).toBe(true);
    expect(isPlaceholderTitle('FIX IT', 'task-1')).toBe(true);
    expect(isPlaceholderTitle('wip', 'task-1')).toBe(true);
    expect(isPlaceholderTitle('WIP', 'task-1')).toBe(true);
    expect(isPlaceholderTitle('TBD', 'task-1')).toBe(true);
    expect(isPlaceholderTitle('todo', 'task-1')).toBe(true);
    expect(isPlaceholderTitle('Untitled', 'task-1')).toBe(true);
    expect(isPlaceholderTitle('task', 'task-1')).toBe(true);
    expect(isPlaceholderTitle('new task', 'task-1')).toBe(true);
  });

  it('treats title equal to taskId as placeholder', () => {
    expect(isPlaceholderTitle('task-abc-123', 'task-abc-123')).toBe(true);
  });

  it('does NOT treat real titles as placeholders', () => {
    expect(isPlaceholderTitle('Wire up auto-rename toast', 'task-1')).toBe(false);
    expect(isPlaceholderTitle('Fix login bug on Safari', 'task-1')).toBe(false);
    expect(isPlaceholderTitle('Fixing race condition', 'task-1')).toBe(false);
    expect(isPlaceholderTitle('todo: refactor adapters', 'task-1')).toBe(false);
  });

  it('trims surrounding whitespace before checking', () => {
    expect(isPlaceholderTitle('  fix bug  ', 'task-1')).toBe(true);
    expect(isPlaceholderTitle('  real task  ', 'task-1')).toBe(false);
  });
});
