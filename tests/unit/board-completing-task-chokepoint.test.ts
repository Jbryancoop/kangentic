import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Enforces .claude/rules/board-completing-task-chokepoint.md. Tasks mid-completion
// (dropped on Done, flying into the dropzone) are excluded from the board at exactly
// one place: KanbanBoard's `tasksPerLane` memo, which reads `completingTaskIds` and
// keeps the task out of EVERY lane during the ~700ms fly. The drag-to-Done "card
// flashes back to its source column" bug recurred 5+ times because the guard was
// applied per-lane (DoneSwimlane only) instead of at that single chokepoint, leaving
// the source lane unguarded against a loadBoard() racing the fly.
//
// This scan fails if any board lane component other than KanbanBoard.tsx references
// `completingTaskIds`, i.e. re-implements the filter per-lane. The producer side
// (addCompletingTaskId / removeCompletingTaskId / the Set definition) lives in the
// board store, outside this directory, so it is naturally out of scope.

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCAN_DIR = 'src/renderer/components/board';
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const GUARD_IDENTIFIER = 'completingTaskIds';

// The single chokepoint allowed to read the Set.
const ALLOWED_FILES = new Set(['src/renderer/components/board/KanbanBoard.tsx']);

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

function toPosix(relativePath: string): string {
  return relativePath.replace(/\\/g, '/');
}

describe('completing tasks are filtered only at the tasksPerLane chokepoint', () => {
  it('no board lane component except KanbanBoard reads completingTaskIds', () => {
    const offenders: string[] = [];
    const absoluteDir = path.join(REPO_ROOT, SCAN_DIR);
    for (const filePath of collectSourceFiles(absoluteDir)) {
      const relative = toPosix(path.relative(REPO_ROOT, filePath));
      if (ALLOWED_FILES.has(relative)) continue;
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      lines.forEach((line, index) => {
        if (line.includes(GUARD_IDENTIFIER)) {
          offenders.push(`${relative}:${index + 1}`);
        }
      });
    }
    expect(
      offenders,
      `Board lane components must not re-filter on completingTaskIds. Exclude completing tasks once ` +
        `at KanbanBoard's tasksPerLane chokepoint so they are kept out of EVERY lane (source and Done) ` +
        `for the whole fly. See .claude/rules/board-completing-task-chokepoint.md.\nOffenders:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
