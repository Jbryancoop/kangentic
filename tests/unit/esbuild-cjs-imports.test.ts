import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Enforces .claude/rules/esbuild-cjs-imports.md. esbuild bundles main/preload in CJS mode
// and leaves bare require() calls unbundled, so a require('<package>') of a static string
// breaks the packaged app. Bundled TypeScript must use ES import. Intentional externals are
// allowed via the same marker ESLint uses: an eslint-disable-next-line for
// @typescript-eslint/no-require-imports on the preceding line.
//
// ESLint's no-require-imports also enforces this in CI now (ci.yml runs npm run lint). This
// vitest test is a fast, focused complement that pins the convention and the eslint-disable
// exception mechanism with a clear failure message.
//
// Scope is .ts/.tsx only. The .js bridge scripts under src/main/agent/ are not bundled and
// run as CommonJS, so require() is correct for them (and ESLint exempts them).

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCAN_DIRS = ['src/main', 'src/preload'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const REQUIRE_LITERAL = /\brequire\s*\(\s*['"]/;
const DISABLE_MARKER = /eslint-disable-next-line.*@typescript-eslint\/no-require-imports/;

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

describe('no bare require() in bundled main-process code', () => {
  it('src/main and src/preload use ES import, not require(<literal>), unless eslint-disabled', () => {
    const offenders: string[] = [];
    for (const scanDir of SCAN_DIRS) {
      const absoluteDir = path.join(REPO_ROOT, scanDir);
      if (!fs.existsSync(absoluteDir)) continue;
      for (const filePath of collectSourceFiles(absoluteDir)) {
        const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
        lines.forEach((line, index) => {
          if (isCommentLine(line)) return;
          if (!REQUIRE_LITERAL.test(line)) return;
          // Allowed when the preceding non-empty line carries the eslint-disable marker,
          // matching exactly how ESLint treats an intentional external.
          let previousIndex = index - 1;
          while (previousIndex >= 0 && lines[previousIndex].trim() === '') previousIndex--;
          const precedingLine = previousIndex >= 0 ? lines[previousIndex] : '';
          if (DISABLE_MARKER.test(precedingLine)) return;
          offenders.push(`${path.relative(REPO_ROOT, filePath).replace(/\\/g, '/')}:${index + 1}`);
        });
      }
    }
    expect(
      offenders,
      `Bundled main/preload code must use ES import, not bare require(<literal>). Mark an intentional external with // eslint-disable-next-line @typescript-eslint/no-require-imports on the preceding line.\nOffenders:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
