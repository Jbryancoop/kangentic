/**
 * Dev-only boot-time zombie reaper.
 *
 * Scans the OS process list for orphaned Electron processes whose
 * CommandLine references this checkout's worktree node_modules or main
 * checkout node_modules. Triggered before pruneStaleWorktreeProjects so
 * any zombie holding a worktree directory's file handles (or a stale
 * OpenSSH ControlMaster socket that blocks `git fetch`) gets cleared
 * before the next instance tries to reuse those resources.
 *
 * The whole module is loaded only inside `if (__KANGENTIC_DEV__)` blocks
 * and is dropped from production builds via esbuild dead-code
 * elimination. Production NSIS installs run from %LOCALAPPDATA%\Kangentic
 * and never match the worktree/checkout path patterns this reaper looks
 * for, so even a hypothetical production wire-up would be a no-op.
 *
 * Safety contract:
 *   - Self-skip: own PID and walked parent PIDs are never killed.
 *   - Defensive: any scan/walk failure aborts the reaper with an empty
 *     return, so a broken `Get-CimInstance` can never escalate into a
 *     wrong-process kill.
 *   - Time-capped: `scanTimeoutMs` (default 1500ms) bounds the OS-level
 *     enumeration. Caller wraps with an outer 2s race.
 */

import { spawn, type SpawnOptions } from 'node:child_process';

export interface ZombieScanOptions {
  /** Filesystem root to match orphan paths against (worktrees + node_modules). */
  projectPath: string;
  /** Time cap on the OS-level enumeration. Default 1500ms. */
  scanTimeoutMs?: number;
}

export interface ReapedProcess {
  pid: number;
  commandLine: string;
  reason: 'worktree-orphan' | 'main-checkout-orphan';
}

export interface ProcessRow {
  pid: number;
  ppid: number;
  commandLine: string;
}

const DEFAULT_SCAN_TIMEOUT_MS = 1500;

/**
 * Normalize a path for case-insensitive substring comparison on Windows
 * and forward-slash matching on every platform. Returns lowercase on
 * Windows, original case elsewhere.
 */
function normalizePath(value: string): string {
  const slashed = value.replace(/\\/g, '/');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
}

/**
 * Scan running processes via the platform-native enumerator. Returns an
 * empty array on any failure so the reaper degrades to a no-op rather
 * than throwing during boot.
 *
 * Exposed for unit-test replacement via the `_internals` export below.
 */
export async function scanProcesses(scanTimeoutMs: number): Promise<ProcessRow[]> {
  if (process.platform === 'win32') {
    return scanProcessesWindows(scanTimeoutMs);
  }
  return scanProcessesUnix(scanTimeoutMs);
}

async function scanProcessesWindows(scanTimeoutMs: number): Promise<ProcessRow[]> {
  // Filter to electron.exe + node.exe only. CommandLine includes the full
  // arg vector with paths, which is what we substring-match against.
  // ConvertTo-Json -Compress to keep stdout small.
  const psCommand =
    "Get-CimInstance Win32_Process -Filter \"Name='electron.exe' OR Name='node.exe'\" " +
    "| Select-Object ProcessId,ParentProcessId,CommandLine " +
    "| ConvertTo-Json -Compress";
  const stdout = await runCommandWithTimeout(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', psCommand],
    { timeoutMs: scanTimeoutMs, windowsHide: true },
  );
  if (!stdout) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const result: ProcessRow[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as { ProcessId?: number; ParentProcessId?: number; CommandLine?: string | null };
    if (typeof r.ProcessId !== 'number') continue;
    result.push({
      pid: r.ProcessId,
      ppid: typeof r.ParentProcessId === 'number' ? r.ParentProcessId : 0,
      commandLine: typeof r.CommandLine === 'string' ? r.CommandLine : '',
    });
  }
  return result;
}

async function scanProcessesUnix(scanTimeoutMs: number): Promise<ProcessRow[]> {
  // `ps -ax` lists every process; `-o pid=,ppid=,command=` strips headers
  // and separates fields with whitespace. command= is last so it can
  // contain spaces.
  const stdout = await runCommandWithTimeout(
    'ps',
    ['-ax', '-o', 'pid=,ppid=,command='],
    { timeoutMs: scanTimeoutMs },
  );
  if (!stdout) return [];
  const rows: ProcessRow[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const [, pidStr, ppidStr, command] = match;
    rows.push({
      pid: Number.parseInt(pidStr, 10),
      ppid: Number.parseInt(ppidStr, 10),
      commandLine: command,
    });
  }
  return rows;
}

/**
 * Build the set of PIDs that must NEVER be killed: own PID + walked
 * parent chain. The walk follows ppid pointers up to a depth ceiling to
 * avoid infinite loops on corrupt data.
 */
export function buildSelfSkipSet(rows: ProcessRow[], ownPid: number): Set<number> {
  const byPid = new Map<number, ProcessRow>();
  for (const row of rows) byPid.set(row.pid, row);

  const skip = new Set<number>([ownPid]);
  let cursor = byPid.get(ownPid);
  let depth = 0;
  while (cursor && depth < 32) {
    if (skip.has(cursor.ppid)) break;
    if (cursor.ppid <= 1) break;
    skip.add(cursor.ppid);
    cursor = byPid.get(cursor.ppid);
    depth += 1;
  }
  return skip;
}

/**
 * Filter the process list to actual zombie candidates. A process matches
 * when its CommandLine substring contains EITHER the worktree pattern
 * (preview / Playwright orphans) OR the main-checkout pattern (normal
 * `npm run dev` shutdown leaks) AND the process is genuinely orphaned
 * (parent is dead or init).
 *
 * The orphan check is critical for cross-process safety: without it the
 * reaper would kill SIBLING electron instances (concurrent Playwright
 * runs, the dogfooding `npm start` window, /preview windows). Only
 * processes whose parent has terminated are true zombies that warrant
 * cleanup.
 */
export function findZombies(
  rows: ProcessRow[],
  projectPath: string,
  skipPids: Set<number>,
): ReapedProcess[] {
  const normalizedRoot = normalizePath(projectPath);
  const worktreeNeedle = `${normalizedRoot}/.kangentic/worktrees/`;
  const mainCheckoutNeedle = `${normalizedRoot}/node_modules/electron/`;
  const livePids = new Set(rows.map((row) => row.pid));

  const reaped: ReapedProcess[] = [];
  for (const row of rows) {
    if (skipPids.has(row.pid)) continue;
    const haystack = normalizePath(row.commandLine);
    if (!haystack) continue;

    // Orphan gate: skip processes whose parent is still alive. A live
    // parent means the process is actively supervised (Playwright worker,
    // dogfooding npm start, /preview window) and must not be touched.
    // ppid <= 4 covers init/system on every platform (1 on Unix, 0/4 on
    // Windows for System/csrss).
    const parentAlive = row.ppid > 4 && livePids.has(row.ppid);
    if (parentAlive) continue;

    if (haystack.includes(worktreeNeedle) && haystack.includes('/node_modules/electron/')) {
      reaped.push({ pid: row.pid, commandLine: row.commandLine, reason: 'worktree-orphan' });
      continue;
    }
    if (haystack.includes(mainCheckoutNeedle)) {
      reaped.push({ pid: row.pid, commandLine: row.commandLine, reason: 'main-checkout-orphan' });
    }
  }
  return reaped;
}

/**
 * Kill a process and its children. Best-effort; failures are logged and
 * swallowed so one stuck PID doesn't abort the whole sweep.
 */
export async function killProcess(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    // /T walks the child tree, /F is force. Synchronous via spawn is
    // fine here because we want to know if it failed.
    try {
      await runCommandWithTimeout(
        'taskkill',
        ['/PID', String(pid), '/T', '/F'],
        { timeoutMs: 2000, windowsHide: true },
      );
    } catch (error) {
      console.warn(`[REAPER] taskkill failed for pid=${pid}:`, error);
    }
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Process may already be dead
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Process exited cleanly during the SIGTERM grace window
  }
}

/**
 * Top-level orchestration: scan, build skip set, find zombies, kill.
 * Always returns the (possibly empty) list of reaped processes; never
 * throws to the caller. Errors are logged and treated as no-op outcomes.
 */
export async function reapWorktreeElectronZombies(
  options: ZombieScanOptions,
): Promise<ReapedProcess[]> {
  const scanTimeoutMs = options.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;
  let rows: ProcessRow[];
  try {
    rows = await _internals.scanProcesses(scanTimeoutMs);
  } catch (error) {
    console.warn('[REAPER] scan failed:', error);
    return [];
  }
  if (rows.length === 0) {
    console.log('[REAPER] no processes returned by scan');
    return [];
  }

  let skipPids: Set<number>;
  try {
    skipPids = _internals.buildSelfSkipSet(rows, process.pid);
  } catch (error) {
    // Defensive: if the self-walk throws somehow, abort rather than risk
    // a wrong-process kill.
    console.warn('[REAPER] self-walk failed, aborting:', error);
    return [];
  }

  const candidates = _internals.findZombies(rows, options.projectPath, skipPids);
  if (candidates.length === 0) {
    console.log('[REAPER] no zombies found');
    return [];
  }

  const killed: ReapedProcess[] = [];
  for (const candidate of candidates) {
    try {
      await _internals.killProcess(candidate.pid);
      console.log(
        `[REAPER] killed pid=${candidate.pid} reason=${candidate.reason} cmd=${candidate.commandLine.slice(0, 200)}`,
      );
      killed.push(candidate);
    } catch (error) {
      console.warn(`[REAPER] kill failed for pid=${candidate.pid}:`, error);
    }
  }
  return killed;
}

// ---------------------------------------------------------------------------
// Internals (exposed for unit-test replacement via vi.spyOn / vi.mock)
// ---------------------------------------------------------------------------

export const _internals = {
  scanProcesses,
  buildSelfSkipSet,
  findZombies,
  killProcess,
};

// ---------------------------------------------------------------------------
// Generic spawn-with-timeout (purposefully not in git-spawn.ts because
// that module's runGitWithTimeout is hard-coded to spawn `git`)
// ---------------------------------------------------------------------------

interface RunCommandOptions {
  timeoutMs: number;
  windowsHide?: boolean;
}

function runCommandWithTimeout(
  command: string,
  args: readonly string[],
  options: RunCommandOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), options.timeoutMs);

    const spawnOptions: SpawnOptions = {
      signal: controller.signal,
      windowsHide: options.windowsHide ?? true,
      stdio: ['ignore', 'pipe', 'pipe'],
    };

    const child = spawn(command, [...args], spawnOptions);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timeoutHandle);
      if (error.name === 'AbortError' || error.code === 'ABORT_ERR') {
        reject(new Error(`${command} timed out after ${options.timeoutMs}ms`));
        return;
      }
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timeoutHandle);
      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
        return;
      }
      resolve(stdout);
    });
  });
}
