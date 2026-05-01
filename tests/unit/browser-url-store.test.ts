/**
 * Unit tests for src/main/browser/browser-url-store.ts.
 *
 * Uses a real temp directory per test so the file I/O round-trip is fully
 * exercised without mocking fs. Each test gets its own tmpDir so writes
 * from one test never interfere with another.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BrowserUrlStore } from '../../src/main/browser/browser-url-store';

let tmpDir: string;
let store: BrowserUrlStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-url-store-'));
  store = new BrowserUrlStore();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

describe('BrowserUrlStore.read', () => {
  it('returns {} when the file does not exist', () => {
    expect(store.read(tmpDir)).toEqual({});
  });

  it('returns {} when the file contains corrupt JSON', () => {
    const dir = path.join(tmpDir, '.kangentic');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'browser-urls.json'), '{not valid json]');
    expect(store.read(tmpDir)).toEqual({});
  });

  it('returns {} when the file contains a JSON array (wrong shape)', () => {
    const dir = path.join(tmpDir, '.kangentic');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'browser-urls.json'), '[1,2,3]');
    expect(store.read(tmpDir)).toEqual({});
  });

  it('returns {} when the file contains a JSON null', () => {
    const dir = path.join(tmpDir, '.kangentic');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'browser-urls.json'), 'null');
    expect(store.read(tmpDir)).toEqual({});
  });

  it('returns the stored map when the file is valid', () => {
    store.set(tmpDir, 'task-1', 'https://example.com');
    expect(store.read(tmpDir)).toEqual({ 'task-1': 'https://example.com' });
  });

  it('skips non-string values during read', () => {
    // Write malformed JSON directly - a valid object but with numeric value
    const dir = path.join(tmpDir, '.kangentic');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'browser-urls.json'),
      JSON.stringify({ 'task-1': 42, 'task-2': 'https://valid.com' }),
    );
    expect(store.read(tmpDir)).toEqual({ 'task-2': 'https://valid.com' });
  });
});

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

describe('BrowserUrlStore.get', () => {
  it('returns null when no entry exists for the task', () => {
    expect(store.get(tmpDir, 'non-existent')).toBeNull();
  });

  it('returns the stored URL for the task', () => {
    store.set(tmpDir, 'task-42', 'http://localhost:3000');
    expect(store.get(tmpDir, 'task-42')).toBe('http://localhost:3000');
  });

  it('returns null for a different task when another is stored', () => {
    store.set(tmpDir, 'task-1', 'https://example.com');
    expect(store.get(tmpDir, 'task-2')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// set / get round-trip
// ---------------------------------------------------------------------------

describe('BrowserUrlStore.set', () => {
  it('persists value that is retrieved via get', () => {
    store.set(tmpDir, 'task-a', 'https://staging.example.com');
    expect(store.get(tmpDir, 'task-a')).toBe('https://staging.example.com');
  });

  it('overwrites existing value for the same task', () => {
    store.set(tmpDir, 'task-a', 'https://old.example.com');
    store.set(tmpDir, 'task-a', 'https://new.example.com');
    expect(store.get(tmpDir, 'task-a')).toBe('https://new.example.com');
  });

  it('stores multiple tasks independently', () => {
    store.set(tmpDir, 'task-1', 'https://one.example.com');
    store.set(tmpDir, 'task-2', 'https://two.example.com');
    expect(store.get(tmpDir, 'task-1')).toBe('https://one.example.com');
    expect(store.get(tmpDir, 'task-2')).toBe('https://two.example.com');
  });

  it('creates the .kangentic directory when it does not exist', () => {
    // tmpDir has no .kangentic subdir yet
    store.set(tmpDir, 'task-x', 'https://example.com');
    const filePath = path.join(tmpDir, '.kangentic', 'browser-urls.json');
    expect(fs.existsSync(filePath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// clear
// ---------------------------------------------------------------------------

describe('BrowserUrlStore.clear', () => {
  it('removes an existing entry', () => {
    store.set(tmpDir, 'task-1', 'https://example.com');
    store.clear(tmpDir, 'task-1');
    expect(store.get(tmpDir, 'task-1')).toBeNull();
  });

  it('does not write when the key is absent (no-op)', () => {
    // Store is fresh - file does not exist. After clear, file should still
    // not exist (no unnecessary write).
    store.clear(tmpDir, 'non-existent-task');
    const filePath = path.join(tmpDir, '.kangentic', 'browser-urls.json');
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('leaves other tasks intact after clearing one', () => {
    store.set(tmpDir, 'task-1', 'https://one.com');
    store.set(tmpDir, 'task-2', 'https://two.com');
    store.clear(tmpDir, 'task-1');
    expect(store.get(tmpDir, 'task-1')).toBeNull();
    expect(store.get(tmpDir, 'task-2')).toBe('https://two.com');
  });
});

// ---------------------------------------------------------------------------
// prune
// ---------------------------------------------------------------------------

describe('BrowserUrlStore.prune', () => {
  it('removes stale entries not in the active set', () => {
    store.set(tmpDir, 'task-old', 'https://stale.com');
    store.set(tmpDir, 'task-active', 'https://active.com');
    store.prune(tmpDir, new Set(['task-active']));
    expect(store.get(tmpDir, 'task-old')).toBeNull();
    expect(store.get(tmpDir, 'task-active')).toBe('https://active.com');
  });

  it('does not write when nothing is pruned', () => {
    store.set(tmpDir, 'task-1', 'https://example.com');

    // Get the file mtime before prune
    const filePath = path.join(tmpDir, '.kangentic', 'browser-urls.json');
    const mtimeBefore = fs.statSync(filePath).mtimeMs;

    // Prune with all tasks active - nothing should change
    store.prune(tmpDir, new Set(['task-1']));

    const mtimeAfter = fs.statSync(filePath).mtimeMs;
    // mtime should be unchanged since no write occurred
    expect(mtimeAfter).toBe(mtimeBefore);
  });

  it('removes all entries when active set is empty', () => {
    store.set(tmpDir, 'task-1', 'https://one.com');
    store.set(tmpDir, 'task-2', 'https://two.com');
    store.prune(tmpDir, new Set());
    expect(store.read(tmpDir)).toEqual({});
  });

  it('is a no-op when the file does not exist', () => {
    // Fresh tmpDir, no file written yet. Prune should not throw.
    expect(() => store.prune(tmpDir, new Set(['task-1']))).not.toThrow();
    const filePath = path.join(tmpDir, '.kangentic', 'browser-urls.json');
    expect(fs.existsSync(filePath)).toBe(false);
  });
});
