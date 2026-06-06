import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Keeps the CLAUDE.md "Conventions" index in sync with the actual rule files. CLAUDE.md is the
// always-loaded index of .claude/rules/; a rule that is not listed there is easy to miss. This
// test fails if a rule file exists without a pointer in CLAUDE.md, forcing the index to stay
// complete as rules are added. Rules are discovered recursively so future subdirectories under
// .claude/rules/ are covered.

const REPO_ROOT = path.resolve(__dirname, '../..');
const RULES_DIR = path.join(REPO_ROOT, '.claude', 'rules');
const CLAUDE_MD = path.join(REPO_ROOT, 'CLAUDE.md');

function collectRuleBasenames(directory: string): string[] {
  const names: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      names.push(...collectRuleBasenames(path.join(directory, entry.name)));
    } else if (entry.name.endsWith('.md')) {
      names.push(entry.name);
    }
  }
  return names;
}

describe('rules index parity', () => {
  it('every .claude/rules/*.md is referenced in the CLAUDE.md index', () => {
    const claudeMd = fs.readFileSync(CLAUDE_MD, 'utf-8');
    const ruleFiles = collectRuleBasenames(RULES_DIR);
    expect(ruleFiles.length).toBeGreaterThan(0);
    const missing = ruleFiles.filter((name) => !claudeMd.includes(name));
    expect(
      missing,
      `Rule files missing a pointer in the CLAUDE.md Conventions index:\n${missing.join('\n')}`,
    ).toEqual([]);
  });
});
