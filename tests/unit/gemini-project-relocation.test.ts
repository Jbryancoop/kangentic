/**
 * Unit tests for migrateGeminiProjectData()
 * (src/main/agent/adapters/gemini/project-relocation.ts).
 *
 * Gemini keys per-project data through ~/.gemini/projects.json (path -> slug),
 * with chats/history under ~/.gemini/tmp|history/<slug>/ (each carrying a
 * .project_root marker) and trust in ~/.gemini/trustedFolders.json. Relocation
 * rewrites the registry key, markers, and trust, opportunistically renaming the
 * slug directories on a basename change.
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

import { migrateGeminiProjectData } from '../../src/main/agent/adapters/gemini/project-relocation';

let tmpBase: string;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-relocate-'));
  tmpHome = path.join(tmpBase, 'home');
  fs.mkdirSync(tmpHome, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

const geminiDir = (): string => path.join(tmpHome, '.gemini');
const projectsJsonPath = (): string => path.join(geminiDir(), 'projects.json');
const trustedFoldersPath = (): string => path.join(geminiDir(), 'trustedFolders.json');

/** The path-key form Gemini stores (resolved, lowercased on win32). */
function geminiKey(projectPath: string): string {
  const resolved = path.resolve(projectPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function writeRegistry(projects: Record<string, string>): void {
  fs.mkdirSync(geminiDir(), { recursive: true });
  fs.writeFileSync(projectsJsonPath(), JSON.stringify({ projects }, null, 2), 'utf-8');
}

function readRegistry(): Record<string, string> {
  const parsed = JSON.parse(fs.readFileSync(projectsJsonPath(), 'utf-8')) as { projects: Record<string, string> };
  return parsed.projects;
}

function writeSlugDir(root: 'tmp' | 'history', slug: string, markerPath: string, chatFiles: Record<string, string> = {}): void {
  const dir = path.join(geminiDir(), root, slug);
  fs.mkdirSync(path.join(dir, 'chats'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.project_root'), markerPath, 'utf-8');
  for (const [name, content] of Object.entries(chatFiles)) {
    fs.writeFileSync(path.join(dir, 'chats', name), content, 'utf-8');
  }
}

function keyResolvingTo(projects: Record<string, string>, target: string): string | null {
  for (const key of Object.keys(projects)) {
    if (path.relative(key, path.resolve(target)) === '') return key;
  }
  return null;
}

describe('migrateGeminiProjectData - same basename move (no slug rename)', () => {
  it('rewrites the registry key and the .project_root markers, keeping the slug', async () => {
    const oldPath = path.join(tmpBase, 'locA', 'proj');
    const newPath = path.join(tmpBase, 'locB', 'proj');
    fs.mkdirSync(newPath, { recursive: true });
    const slug = 'proj';
    writeRegistry({ [geminiKey(oldPath)]: slug });
    writeSlugDir('tmp', slug, geminiKey(oldPath), { 'session-1.json': 'chat' });
    writeSlugDir('history', slug, geminiKey(oldPath));

    await migrateGeminiProjectData(oldPath, newPath);

    const projects = readRegistry();
    expect(keyResolvingTo(projects, oldPath)).toBeNull();
    const newKey = keyResolvingTo(projects, newPath);
    expect(newKey).not.toBeNull();
    expect(projects[newKey as string]).toBe(slug);

    const tmpMarker = fs.readFileSync(path.join(geminiDir(), 'tmp', slug, '.project_root'), 'utf-8').trim();
    expect(path.relative(tmpMarker, path.resolve(newPath))).toBe('');
    const historyMarker = fs.readFileSync(path.join(geminiDir(), 'history', slug, '.project_root'), 'utf-8').trim();
    expect(path.relative(historyMarker, path.resolve(newPath))).toBe('');
    expect(fs.existsSync(`${projectsJsonPath()}.kangentic-backup`)).toBe(true);
  });
});

describe('migrateGeminiProjectData - basename change', () => {
  it('renames the slug directories and updates the registry value when the new slug is free', async () => {
    const oldPath = path.join(tmpBase, 'projects', 'old-app');
    const newPath = path.join(tmpBase, 'projects', 'new-app');
    fs.mkdirSync(newPath, { recursive: true });
    writeRegistry({ [geminiKey(oldPath)]: 'old-app' });
    writeSlugDir('tmp', 'old-app', geminiKey(oldPath), { 'session-1.json': 'chat' });
    writeSlugDir('history', 'old-app', geminiKey(oldPath));

    await migrateGeminiProjectData(oldPath, newPath);

    expect(fs.existsSync(path.join(geminiDir(), 'tmp', 'old-app'))).toBe(false);
    expect(fs.readFileSync(path.join(geminiDir(), 'tmp', 'new-app', 'chats', 'session-1.json'), 'utf-8')).toBe('chat');
    expect(fs.existsSync(path.join(geminiDir(), 'history', 'new-app'))).toBe(true);

    const projects = readRegistry();
    const newKey = keyResolvingTo(projects, newPath);
    expect(projects[newKey as string]).toBe('new-app');
  });

  it('keeps the old slug and dirs when the new-basename slug is already taken, but still rewrites the key', async () => {
    const oldPath = path.join(tmpBase, 'projects', 'old-app');
    const newPath = path.join(tmpBase, 'projects', 'new-app');
    fs.mkdirSync(newPath, { recursive: true });
    writeRegistry({ [geminiKey(oldPath)]: 'old-app' });
    writeSlugDir('tmp', 'old-app', geminiKey(oldPath), { 'session-1.json': 'chat' });
    // The target slug is already occupied by an unrelated project.
    writeSlugDir('tmp', 'new-app', geminiKey(path.join(tmpBase, 'projects', 'unrelated')));

    await migrateGeminiProjectData(oldPath, newPath);

    // Old slug dir is kept (not renamed onto the occupied target).
    expect(fs.readFileSync(path.join(geminiDir(), 'tmp', 'old-app', 'chats', 'session-1.json'), 'utf-8')).toBe('chat');

    const projects = readRegistry();
    const newKey = keyResolvingTo(projects, newPath);
    expect(newKey).not.toBeNull();
    expect(projects[newKey as string]).toBe('old-app');
  });
});

describe('migrateGeminiProjectData - trustedFolders.json', () => {
  it('rewrites a forward-slash lowercase key, preserving its trust level', async () => {
    const oldPath = path.join(tmpBase, 'projects', 'old-app');
    const newPath = path.join(tmpBase, 'projects', 'new-app');
    fs.mkdirSync(newPath, { recursive: true });
    // Gemini lowercases keys only on win32 (POSIX paths are case-sensitive), so
    // simulate the lowercased form only there. A lowercased fixture key on a
    // case-sensitive Linux CI runner would never match its source path.
    const forwardSlashPath = path.resolve(oldPath).replace(/\\/g, '/');
    const forwardKey = process.platform === 'win32' ? forwardSlashPath.toLowerCase() : forwardSlashPath;
    fs.mkdirSync(geminiDir(), { recursive: true });
    fs.writeFileSync(trustedFoldersPath(), JSON.stringify({ [forwardKey]: 'TRUST_FOLDER' }, null, 2), 'utf-8');

    await migrateGeminiProjectData(oldPath, newPath);

    const entries = JSON.parse(fs.readFileSync(trustedFoldersPath(), 'utf-8')) as Record<string, string>;
    const newKey = Object.keys(entries).find((key) => path.relative(key, path.resolve(newPath)) === '');
    expect(newKey).toBeDefined();
    expect(entries[newKey as string]).toBe('TRUST_FOLDER');
    expect(Object.keys(entries).some((key) => path.relative(key, path.resolve(oldPath)) === '')).toBe(false);
  });

  it.runIf(process.platform === 'win32')(
    'rewrites a backslash native-style key preserving the backslash form',
    async () => {
      const oldPath = path.join(tmpBase, 'projects', 'old-app');
      const newPath = path.join(tmpBase, 'projects', 'new-app');
      fs.mkdirSync(newPath, { recursive: true });
      const backslashKey = path.resolve(oldPath); // native backslashes on win32
      fs.mkdirSync(geminiDir(), { recursive: true });
      fs.writeFileSync(trustedFoldersPath(), JSON.stringify({ [backslashKey]: 'TRUST_FOLDER' }, null, 2), 'utf-8');

      await migrateGeminiProjectData(oldPath, newPath);

      const entries = JSON.parse(fs.readFileSync(trustedFoldersPath(), 'utf-8')) as Record<string, string>;
      const newKey = Object.keys(entries).find((key) => path.relative(key, path.resolve(newPath)) === '');
      expect(newKey).toBeDefined();
      expect((newKey as string).includes('\\')).toBe(true);
      expect((newKey as string).includes('/')).toBe(false);
    },
  );
});

describe('migrateGeminiProjectData - rewriteProjectRootMarker resilience', () => {
  // Gap 3: when a .project_root marker's content does NOT match the old path
  // prefix (replacePathPrefix returns null), the marker file must be left
  // byte-identical. The migration still proceeds for all other steps.
  // Use a same-basename move so the slug dir is NOT renamed (keeping the marker
  // path stable), isolating the assertion to rewriteProjectRootMarker's behavior.
  it('leaves a .project_root marker untouched when its content does not match the old path', async () => {
    // Same-basename move: old locA/proj -> new locB/proj. The slug stays 'proj',
    // so the tmp/proj/ directory is not renamed and the marker path is stable.
    const oldPath = path.join(tmpBase, 'locA', 'proj');
    const newPath = path.join(tmpBase, 'locB', 'proj');
    fs.mkdirSync(oldPath, { recursive: true });
    fs.mkdirSync(newPath, { recursive: true });
    const slug = 'proj';
    writeRegistry({ [geminiKey(oldPath)]: slug });

    // Plant a .project_root that points to a completely unrelated path so that
    // replacePathPrefix returns null and the marker is left byte-identical.
    const unrelatedContent = geminiKey(path.join(tmpBase, 'completely', 'unrelated'));
    writeSlugDir('tmp', slug, unrelatedContent);
    const markerPath = path.join(geminiDir(), 'tmp', slug, '.project_root');
    const markerBefore = fs.readFileSync(markerPath, 'utf-8');

    await migrateGeminiProjectData(oldPath, newPath);

    // The registry key was rewritten (the migration itself ran), but the marker
    // was not touched because its content does not start with the old path prefix.
    expect(fs.readFileSync(markerPath, 'utf-8')).toBe(markerBefore);
  });
});

describe('migrateGeminiProjectData - mirrorPathStyle win32 lowercase', () => {
  // Gap 4: when the registry key is all-lowercase on win32, mirrorPathStyle
  // lowercases the entire rewritten key, including any uppercase characters in
  // the new basename. The emitted key must be fully lowercase.
  it.runIf(process.platform === 'win32')(
    'emits a fully-lowercased registry key when the original key is all-lowercase',
    async () => {
      // Use path segments with mixed case so we can detect whether the output
      // is lowercased. tmpBase may already have a mix of cases on win32.
      const oldPath = path.join(tmpBase, 'projects', 'OldProject');
      const newPath = path.join(tmpBase, 'projects', 'NewProject');
      fs.mkdirSync(oldPath, { recursive: true });
      fs.mkdirSync(newPath, { recursive: true });

      // Gemini stores the key as a lowercased resolved path on win32.
      const allLowercaseKey = path.resolve(oldPath).toLowerCase();
      writeRegistry({ [allLowercaseKey]: 'oldproject' });

      await migrateGeminiProjectData(oldPath, newPath);

      const projects = readRegistry();
      const newKey = Object.keys(projects).find((key) => {
        // The new key should resolve to newPath under case-insensitive comparison.
        return path.resolve(key).toLowerCase() === path.resolve(newPath).toLowerCase();
      });
      expect(newKey).toBeDefined();
      // The emitted key must be all-lowercase (mirrorPathStyle lowercases when
      // the template is all-lowercase on win32).
      expect(newKey).toBe((newKey as string).toLowerCase());
    },
  );
});

describe('migrateGeminiProjectData - resilience', () => {
  it('leaves an unparsable projects.json byte-identical', async () => {
    const oldPath = path.join(tmpBase, 'projects', 'old-app');
    const newPath = path.join(tmpBase, 'projects', 'new-app');
    fs.mkdirSync(newPath, { recursive: true });
    const garbage = '{ not json ';
    fs.mkdirSync(geminiDir(), { recursive: true });
    fs.writeFileSync(projectsJsonPath(), garbage, 'utf-8');

    await expect(migrateGeminiProjectData(oldPath, newPath)).resolves.toBeUndefined();

    expect(fs.readFileSync(projectsJsonPath(), 'utf-8')).toBe(garbage);
  });

  it('leaves a sibling registry key that merely shares a string prefix untouched', async () => {
    const oldPath = path.join(tmpBase, 'projects', 'old-app');
    const newPath = path.join(tmpBase, 'projects', 'new-app');
    const sibling = `${oldPath}2`;
    fs.mkdirSync(newPath, { recursive: true });
    writeRegistry({ [geminiKey(oldPath)]: 'old-app', [geminiKey(sibling)]: 'old-app2' });

    await migrateGeminiProjectData(oldPath, newPath);

    const projects = readRegistry();
    const siblingKey = keyResolvingTo(projects, sibling);
    expect(siblingKey).not.toBeNull();
    expect(projects[siblingKey as string]).toBe('old-app2');
  });
});
