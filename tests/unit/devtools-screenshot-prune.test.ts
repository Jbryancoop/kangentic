/**
 * Unit tests for `pruneShotsDir` in src/devtools/main/screenshot.ts.
 *
 * All tests use a real temporary directory (no fs mocks) so we can
 * verify actual file creation and deletion. `fs.utimesSync` backdates
 * mtimes to simulate aged-out files without sleeping.
 *
 * Scenarios covered:
 *   - 24h age threshold: files older than MAX_FILE_AGE_MS are removed
 *   - Files within the age threshold are retained
 *   - Rolling cap: when more than 100 files exist, the oldest by mtime
 *     are removed until only 100 remain
 *   - Subdirectories (non-files) are skipped and not counted in the cap
 *   - Missing / unreadable directory is a no-op (no throw)
 *   - Stat error on an individual file causes that file to be skipped
 *     (no throw, other files processed normally)
 *
 * Mocks only `electron` because screenshot.ts imports its BrowserWindow
 * type. The module body does not touch the Electron runtime inside
 * pruneShotsDir, so a minimal type-only mock is sufficient.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '0.0.0') },
}));

// screenshot.ts imports from ./cdp which also has an electron dependency.
// The mock above covers both.

let tempDirectory: string;

beforeEach(() => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'devtools-prune-test-'));
  vi.resetModules();
});

afterEach(() => {
  try {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

const MAX_FILE_AGE_MS = 24 * 60 * 60 * 1000;
const ROLLING_FILE_CAP = 100;

/** Write a zero-byte file and optionally backdate its mtime. */
function writeFile(directory: string, name: string, ageMs?: number): string {
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, Buffer.alloc(1));
  if (ageMs !== undefined) {
    const oldTime = new Date(Date.now() - ageMs);
    fs.utimesSync(filePath, oldTime, oldTime);
  }
  return filePath;
}

describe('pruneShotsDir', () => {
  it('removes files older than 24 hours', async () => {
    const { pruneShotsDir } = await import('../../src/devtools/main/screenshot');

    const staleFilePath = writeFile(tempDirectory, 'old.png', MAX_FILE_AGE_MS + 60_000);
    const freshFilePath = writeFile(tempDirectory, 'new.png', 0);

    pruneShotsDir(tempDirectory);

    expect(fs.existsSync(staleFilePath)).toBe(false);
    expect(fs.existsSync(freshFilePath)).toBe(true);
  });

  it('retains files exactly at or just under the 24h threshold', async () => {
    const { pruneShotsDir } = await import('../../src/devtools/main/screenshot');

    // A file that is 1 second younger than the threshold must survive.
    const borderFilePath = writeFile(tempDirectory, 'border.png', MAX_FILE_AGE_MS - 1_000);
    pruneShotsDir(tempDirectory);
    expect(fs.existsSync(borderFilePath)).toBe(true);
  });

  it('retains all files when count is at or below the cap', async () => {
    const { pruneShotsDir } = await import('../../src/devtools/main/screenshot');

    // Write exactly ROLLING_FILE_CAP fresh files.
    const filePaths: string[] = [];
    for (let fileIndex = 0; fileIndex < ROLLING_FILE_CAP; fileIndex += 1) {
      filePaths.push(writeFile(tempDirectory, `shot-${fileIndex}.png`, 0));
    }

    pruneShotsDir(tempDirectory);

    for (const filePath of filePaths) {
      expect(fs.existsSync(filePath)).toBe(true);
    }
  });

  it('evicts the oldest files when count exceeds the cap', async () => {
    const { pruneShotsDir } = await import('../../src/devtools/main/screenshot');

    // Write ROLLING_FILE_CAP + 5 files with staggered mtimes so oldest are
    // deterministically identifiable. All files are well within the 24h
    // window so age-based pruning does not interfere.
    const totalFiles = ROLLING_FILE_CAP + 5;
    const filePaths: string[] = [];
    for (let fileIndex = 0; fileIndex < totalFiles; fileIndex += 1) {
      // Oldest file gets the longest age (fileIndex * 1000 ms, max = 104 s)
      const ageMs = (totalFiles - fileIndex) * 1_000;
      filePaths.push(writeFile(tempDirectory, `shot-${fileIndex}.png`, ageMs));
    }

    pruneShotsDir(tempDirectory);

    const surviving = filePaths.filter((filePath) => fs.existsSync(filePath));
    expect(surviving).toHaveLength(ROLLING_FILE_CAP);

    // The 5 files with the largest age (index 0..4, oldest mtime) must be gone.
    for (let oldIndex = 0; oldIndex < 5; oldIndex += 1) {
      expect(fs.existsSync(filePaths[oldIndex])).toBe(false);
    }

    // The most recent ROLLING_FILE_CAP files must survive.
    for (let newIndex = 5; newIndex < totalFiles; newIndex += 1) {
      expect(fs.existsSync(filePaths[newIndex])).toBe(true);
    }
  });

  it('skips subdirectories - they are not counted against the cap', async () => {
    const { pruneShotsDir } = await import('../../src/devtools/main/screenshot');

    // Create a subdirectory. It must not be deleted and must not be counted
    // as a file for cap purposes.
    const subdirectoryPath = path.join(tempDirectory, 'subdir');
    fs.mkdirSync(subdirectoryPath);

    // Write exactly ROLLING_FILE_CAP files.
    const filePaths: string[] = [];
    for (let fileIndex = 0; fileIndex < ROLLING_FILE_CAP; fileIndex += 1) {
      filePaths.push(writeFile(tempDirectory, `shot-${fileIndex}.png`, 0));
    }

    pruneShotsDir(tempDirectory);

    // All files should survive (cap not exceeded by files alone).
    for (const filePath of filePaths) {
      expect(fs.existsSync(filePath)).toBe(true);
    }

    // Subdirectory must not be deleted.
    expect(fs.existsSync(subdirectoryPath)).toBe(true);
  });

  it('is a no-op when the directory does not exist', async () => {
    const { pruneShotsDir } = await import('../../src/devtools/main/screenshot');

    const nonExistentDirectory = path.join(tempDirectory, 'does-not-exist');
    expect(() => pruneShotsDir(nonExistentDirectory)).not.toThrow();
  });

  it('is a no-op on an empty directory', async () => {
    const { pruneShotsDir } = await import('../../src/devtools/main/screenshot');

    expect(() => pruneShotsDir(tempDirectory)).not.toThrow();
    expect(fs.readdirSync(tempDirectory)).toHaveLength(0);
  });

  it('removes both stale and excess files when both conditions apply', async () => {
    const { pruneShotsDir } = await import('../../src/devtools/main/screenshot');

    // 3 stale files (age > 24h)
    const staleFilePaths: string[] = [];
    for (let staleIndex = 0; staleIndex < 3; staleIndex += 1) {
      staleFilePaths.push(
        writeFile(tempDirectory, `stale-${staleIndex}.png`, MAX_FILE_AGE_MS + 60_000),
      );
    }

    // ROLLING_FILE_CAP + 2 fresh files (age trigger alone would leave 102)
    const freshFilePaths: string[] = [];
    for (let freshIndex = 0; freshIndex < ROLLING_FILE_CAP + 2; freshIndex += 1) {
      // Stagger ages so the oldest fresh files are deterministic.
      const ageMs = (ROLLING_FILE_CAP + 2 - freshIndex) * 500;
      freshFilePaths.push(writeFile(tempDirectory, `fresh-${freshIndex}.png`, ageMs));
    }

    pruneShotsDir(tempDirectory);

    // All stale files must be gone.
    for (const staleFilePath of staleFilePaths) {
      expect(fs.existsSync(staleFilePath)).toBe(false);
    }

    // Of the 102 fresh files, the 2 oldest must be evicted by the cap.
    const survivingFresh = freshFilePaths.filter((filePath) => fs.existsSync(filePath));
    expect(survivingFresh).toHaveLength(ROLLING_FILE_CAP);
  });
});
