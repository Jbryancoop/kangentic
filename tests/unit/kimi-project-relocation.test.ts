/**
 * Unit tests for migrateKimiProjectData()
 * (src/main/agent/adapters/kimi/project-relocation.ts).
 *
 * Kimi keys sessions to md5(work_dir) under ~/.kimi/sessions/<hash>/ and records
 * work_dirs[].path (literal string equality) in ~/.kimi/kimi.json. Relocation
 * renames the md5 directories and rewrites the work-dir paths.
 *
 * Generic fixture paths only - never personal or machine-specific ones.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

let tmpHome: string;
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    default: { ...actual, homedir: () => tmpHome },
    homedir: () => tmpHome,
  };
});

import { migrateKimiProjectData } from '../../src/main/agent/adapters/kimi/project-relocation';

let tmpBase: string;
let OLD_PATH: string;
let NEW_PATH: string;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-relocate-'));
  tmpHome = path.join(tmpBase, 'home');
  fs.mkdirSync(tmpHome, { recursive: true });
  OLD_PATH = path.join(tmpBase, 'projects', 'old-app');
  NEW_PATH = path.join(tmpBase, 'projects', 'new-app');
  fs.mkdirSync(NEW_PATH, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

const sessionsRoot = (): string => path.join(tmpHome, '.kimi', 'sessions');
const kimiJsonPath = (): string => path.join(tmpHome, '.kimi', 'kimi.json');

/** md5 of the literal absolute path string (matches kimi-cli metadata.py). */
function kimiHash(literalPath: string): string {
  return crypto.createHash('md5').update(literalPath, 'utf8').digest('hex');
}

function writeSessionDir(dirName: string, uuid: string, content: string): void {
  const dir = path.join(sessionsRoot(), dirName, uuid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'wire.jsonl'), content, 'utf-8');
}

function writeKimiJson(workDirs: Array<Record<string, unknown>>): void {
  fs.mkdirSync(path.join(tmpHome, '.kimi'), { recursive: true });
  fs.writeFileSync(kimiJsonPath(), JSON.stringify({ work_dirs: workDirs }, null, 2), 'utf-8');
}

function readWorkDirs(): Array<Record<string, unknown>> {
  return (JSON.parse(fs.readFileSync(kimiJsonPath(), 'utf-8')) as { work_dirs: Array<Record<string, unknown>> }).work_dirs;
}

describe('migrateKimiProjectData', () => {
  it('renames the md5 session directory to the new hash', async () => {
    writeSessionDir(kimiHash(path.resolve(OLD_PATH)), 'uuid-1', 'event');

    await migrateKimiProjectData(OLD_PATH, NEW_PATH);

    expect(fs.existsSync(path.join(sessionsRoot(), kimiHash(path.resolve(OLD_PATH))))).toBe(false);
    expect(
      fs.readFileSync(path.join(sessionsRoot(), kimiHash(path.resolve(NEW_PATH)), 'uuid-1', 'wire.jsonl'), 'utf-8'),
    ).toBe('event');
  });

  it('renames a kaos-prefixed session directory variant', async () => {
    const oldVariant = `remote_${kimiHash(path.resolve(OLD_PATH))}`;
    const newVariant = `remote_${kimiHash(path.resolve(NEW_PATH))}`;
    writeSessionDir(oldVariant, 'uuid-2', 'remote-event');

    await migrateKimiProjectData(OLD_PATH, NEW_PATH);

    expect(fs.existsSync(path.join(sessionsRoot(), oldVariant))).toBe(false);
    expect(
      fs.readFileSync(path.join(sessionsRoot(), newVariant, 'uuid-2', 'wire.jsonl'), 'utf-8'),
    ).toBe('remote-event');
  });

  it('rewrites the kimi.json work-dir path, backing up and preserving other fields', async () => {
    writeKimiJson([{ path: path.resolve(OLD_PATH), kaos: 'local', last_session_id: 'sess-1' }]);
    const before = fs.readFileSync(kimiJsonPath(), 'utf-8');

    await migrateKimiProjectData(OLD_PATH, NEW_PATH);

    const workDirs = readWorkDirs();
    expect(path.relative(workDirs[0].path as string, path.resolve(NEW_PATH))).toBe('');
    expect(workDirs[0].kaos).toBe('local');
    expect(workDirs[0].last_session_id).toBe('sess-1');
    expect(fs.readFileSync(`${kimiJsonPath()}.kangentic-backup`, 'utf-8')).toBe(before);
  });

  it.runIf(process.platform === 'win32')(
    'finds the session dir via a differently-cased work_dirs literal',
    async () => {
      const storedLiteral = path.resolve(OLD_PATH).toUpperCase();
      writeKimiJson([{ path: storedLiteral, kaos: 'local', last_session_id: null }]);
      // The on-disk dir is named from md5 of the (upper-cased) stored literal.
      writeSessionDir(kimiHash(storedLiteral), 'uuid-3', 'cased');

      await migrateKimiProjectData(OLD_PATH, NEW_PATH);

      expect(fs.existsSync(path.join(sessionsRoot(), kimiHash(storedLiteral)))).toBe(false);
      expect(
        fs.readFileSync(path.join(sessionsRoot(), kimiHash(path.resolve(NEW_PATH)), 'uuid-3', 'wire.jsonl'), 'utf-8'),
      ).toBe('cased');
    },
  );

  it('migrates a worktree session dir discovered from the relocated folder', async () => {
    const worktreeName = 'feat-x';
    fs.mkdirSync(path.join(NEW_PATH, '.kangentic', 'worktrees', worktreeName), { recursive: true });
    const oldWorktree = path.join(OLD_PATH, '.kangentic', 'worktrees', worktreeName);
    const newWorktree = path.join(NEW_PATH, '.kangentic', 'worktrees', worktreeName);
    writeSessionDir(kimiHash(path.resolve(oldWorktree)), 'uuid-wt', 'wt-event');

    await migrateKimiProjectData(OLD_PATH, NEW_PATH);

    expect(
      fs.readFileSync(path.join(sessionsRoot(), kimiHash(path.resolve(newWorktree)), 'uuid-wt', 'wire.jsonl'), 'utf-8'),
    ).toBe('wt-event');
  });

  it('still migrates session dirs when kimi.json is unparsable', async () => {
    const garbage = '{ not json ';
    fs.mkdirSync(path.join(tmpHome, '.kimi'), { recursive: true });
    fs.writeFileSync(kimiJsonPath(), garbage, 'utf-8');
    writeSessionDir(kimiHash(path.resolve(OLD_PATH)), 'uuid-4', 'event');

    await migrateKimiProjectData(OLD_PATH, NEW_PATH);

    expect(fs.readFileSync(kimiJsonPath(), 'utf-8')).toBe(garbage);
    expect(fs.existsSync(path.join(sessionsRoot(), kimiHash(path.resolve(NEW_PATH)), 'uuid-4'))).toBe(true);
  });

  // Gap 5b: rewriteKimiJson has an early-return guard when raw.work_dirs is not
  // an array (!Array.isArray check at line 133 of project-relocation.ts). A
  // kimi.json that parses but whose work_dirs is null must be left byte-identical
  // while session-dir migration still proceeds via the resolved path. Distinct
  // from the unparsable-file case above: here the file is valid JSON, just with
  // a non-array work_dirs value.
  it('leaves kimi.json untouched when work_dirs is a non-array value, but still migrates session dirs', async () => {
    const nonArrayContent = JSON.stringify({ work_dirs: null, other_field: 'preserved' }, null, 2);
    fs.mkdirSync(path.join(tmpHome, '.kimi'), { recursive: true });
    fs.writeFileSync(kimiJsonPath(), nonArrayContent, 'utf-8');
    writeSessionDir(kimiHash(path.resolve(OLD_PATH)), 'uuid-6', 'event');

    await migrateKimiProjectData(OLD_PATH, NEW_PATH);

    // kimi.json is byte-identical: rewriteKimiJson returned early because
    // work_dirs is not an array.
    expect(fs.readFileSync(kimiJsonPath(), 'utf-8')).toBe(nonArrayContent);
    expect(fs.existsSync(`${kimiJsonPath()}.kangentic-backup`)).toBe(false);
    // Session directory was still renamed via the resolved path.
    expect(fs.existsSync(path.join(sessionsRoot(), kimiHash(path.resolve(NEW_PATH)), 'uuid-6'))).toBe(true);
    expect(fs.existsSync(path.join(sessionsRoot(), kimiHash(path.resolve(OLD_PATH))))).toBe(false);
  });

  it('leaves a sibling that merely shares a string prefix untouched', async () => {
    const sibling = `${OLD_PATH}2`;
    writeKimiJson([{ path: path.resolve(sibling), kaos: 'local', last_session_id: null }]);
    writeSessionDir(kimiHash(path.resolve(sibling)), 'uuid-5', 'sibling');

    await migrateKimiProjectData(OLD_PATH, NEW_PATH);

    expect(fs.existsSync(path.join(sessionsRoot(), kimiHash(path.resolve(sibling)), 'uuid-5'))).toBe(true);
    const workDirs = readWorkDirs();
    expect(path.relative(workDirs[0].path as string, path.resolve(sibling))).toBe('');
  });
});
