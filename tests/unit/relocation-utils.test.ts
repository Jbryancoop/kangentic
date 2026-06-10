/**
 * Unit tests for the shared relocation helpers
 * (src/main/agent/shared/relocation-utils.ts) used by every agent's
 * onProjectRelocated implementation.
 *
 * Generic fixture paths only - never personal or machine-specific ones.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  collectRelocationPairs,
  renameOrMergeDirectory,
  atomicWriteFileWithBackup,
  createSerialLock,
} from '../../src/main/agent/shared/relocation-utils';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relocate-utils-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('collectRelocationPairs', () => {
  // Paths live under the per-test temp root so the on-disk worktree scan never
  // collides with a real directory that happens to exist on the host.
  let OLD_PATH: string;
  let NEW_PATH: string;

  beforeEach(() => {
    OLD_PATH = path.join(tmpRoot, 'old-app');
    NEW_PATH = path.join(tmpRoot, 'new-app');
  });

  it('returns just the root pair when no worktrees or candidates exist', () => {
    const pairs = collectRelocationPairs(OLD_PATH, NEW_PATH);
    expect(pairs).toEqual([{ oldAbsolute: OLD_PATH, newAbsolute: NEW_PATH }]);
  });

  it('adds worktree pairs discovered on disk under the relocated folder', () => {
    fs.mkdirSync(path.join(NEW_PATH, '.kangentic', 'worktrees', 'feat-x'), { recursive: true });

    const pairs = collectRelocationPairs(OLD_PATH, NEW_PATH);

    expect(pairs).toContainEqual({
      oldAbsolute: path.join(OLD_PATH, '.kangentic', 'worktrees', 'feat-x'),
      newAbsolute: path.join(NEW_PATH, '.kangentic', 'worktrees', 'feat-x'),
    });
    expect(pairs).toHaveLength(2);
  });

  it('adds candidate paths under the old prefix and ignores siblings that merely share a string prefix', () => {
    const sibling = `${OLD_PATH}2`; // old-app2 is NOT under old-app
    const underOld = path.join(OLD_PATH, '.kangentic', 'worktrees', 'gone');

    const pairs = collectRelocationPairs(OLD_PATH, NEW_PATH, [underOld, sibling]);

    expect(pairs).toContainEqual({
      oldAbsolute: underOld,
      newAbsolute: path.join(NEW_PATH, '.kangentic', 'worktrees', 'gone'),
    });
    expect(pairs.some((pair) => pair.oldAbsolute === sibling)).toBe(false);
  });

  it('deduplicates a candidate that resolves to the root pair', () => {
    const pairs = collectRelocationPairs(OLD_PATH, NEW_PATH, [OLD_PATH]);
    expect(pairs).toEqual([{ oldAbsolute: OLD_PATH, newAbsolute: NEW_PATH }]);
  });
});

describe('renameOrMergeDirectory', () => {
  it('renames the source onto an absent target', () => {
    const source = path.join(tmpRoot, 'source');
    const target = path.join(tmpRoot, 'target');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'a.txt'), 'a');

    renameOrMergeDirectory(source, target);

    expect(fs.existsSync(source)).toBe(false);
    expect(fs.readFileSync(path.join(target, 'a.txt'), 'utf-8')).toBe('a');
  });

  it('merges non-colliding entries into an existing target and removes the empty source', () => {
    const source = path.join(tmpRoot, 'source');
    const target = path.join(tmpRoot, 'target');
    fs.mkdirSync(source);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(source, 'from-source.txt'), 'src');
    fs.writeFileSync(path.join(target, 'from-target.txt'), 'tgt');

    renameOrMergeDirectory(source, target);

    expect(fs.existsSync(source)).toBe(false);
    expect(fs.readFileSync(path.join(target, 'from-source.txt'), 'utf-8')).toBe('src');
    expect(fs.readFileSync(path.join(target, 'from-target.txt'), 'utf-8')).toBe('tgt');
  });

  it('leaves the colliding entry in the source and keeps the source directory', () => {
    const source = path.join(tmpRoot, 'source');
    const target = path.join(tmpRoot, 'target');
    fs.mkdirSync(source);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(source, 'dup.txt'), 'source-dup');
    fs.writeFileSync(path.join(target, 'dup.txt'), 'target-dup');

    renameOrMergeDirectory(source, target);

    expect(fs.readFileSync(path.join(target, 'dup.txt'), 'utf-8')).toBe('target-dup');
    expect(fs.existsSync(source)).toBe(true);
    expect(fs.readdirSync(source)).toEqual(['dup.txt']);
  });

  it('is a no-op when the source is missing', () => {
    const source = path.join(tmpRoot, 'missing');
    const target = path.join(tmpRoot, 'target');
    expect(() => renameOrMergeDirectory(source, target)).not.toThrow();
    expect(fs.existsSync(target)).toBe(false);
  });

  it('is a no-op when source and target are the same path', () => {
    const dir = path.join(tmpRoot, 'same');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
    renameOrMergeDirectory(dir, dir);
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf-8')).toBe('a');
  });
});

describe('atomicWriteFileWithBackup', () => {
  it('writes the new content and backs up the previous bytes', () => {
    const file = path.join(tmpRoot, 'config.json');
    fs.writeFileSync(file, 'before');

    const result = atomicWriteFileWithBackup(file, 'after');

    expect(result).toBe(true);
    expect(fs.readFileSync(file, 'utf-8')).toBe('after');
    expect(fs.readFileSync(`${file}.kangentic-backup`, 'utf-8')).toBe('before');
  });

  it('writes no backup when backup is false', () => {
    const file = path.join(tmpRoot, 'config.json');
    fs.writeFileSync(file, 'before');

    atomicWriteFileWithBackup(file, 'after', { backup: false });

    expect(fs.readFileSync(file, 'utf-8')).toBe('after');
    expect(fs.existsSync(`${file}.kangentic-backup`)).toBe(false);
  });

  it('aborts and returns false when the file to back up does not exist', () => {
    const file = path.join(tmpRoot, 'missing.json');

    const result = atomicWriteFileWithBackup(file, 'after');

    expect(result).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(`${file}.kangentic-tmp`)).toBe(false);
  });

  it('leaves no temp file behind on success', () => {
    const file = path.join(tmpRoot, 'config.json');
    fs.writeFileSync(file, 'before');

    atomicWriteFileWithBackup(file, 'after');

    expect(fs.existsSync(`${file}.kangentic-tmp`)).toBe(false);
  });
});

describe('createSerialLock', () => {
  it('runs queued operations in order, one at a time', async () => {
    const lock = createSerialLock();
    const order: number[] = [];
    const slow = (label: number, delay: number) =>
      lock(async () => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        order.push(label);
      });

    await Promise.all([slow(1, 30), slow(2, 5), slow(3, 1)]);

    expect(order).toEqual([1, 2, 3]);
  });

  it('isolates a thrown error so the next operation still runs', async () => {
    const lock = createSerialLock();
    const failing = lock(() => {
      throw new Error('boom');
    });
    await expect(failing).rejects.toThrow('boom');

    const value = await lock(() => 'ok');
    expect(value).toBe('ok');
  });
});
