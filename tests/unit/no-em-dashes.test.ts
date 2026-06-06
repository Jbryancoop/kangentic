import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Enforces .claude/rules/text-formatting.md for authored production and build code.
// Em-dashes (U+2014) render as garbled characters on Windows console code pages, so they
// are forbidden in anything we author. We scan src/ and scripts/ only: tests/ and docs/
// legitimately record em-dashes inside captured terminal output and replay fixtures, and a
// static scan cannot tell authored punctuation from recorded content. Those trees are left
// to the platform-guard review agent.

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCAN_DIRS = ['src', 'scripts'];
const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.md', '.json', '.html',
]);
// U+2014 EM DASH, built without a literal em-dash so this file stays clean.
const EM_DASH = String.fromCharCode(0x2014);

function collectTextFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTextFiles(fullPath));
    } else if (TEXT_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('no em-dashes in authored source', () => {
  it('src/ and scripts/ contain no U+2014 em-dash', () => {
    const offenders: string[] = [];
    for (const scanDir of SCAN_DIRS) {
      const absoluteDir = path.join(REPO_ROOT, scanDir);
      if (!fs.existsSync(absoluteDir)) continue;
      for (const filePath of collectTextFiles(absoluteDir)) {
        const contents = fs.readFileSync(filePath, 'utf-8');
        if (!contents.includes(EM_DASH)) continue;
        contents.split('\n').forEach((line, index) => {
          if (line.includes(EM_DASH)) {
            offenders.push(`${path.relative(REPO_ROOT, filePath).replace(/\\/g, '/')}:${index + 1}`);
          }
        });
      }
    }
    expect(
      offenders,
      `Em-dash (U+2014) is forbidden in authored code. Use a single dash '-' or restructure.\nOffenders:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
