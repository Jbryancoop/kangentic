import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Enforces the "test filesystem writes stay under os.tmpdir()" clause of
// .claude/rules/cross-platform-parity.md.
//
// A test that writes to a hardcoded absolute root is the bug that kept main's CI red for ~5
// days: tests/unit/claude-project-relocation.test.ts did a real fs.mkdirSync against the
// literal '/projects/new-app'. That path is writable on a developer's Windows drive
// (C:\projects\new-app) but EACCES on CI's Linux runner, where /projects is the unwritable
// filesystem root. It was green on every local Windows run and red on every CI push.
//
// This is a static scan of the test SOURCE, so it fails identically on Windows and Linux,
// before the test ever runs. It is the author-time backstop the rule names; it also runs in
// /merge-back Step 0 so a Linux-violating write cannot reach the direct push.
//
// Legitimate tests derive their write target from fs.mkdtempSync(path.join(os.tmpdir(), ...))
// or a mocked home directory, so the first argument is never a hardcoded absolute string
// literal. Only such a literal is flagged here.

const REPO_ROOT = path.resolve(__dirname, '../..');
const TESTS_DIR = path.join(REPO_ROOT, 'tests');
// Authored TypeScript only. Mock-CLI fixtures under tests/fixtures (.js/.cmd/.sh) are mock
// binaries that write to caller-provided directories, not authored test logic.
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx']);

// fs write APIs, scanned by their first string-literal argument. For mkdirSync,
// writeFileSync, appendFileSync, rmSync, and mkdtempSync that argument is the write
// target. For copyFileSync, renameSync, and cpSync it is the source path; their write
// target is the second argument, which this scan does not inspect. A hardcoded absolute
// path in either position is non-portable to CI's Linux runner, so flagging the first
// argument is a conservative, useful check.
const WRITE_FUNCTIONS = [
  'mkdirSync',
  'writeFileSync',
  'appendFileSync',
  'copyFileSync',
  'renameSync',
  'rmSync',
  'mkdtempSync',
  'cpSync',
];

// Backtick built without a literal backtick so the regex source stays readable inside this
// template-free construction.
const BACKTICK = String.fromCharCode(96);
const QUOTE_CHARACTERS = `'"${BACKTICK}`;

// Matches a write call whose first argument is a STRING LITERAL, capturing the literal's raw
// source text in group 2. The pattern requires a quote immediately after the opening paren, so
// a first argument of path.join(os.tmpdir(), ...), a variable, os.tmpdir(), or a template
// literal interpolating a temp variable (e.g. `${tmpHome}/file`) never matches: there is no
// leading quote. Derived, sandboxed targets are skipped by construction.
const WRITE_CALL_PATTERN = new RegExp(
  `\\b(?:${WRITE_FUNCTIONS.join('|')})\\s*\\(\\s*([${QUOTE_CHARACTERS}])([^${QUOTE_CHARACTERS}]*)\\1`,
  'g',
);

// Absolute roots: POSIX (/projects/...), Windows drive (C:\... or C:/...), and a leading
// backslash (UNC \\server\share, or \abs). A relative path never starts with any of these.
function isAbsoluteRoot(literal: string): boolean {
  if (/^\//.test(literal)) return true;
  if (/^[A-Za-z]:[\\/]/.test(literal)) return true;
  if (/^\\/.test(literal)) return true;
  return false;
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

// Index at which a `//` line comment begins, ignoring `//` that appears inside a string literal
// (e.g. a 'http://...' URL), or -1 when the line has no trailing line comment. Used to skip a
// write call that sits inside a comment (a commented-out example) rather than being real code.
function lineCommentIndex(line: string): number {
  let openQuote: string | null = null;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (openQuote !== null) {
      if (character === '\\') {
        index++;
        continue;
      }
      if (character === openQuote) openQuote = null;
    } else if (character === "'" || character === '"' || character === BACKTICK) {
      openQuote = character;
    } else if (character === '/' && line[index + 1] === '/') {
      return index;
    }
  }
  return -1;
}

function collectTestFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(fullPath));
    } else if (SCAN_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('test filesystem writes stay under os.tmpdir()', () => {
  it('no test writes to a hardcoded absolute root', () => {
    const offenders: string[] = [];
    for (const filePath of collectTestFiles(TESTS_DIR)) {
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      lines.forEach((line, index) => {
        if (isCommentLine(line)) return;
        const commentIndex = lineCommentIndex(line);
        for (const match of line.matchAll(WRITE_CALL_PATTERN)) {
          // Skip a write call inside a trailing line comment (a commented-out example, not real
          // code), e.g. `doThing(); // fs.writeFileSync('/tmp/x', y)`.
          if (commentIndex !== -1 && match.index !== undefined && match.index >= commentIndex) {
            continue;
          }
          const literal = match[2];
          if (isAbsoluteRoot(literal)) {
            const relativePath = path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
            offenders.push(`${relativePath}:${index + 1}  ->  ${literal}`);
          }
        }
      });
    }
    expect(
      offenders,
      'A test writes to a hardcoded absolute root, which is writable on a Windows dev drive but ' +
        'EACCES on CI\'s Linux runner (green locally, red on every CI push). Derive the write ' +
        'target from fs.mkdtempSync(path.join(os.tmpdir(), ...)) or a mocked home instead. See ' +
        `.claude/rules/cross-platform-parity.md.\nOffenders:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
