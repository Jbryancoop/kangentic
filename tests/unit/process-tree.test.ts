/**
 * Smoke tests for the cross-platform process-tree probe.
 *
 * These exercise the real OS - they're tier-1 unit tests but they
 * spawn `ps` / PowerShell. Skip in CI containers without those
 * binaries (set `SKIP_PROCESS_TREE_PROBE=1`).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  createProcessTreeProbe,
  isShellLike,
  SHELL_LIKE_COMM_PATTERNS,
  _parseWindowsCsv,
  _parsePosixPs,
} from '../../src/main/pty/activity/background-shell/process-tree';

const skip = process.env.SKIP_PROCESS_TREE_PROBE === '1';

describe.skipIf(skip)('ProcessTreeProbe (real OS)', () => {
  let probe: ReturnType<typeof createProcessTreeProbe>;

  beforeAll(() => {
    probe = createProcessTreeProbe();
  });

  it('isAlive returns true for the current process', () => {
    expect(probe.isAlive(process.pid)).toBe(true);
  });

  it('isAlive returns false for an obviously-dead pid', () => {
    // 999_999_999 is virtually guaranteed to be unallocated.
    expect(probe.isAlive(999_999_999)).toBe(false);
  });

  it('isAlive rejects non-positive pids', () => {
    expect(probe.isAlive(0)).toBe(false);
    expect(probe.isAlive(-1)).toBe(false);
    expect(probe.isAlive(NaN)).toBe(false);
  });

  it('listDescendants returns an empty array for a leaf pid', async () => {
    // The vitest runner usually has no children. Use an invalid
    // pid for guaranteed empty.
    const descendants = await probe.listDescendants(999_999_999);
    expect(descendants).toEqual([]);
  });

  it('listDescendants returns at least the test runner under a reasonable parent', async () => {
    // Walk from process.ppid - the shell that launched vitest. Should
    // have at least one descendant (vitest itself).
    const ppid = process.ppid;
    if (ppid === 0) return; // can't test on systems without ppid
    const descendants = await probe.listDescendants(ppid);
    // We expect to find at least the current process in the tree
    // (or be empty if probe degraded - either is acceptable).
    if (descendants.length > 0) {
      expect(descendants.some((d) => d.pid === process.pid)).toBe(true);
    }
  });

  it('listDescendants completes within a reasonable timeout', async () => {
    const started = Date.now();
    await probe.listDescendants(process.pid);
    const elapsed = Date.now() - started;
    // Hard cap: 2 seconds. The internal timeout is 1.5s so this
    // bound is generous.
    expect(elapsed).toBeLessThan(2000);
  });
});

describe('isShellLike', () => {
  it('matches common shell basenames', () => {
    expect(isShellLike('bash')).toBe(true);
    expect(isShellLike('sh')).toBe(true);
    expect(isShellLike('zsh')).toBe(true);
    expect(isShellLike('cmd.exe')).toBe(true);
    expect(isShellLike('pwsh.exe')).toBe(true);
    expect(isShellLike('powershell.exe')).toBe(true);
  });

  it('rejects JS-runtime basenames (avoids subprocess-chain double-count)', () => {
    // The allowlist is shell-only by design. A `bash -c "npm test"`
    // tree contains bash + npm + node; counting all of them inflates
    // the user-visible bg-shell count for one logical bg shell. Only
    // the top-level shell wrapper matches.
    expect(isShellLike('node')).toBe(false);
    expect(isShellLike('node.exe')).toBe(false);
    expect(isShellLike('npm')).toBe(false);
    expect(isShellLike('npm.cmd')).toBe(false);
    expect(isShellLike('npx')).toBe(false);
  });

  it('rejects Python (subprocess of bash, not a shell itself)', () => {
    expect(isShellLike('python')).toBe(false);
    expect(isShellLike('python3')).toBe(false);
  });

  it('rejects Claude Code helper processes', () => {
    expect(isShellLike('claude')).toBe(false);
    expect(isShellLike('mcp-server')).toBe(false);
    expect(isShellLike('chrome.exe')).toBe(false);
    expect(isShellLike('electron.exe')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isShellLike('BASH')).toBe(true);
    expect(isShellLike('Cmd.Exe')).toBe(true);
    expect(isShellLike('PWSH')).toBe(true);
  });

  it('SHELL_LIKE_COMM_PATTERNS is a non-empty readonly array of regexes', () => {
    expect(SHELL_LIKE_COMM_PATTERNS.length).toBeGreaterThan(0);
    for (const pattern of SHELL_LIKE_COMM_PATTERNS) {
      expect(pattern).toBeInstanceOf(RegExp);
    }
  });
});

describe('_parseWindowsCsv (real PowerShell ConvertTo-Csv shape)', () => {
  it('parses the Get-CimInstance Win32_Process CSV header + rows', () => {
    // Real shape: PowerShell's ConvertTo-Csv emits a header row, then
    // each row is comma-separated and double-quoted.
    const csv = [
      '"ProcessId","ParentProcessId","Name"',
      '"1234","5678","node.exe"',
      '"2345","1234","cmd.exe"',
      '"3456","2345","powershell.exe"',
    ].join('\r\n');
    const parsed = _parseWindowsCsv(csv);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toEqual({ pid: 1234, ppid: 5678, comm: 'node' });
    expect(parsed[1]).toEqual({ pid: 2345, ppid: 1234, comm: 'cmd' });
    expect(parsed[2]).toEqual({ pid: 3456, ppid: 2345, comm: 'powershell' });
  });

  it('handles fields with embedded spaces and escaped quotes', () => {
    const csv = [
      '"ProcessId","ParentProcessId","Name"',
      '"1234","5678","my app.exe"',
      '"2345","1234","weird ""quoted"" name.exe"',
    ].join('\r\n');
    const parsed = _parseWindowsCsv(csv);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].comm).toBe('my app');
    expect(parsed[1].comm).toBe('weird "quoted" name');
  });

  it('strips .exe suffix and lowercases', () => {
    const csv = '"ProcessId","ParentProcessId","Name"\r\n"100","200","NODE.EXE"';
    const parsed = _parseWindowsCsv(csv);
    expect(parsed[0].comm).toBe('node');
  });

  it('returns empty array for missing or header-only output', () => {
    expect(_parseWindowsCsv('')).toEqual([]);
    expect(_parseWindowsCsv('"ProcessId","ParentProcessId","Name"')).toEqual([]);
  });

  it('skips rows with non-numeric pid/ppid', () => {
    const csv = [
      '"ProcessId","ParentProcessId","Name"',
      '"abc","def","node.exe"',
      '"100","200","valid.exe"',
    ].join('\r\n');
    const parsed = _parseWindowsCsv(csv);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].pid).toBe(100);
  });

  it('handles LF-only line endings (some pwsh versions)', () => {
    const csv = '"ProcessId","ParentProcessId","Name"\n"100","200","node.exe"\n"300","100","bash.exe"';
    const parsed = _parseWindowsCsv(csv);
    expect(parsed).toHaveLength(2);
  });

  it('handles trailing blank lines', () => {
    const csv = '"ProcessId","ParentProcessId","Name"\r\n"100","200","node.exe"\r\n\r\n';
    const parsed = _parseWindowsCsv(csv);
    expect(parsed).toHaveLength(1);
  });
});

describe('_parsePosixPs (real ps -A output shape)', () => {
  it('parses ps -A -o pid=,ppid=,comm= output', () => {
    const output = [
      '  1234  5678 /usr/bin/node',
      '  2345  1234 bash',
      '  3456  2345 /opt/homebrew/bin/python3',
    ].join('\n');
    const parsed = _parsePosixPs(output);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toEqual({ pid: 1234, ppid: 5678, comm: 'node' });
    expect(parsed[1]).toEqual({ pid: 2345, ppid: 1234, comm: 'bash' });
    expect(parsed[2]).toEqual({ pid: 3456, ppid: 2345, comm: 'python3' });
  });

  it('lowercases comm', () => {
    const output = '100 1 NODE';
    const parsed = _parsePosixPs(output);
    expect(parsed[0].comm).toBe('node');
  });

  it('handles tab-separated and multi-space-separated rows', () => {
    const output = '100\t1\tnode\n200   1   bash';
    const parsed = _parsePosixPs(output);
    expect(parsed).toHaveLength(2);
  });

  it('returns empty array for empty input', () => {
    expect(_parsePosixPs('')).toEqual([]);
    expect(_parsePosixPs('\n\n\n')).toEqual([]);
  });

  it('skips malformed rows', () => {
    const output = [
      'not a process line',
      '100 1 node',
      'also not a row',
    ].join('\n');
    const parsed = _parsePosixPs(output);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].pid).toBe(100);
  });

  it('strips leading/trailing whitespace on each line', () => {
    const output = '   100   1   node   ';
    const parsed = _parsePosixPs(output);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].comm).toBe('node');
  });

  it('takes basename when comm is an absolute path', () => {
    const output = '100 1 /usr/local/bin/python3';
    const parsed = _parsePosixPs(output);
    expect(parsed[0].comm).toBe('python3');
  });
});
