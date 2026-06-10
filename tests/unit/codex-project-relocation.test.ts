/**
 * Unit tests for migrateCodexProjectData()
 * (src/main/agent/adapters/codex/project-relocation.ts).
 *
 * Codex resolves resume by session id, so the only path-keyed store it breaks on
 * relocation is the per-project trust header in ~/.codex/config.toml. The
 * migration rewrites those single-line table headers, preserving quote style,
 * the \\?\ long-path prefix, and the separator style, without a TOML parser.
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

import { migrateCodexProjectData } from '../../src/main/agent/adapters/codex/project-relocation';

let tmpBase: string;
let OLD_PATH: string;
let NEW_PATH: string;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-relocate-'));
  tmpHome = path.join(tmpBase, 'home');
  fs.mkdirSync(tmpHome, { recursive: true });
  OLD_PATH = path.join(tmpBase, 'projects', 'old-app');
  NEW_PATH = path.join(tmpBase, 'projects', 'new-app');
  fs.mkdirSync(NEW_PATH, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

const configTomlPath = (): string => path.join(tmpHome, '.codex', 'config.toml');
const forwardSlash = (projectPath: string): string => path.resolve(projectPath).replace(/\\/g, '/');
const LONG_PREFIX = '\\\\?\\'; // literal \\?\

function writeConfig(content: string): void {
  fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
  fs.writeFileSync(configTomlPath(), content, 'utf-8');
}

function readConfig(): string {
  return fs.readFileSync(configTomlPath(), 'utf-8');
}

describe('migrateCodexProjectData', () => {
  it('rewrites a single-quoted forward-slash header, preserving the body and unrelated tables', async () => {
    const content = [
      '[projects.\'' + forwardSlash(OLD_PATH) + '\']',
      'trust_level = "trusted"',
      '',
      '[projects.\'' + forwardSlash(path.join(tmpBase, 'projects', 'other')) + '\']',
      'trust_level = "trusted"',
      '',
    ].join('\n');
    writeConfig(content);
    const before = readConfig();

    await migrateCodexProjectData(OLD_PATH, NEW_PATH);

    const after = readConfig();
    expect(after).toContain('[projects.\'' + forwardSlash(NEW_PATH) + '\']');
    expect(after).not.toContain('[projects.\'' + forwardSlash(OLD_PATH) + '\']');
    // The trust body and the unrelated table survive.
    expect(after).toContain('trust_level = "trusted"');
    expect(after).toContain('[projects.\'' + forwardSlash(path.join(tmpBase, 'projects', 'other')) + '\']');
    // Backed up with the pre-migration bytes.
    expect(fs.readFileSync(`${configTomlPath()}.kangentic-backup`, 'utf-8')).toBe(before);
  });

  it.runIf(process.platform === 'win32')(
    'preserves the \\\\?\\ long-path prefix and backslash style',
    async () => {
      const oldHeader = '[projects.\'' + LONG_PREFIX + path.resolve(OLD_PATH) + '\']';
      const expectedNew = '[projects.\'' + LONG_PREFIX + path.resolve(NEW_PATH) + '\']';
      writeConfig([oldHeader, 'trust_level = "trusted"', ''].join('\n'));

      await migrateCodexProjectData(OLD_PATH, NEW_PATH);

      const after = readConfig();
      expect(after).toContain(expectedNew);
      expect(after).not.toContain(oldHeader);
    },
  );

  it('rewrites a double-quoted header, preserving the double-quote style', async () => {
    const oldHeader = '[projects."' + forwardSlash(OLD_PATH) + '"]';
    const expectedNew = '[projects."' + forwardSlash(NEW_PATH) + '"]';
    writeConfig([oldHeader, 'trust_level = "trusted"', ''].join('\n'));

    await migrateCodexProjectData(OLD_PATH, NEW_PATH);

    const after = readConfig();
    expect(after).toContain(expectedNew);
    expect(after).not.toContain(oldHeader);
  });

  it('rewrites a worktree header discovered from the relocated folder', async () => {
    const worktreeName = 'feat-x';
    fs.mkdirSync(path.join(NEW_PATH, '.kangentic', 'worktrees', worktreeName), { recursive: true });
    const oldWorktree = path.join(OLD_PATH, '.kangentic', 'worktrees', worktreeName);
    const newWorktree = path.join(NEW_PATH, '.kangentic', 'worktrees', worktreeName);
    writeConfig(['[projects.\'' + forwardSlash(oldWorktree) + '\']', 'trust_level = "trusted"', ''].join('\n'));

    await migrateCodexProjectData(OLD_PATH, NEW_PATH);

    const after = readConfig();
    expect(after).toContain('[projects.\'' + forwardSlash(newWorktree) + '\']');
  });

  it('leaves the old header in place (no write) when the target table already exists', async () => {
    const content = [
      '[projects.\'' + forwardSlash(OLD_PATH) + '\']',
      'trust_level = "trusted"',
      '',
      '[projects.\'' + forwardSlash(NEW_PATH) + '\']',
      'trust_level = "trusted"',
      '',
    ].join('\n');
    writeConfig(content);
    const before = readConfig();

    await migrateCodexProjectData(OLD_PATH, NEW_PATH);

    // Duplicate-table guard: rewriting would produce two identical tables, so the
    // file is left byte-identical and no backup is written.
    expect(readConfig()).toBe(before);
    expect(fs.existsSync(`${configTomlPath()}.kangentic-backup`)).toBe(false);
  });

  it('leaves a sibling header that merely shares a string prefix untouched', async () => {
    const sibling = `${OLD_PATH}2`;
    writeConfig(['[projects.\'' + forwardSlash(sibling) + '\']', 'trust_level = "trusted"', ''].join('\n'));
    const before = readConfig();

    await migrateCodexProjectData(OLD_PATH, NEW_PATH);

    expect(readConfig()).toBe(before);
    expect(fs.existsSync(`${configTomlPath()}.kangentic-backup`)).toBe(false);
  });

  it('does not throw and writes no backup when config.toml is absent', async () => {
    await expect(migrateCodexProjectData(OLD_PATH, NEW_PATH)).resolves.toBeUndefined();
    expect(fs.existsSync(`${configTomlPath()}.kangentic-backup`)).toBe(false);
  });

  // Gap 1: emitHeaderValue returns null for single-quoted headers whose rewritten
  // path would contain a single quote, leaving the header line byte-identical.
  // Both POSIX and win32 allow apostrophes in folder names, so no platform guard
  // is needed.
  it('leaves a single-quoted header unchanged when the new path would contain a single quote', async () => {
    // Relocate to a folder whose name contains an apostrophe. Single-quoted TOML
    // strings cannot contain a literal single quote (TOML 1.0 spec, section 3.2),
    // so emitHeaderValue returns null and the line is left byte-identical.
    const apostropheNewPath = path.join(tmpBase, "projects", "owner's-project");
    fs.mkdirSync(apostropheNewPath, { recursive: true });

    const oldHeader = '[projects.\'' + forwardSlash(OLD_PATH) + '\']';
    const unrelatedHeader = '[projects.\'' + forwardSlash(path.join(tmpBase, 'projects', 'other')) + '\']';
    const content = [
      oldHeader,
      'trust_level = "trusted"',
      '',
      unrelatedHeader,
      'trust_level = "trusted"',
      '',
    ].join('\n');
    writeConfig(content);
    const before = readConfig();

    await migrateCodexProjectData(OLD_PATH, apostropheNewPath);

    // The header must be byte-identical: emitHeaderValue returned null, so
    // changed never became true and no write occurred.
    expect(readConfig()).toBe(before);
    expect(fs.existsSync(`${configTomlPath()}.kangentic-backup`)).toBe(false);
  });

  // Gap 2: a double-quoted header whose TOML-escaped inner path contains \\
  // (representing a native backslash separator) must round-trip: the parser
  // unescapes \\\\ -> \\ -> \ and emitHeaderValue re-escapes \ -> \\\\ so the
  // rewritten key is a valid double-quoted TOML string. Guarded to win32 because
  // native backslash path separators only arise on that platform.
  it.runIf(process.platform === 'win32')(
    'round-trips a double-quoted header with backslash-escaped native path separators',
    async () => {
      // On win32, path.resolve produces native backslash separators. Writing them
      // into a double-quoted TOML key requires escaping each \ as \\.
      const nativeOld = path.resolve(OLD_PATH); // e.g. C:\tmp\...\old-app
      const nativeNew = path.resolve(NEW_PATH); // e.g. C:\tmp\...\new-app
      const escapedOld = nativeOld.replace(/\\/g, '\\\\'); // TOML escaping
      const escapedNew = nativeNew.replace(/\\/g, '\\\\');

      const oldHeader = `[projects."${escapedOld}"]`;
      const expectedNew = `[projects."${escapedNew}"]`;
      writeConfig([oldHeader, 'trust_level = "trusted"', ''].join('\n'));

      await migrateCodexProjectData(OLD_PATH, NEW_PATH);

      const after = readConfig();
      expect(after).toContain(expectedNew);
      expect(after).not.toContain(oldHeader);
      // The body line is preserved.
      expect(after).toContain('trust_level = "trusted"');
    },
  );
});
