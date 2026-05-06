import { spawn } from 'node:child_process';

/**
 * Cross-platform process-tree probe.
 *
 * `isAlive(pid)` uses POSIX signal-0 semantics, which Node.js
 * implements on Windows too (via OpenProcess). EPERM is treated as
 * alive - the process exists but we lack permission to signal it.
 *
 * `listDescendants(rootPid)` enumerates the process tree rooted at
 * `rootPid` by spawning a single OS query per call:
 *   - Windows: PowerShell's `Get-CimInstance Win32_Process` with a
 *     ParentProcessId filter, walked recursively in JS.
 *   - POSIX: `ps -A -o pid=,ppid=,comm=` + a JS-side parent-map walk.
 *
 * Spawn-shell-out is the only reliable cross-platform path. Node has
 * no built-in API for descendant enumeration. Each query runs with
 * a short timeout; on timeout or non-zero exit, returns an empty
 * descendant set (degrades gracefully to "process tree unknown",
 * which the watcher treats as "no orphan signal" and falls back to
 * the escape hatch).
 */
export interface ProcessInfo {
  pid: number;
  ppid: number;
  /** Lowercase basename of the executable (e.g. "bash", "node"). */
  comm: string;
}

export interface ProcessTreeProbe {
  /** Returns true if the PID is alive (or exists but we can't signal it). */
  isAlive(pid: number): boolean;
  /**
   * Returns process info for ALL processes on the system. Spawns one
   * OS query (`Get-CimInstance` / `ps -A`). Returns [] on probe
   * failure (timeout, non-zero exit, parse error).
   *
   * The watcher's per-cycle path uses this once per cycle and shares
   * the snapshot across all sessions, walking each session's subtree
   * in JS via `walkDescendants`. This collapses what would be N
   * PowerShell spawns (one per session) on Windows into a single
   * spawn per poll cycle - critical for users running 10+ tasks in
   * parallel.
   */
  listAllProcesses(): Promise<ProcessInfo[]>;
  /**
   * Convenience wrapper: returns descendants of `rootPid`. Spawns
   * `listAllProcesses` internally. Used by one-shot callers (resume
   * reconciliation) where sharing across sessions doesn't apply.
   *
   * Returns [] on probe failure.
   */
  listDescendants(rootPid: number): Promise<ProcessInfo[]>;
}

/** Default per-spawn timeout for process enumeration. */
const PROBE_TIMEOUT_MS = 1500;

export function createProcessTreeProbe(): ProcessTreeProbe {
  if (process.platform === 'win32') {
    return new WindowsProbe();
  }
  return new PosixProbe();
}

class WindowsProbe implements ProcessTreeProbe {
  isAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      // EPERM = exists but no permission. Treat as alive.
      return code === 'EPERM';
    }
  }

  async listDescendants(rootPid: number): Promise<ProcessInfo[]> {
    const all = await this.listAllProcesses();
    if (all.length === 0) return [];
    return walkDescendants(all, rootPid);
  }

  async listAllProcesses(): Promise<ProcessInfo[]> {
    // Try PowerShell 7+ (`pwsh.exe`) first - faster startup, modern.
    // Fall back to Windows PowerShell 5.x (`powershell.exe`) which
    // ships with all supported Windows installs. If neither is
    // available, return [] and the watcher falls back to the escape
    // hatch.
    const pwsh = await runPowerShellQuery('pwsh.exe');
    if (pwsh !== null) return pwsh;
    const wps = await runPowerShellQuery('powershell.exe');
    if (wps !== null) return wps;
    return [];
  }
}

/**
 * Run the Win32_Process CSV query against a specific PowerShell
 * executable. Returns null on spawn failure (binary not found, etc.)
 * so callers can attempt a fallback. Returns [] on timeout / non-zero
 * exit / parse failure.
 */
function runPowerShellQuery(executable: string): Promise<ProcessInfo[] | null> {
  // The query: every process with ProcessId, ParentProcessId, Name.
  // CSV output is simpler than JSON (no pipeline JSON quoting issues).
  const command =
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | "
    + "ConvertTo-Csv -NoTypeInformation";
  return new Promise((resolve) => {
    let resolved = false;
    const child = spawn(
      executable,
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let stdout = '';
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill();
      resolve([]);
    }, PROBE_TIMEOUT_MS);
    timer.unref();
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8'); });
    child.on('error', () => {
      // ENOENT (binary not found) returns null so caller can try the
      // next executable. Other errors return [] (caller should NOT
      // try the fallback).
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(null);
    });
    child.on('exit', (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (code !== 0) { resolve([]); return; }
      resolve(_parseWindowsCsv(stdout));
    });
  });
}

class PosixProbe implements ProcessTreeProbe {
  isAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      return code === 'EPERM';
    }
  }

  async listDescendants(rootPid: number): Promise<ProcessInfo[]> {
    const all = await this.listAllProcesses();
    if (all.length === 0) return [];
    return walkDescendants(all, rootPid);
  }

  listAllProcesses(): Promise<ProcessInfo[]> {
    // ps -A: all processes. -o pid=,ppid=,comm=: tab-separated, no headers.
    return new Promise((resolve) => {
      const child = spawn(
        'ps',
        ['-A', '-o', 'pid=,ppid=,comm='],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      let stdout = '';
      const timer = setTimeout(() => {
        child.kill();
        resolve([]);
      }, PROBE_TIMEOUT_MS);
      timer.unref();
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8'); });
      child.on('error', () => { clearTimeout(timer); resolve([]); });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) { resolve([]); return; }
        resolve(_parsePosixPs(stdout));
      });
    });
  }
}

/**
 * Walk the parent->child map and collect all descendants of `rootPid`.
 * Cycle-safe: tracks visited PIDs.
 *
 * Exported so the bg-shell watcher can call it directly with a
 * shared `listAllProcesses` snapshot, avoiding N PowerShell spawns
 * per cycle on Windows.
 */
export function walkDescendants(all: ProcessInfo[], rootPid: number): ProcessInfo[] {
  const byParent = new Map<number, ProcessInfo[]>();
  for (const info of all) {
    let bucket = byParent.get(info.ppid);
    if (!bucket) {
      bucket = [];
      byParent.set(info.ppid, bucket);
    }
    bucket.push(info);
  }
  const result: ProcessInfo[] = [];
  const visited = new Set<number>();
  const queue: number[] = [rootPid];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    if (visited.has(parent)) continue;
    visited.add(parent);
    const children = byParent.get(parent) ?? [];
    for (const child of children) {
      if (visited.has(child.pid)) continue;
      result.push(child);
      queue.push(child.pid);
    }
  }
  return result;
}

/**
 * Parse PowerShell's CSV output for Get-CimInstance Win32_Process.
 * Format (with header):
 *   "ProcessId","ParentProcessId","Name"
 *   "1234","5678","node.exe"
 *
 * Exported with `_` prefix for direct fixture testing in
 * `tests/unit/process-tree.test.ts`. Not part of the public API.
 */
export function _parseWindowsCsv(csv: string): ProcessInfo[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length <= 1) return [];
  const result: ProcessInfo[] = [];
  // Skip header (first line)
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    if (fields.length < 3) continue;
    const pid = Number.parseInt(fields[0], 10);
    const ppid = Number.parseInt(fields[1], 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    const comm = (fields[2] ?? '').toLowerCase().replace(/\.exe$/, '');
    result.push({ pid, ppid, comm });
  }
  return result;
}

/** Parse a single CSV line. Handles double-quoted fields with escaped quotes. */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { current += '"'; i++; }
        else { inQuotes = false; }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { result.push(current); current = ''; }
      else current += ch;
    }
  }
  result.push(current);
  return result;
}

/**
 * Parse `ps -A -o pid=,ppid=,comm=` output.
 *   1234  5678  /usr/local/bin/node
 *   2345  1234  bash
 *
 * Exported with `_` prefix for direct fixture testing in
 * `tests/unit/process-tree.test.ts`. Not part of the public API.
 */
export function _parsePosixPs(output: string): ProcessInfo[] {
  const lines = output.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const result: ProcessInfo[] = [];
  for (const line of lines) {
    // Whitespace-separated; comm may contain spaces but typically doesn't
    // when emitted by ps with comm= (basename only on most platforms).
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    const commPath = match[3].trim();
    // basename
    const lastSep = Math.max(commPath.lastIndexOf('/'), commPath.lastIndexOf('\\'));
    const comm = (lastSep >= 0 ? commPath.slice(lastSep + 1) : commPath).toLowerCase();
    result.push({ pid, ppid, comm });
  }
  return result;
}

/**
 * Allow-list of basenames the bg-shell watcher treats as "this is a
 * shell, not an internal process." Claude Code's
 * `Bash(run_in_background:true)` spawns a shell wrapper (bash on
 * unix, bash/sh/cmd on Windows depending on Git Bash/WSL availability)
 * which is what we want to track. Everything else - node, npm, python,
 * tsx, etc. - is the agent CLI itself or its internal subprocesses
 * (MCP servers, package runners, test workers) which should NOT be
 * counted: they're either always present (false positives at register)
 * or grandchildren of a shell we're already counting (double-counting).
 *
 * Filter is conservative - missing a shell type causes Tier B
 * under-detection, which the 5-min escape hatch backstops. Adding a
 * non-shell entry would over-detect and prematurely synthesize
 * background_shell_end events.
 */
export const SHELL_LIKE_COMM_PATTERNS: readonly RegExp[] = [
  /^bash(?:\.exe)?$/,
  /^sh(?:\.exe)?$/,
  /^zsh(?:\.exe)?$/,
  /^fish(?:\.exe)?$/,
  /^cmd(?:\.exe)?$/,
  /^pwsh(?:\.exe)?$/,
  /^powershell(?:\.exe)?$/,
];

export function isShellLike(comm: string): boolean {
  const normalized = comm.toLowerCase();
  return SHELL_LIKE_COMM_PATTERNS.some((pat) => pat.test(normalized));
}

/**
 * Filter `descendants` down to TOPMOST shell-like processes - shells
 * whose immediate parent within the descendant set is NOT itself
 * shell-like. Used by both the bg-shell watcher (per-cycle counting)
 * and the resume reconciler (one-shot adoption).
 *
 * Rationale: `bash -c "npm test"` on Windows expands to bash -> cmd ->
 * node (npm.cmd routes through cmd.exe). Both bash and cmd match the
 * shell allowlist, but cmd is a wrapper inside bash, not a separate
 * logical bg shell. We use immediate-parent (not transitive ancestor)
 * because the agent CLI itself is sometimes launched through a shell
 * shim (pwsh -> npm-shim cmd.exe -> node[claude]). A transitive rule
 * would treat that shim cmd as a "shell-like ancestor" of every bash
 * the agent spawns and skip them all, breaking the count.
 *
 * Walking via `descendantsByPid.get(info.ppid)` returns undefined for
 * direct children of rootPid (rootPid is not in the descendant set),
 * so they always count regardless of whether rootPid itself is
 * shell-like.
 */
export function filterTopmostShellLikeDescendants(
  descendants: readonly ProcessInfo[],
  isShellLikeFn: (comm: string) => boolean = isShellLike,
): ProcessInfo[] {
  const descendantsByPid = new Map<number, ProcessInfo>();
  for (const descendant of descendants) descendantsByPid.set(descendant.pid, descendant);
  return descendants.filter((descendant) => {
    if (!isShellLikeFn(descendant.comm)) return false;
    const parent = descendantsByPid.get(descendant.ppid);
    return parent === undefined || !isShellLikeFn(parent.comm);
  });
}
