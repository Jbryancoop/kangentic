/**
 * Unit tests for migrateDroidProjectData()
 * (src/main/agent/adapters/droid/project-relocation.ts).
 *
 * Droid keys its session files (~/.factory/sessions/<cwd-slug>/) to the
 * absolute project path. Relocation renames the slug directory.
 *
 * Generic fixture paths only - never personal or machine-specific ones.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tmpHome: string;
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    default: { ...actual, homedir: () => tmpHome },
    homedir: () => tmpHome,
  };
});

import { migrateDroidProjectData } from '../../src/main/agent/adapters/droid/project-relocation';
import { cwdToSessionSlug } from '../../src/main/agent/adapters/droid/session-id-capture';

let tmpBase: string;
let OLD_PATH: string;
let NEW_PATH: string;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'droid-relocate-'));
  tmpHome = path.join(tmpBase, 'home');
  fs.mkdirSync(tmpHome, { recursive: true });
  OLD_PATH = path.join(tmpBase, 'projects', 'old-app');
  NEW_PATH = path.join(tmpBase, 'projects', 'new-app');
  fs.mkdirSync(NEW_PATH, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

function sessionsDir(projectPath: string): string {
  return path.join(tmpHome, '.factory', 'sessions', cwdToSessionSlug(path.resolve(projectPath)));
}

function writeDir(dir: string, files: Record<string, string>): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf-8');
  }
}

describe('migrateDroidProjectData', () => {
  it('renames the session slug directory and preserves its files', async () => {
    writeDir(sessionsDir(OLD_PATH), {
      'a1b2.jsonl': 'session',
      'a1b2.settings.json': '{}',
    });

    await migrateDroidProjectData(OLD_PATH, NEW_PATH);

    expect(fs.existsSync(sessionsDir(OLD_PATH))).toBe(false);
    expect(fs.readFileSync(path.join(sessionsDir(NEW_PATH), 'a1b2.jsonl'), 'utf-8')).toBe('session');
    expect(fs.readFileSync(path.join(sessionsDir(NEW_PATH), 'a1b2.settings.json'), 'utf-8')).toBe('{}');
  });

  it('merges into an existing target dir, keeping target entries', async () => {
    writeDir(sessionsDir(OLD_PATH), { 'old.jsonl': 'old' });
    writeDir(sessionsDir(NEW_PATH), { 'new.jsonl': 'new' });

    await migrateDroidProjectData(OLD_PATH, NEW_PATH);

    expect(fs.readFileSync(path.join(sessionsDir(NEW_PATH), 'old.jsonl'), 'utf-8')).toBe('old');
    expect(fs.readFileSync(path.join(sessionsDir(NEW_PATH), 'new.jsonl'), 'utf-8')).toBe('new');
  });

  it('migrates a worktree session dir discovered from the relocated folder', async () => {
    const worktreeName = 'feat-x';
    fs.mkdirSync(path.join(NEW_PATH, '.kangentic', 'worktrees', worktreeName), { recursive: true });
    const oldWorktree = path.join(OLD_PATH, '.kangentic', 'worktrees', worktreeName);
    const newWorktree = path.join(NEW_PATH, '.kangentic', 'worktrees', worktreeName);
    writeDir(sessionsDir(oldWorktree), { 'wt.jsonl': 'wt' });

    await migrateDroidProjectData(OLD_PATH, NEW_PATH);

    expect(fs.existsSync(sessionsDir(oldWorktree))).toBe(false);
    expect(fs.readFileSync(path.join(sessionsDir(newWorktree), 'wt.jsonl'), 'utf-8')).toBe('wt');
  });

  it('does not throw and creates no target when the source dir is missing', async () => {
    await expect(migrateDroidProjectData(OLD_PATH, NEW_PATH)).resolves.toBeUndefined();
    expect(fs.existsSync(sessionsDir(NEW_PATH))).toBe(false);
  });

  it('leaves a sibling slug directory that merely shares a string prefix untouched', async () => {
    const sibling = `${OLD_PATH}2`;
    writeDir(sessionsDir(sibling), { 'sib.jsonl': 'sibling' });

    await migrateDroidProjectData(OLD_PATH, NEW_PATH);

    expect(fs.readFileSync(path.join(sessionsDir(sibling), 'sib.jsonl'), 'utf-8')).toBe('sibling');
  });
});
