import { spawn } from 'node:child_process';

/**
 * Run a `git` subcommand via child_process.spawn with kill-on-timeout and
 * optional external cancellation. simple-git's `.raw()` provides nice
 * output formatting but no abort primitive, so any operation that can
 * hang (network fetch, worktree remove on locked file handles) needs
 * this lower-level path.
 *
 * The internal AbortController fires on the wall-clock deadline. If an
 * external `signal` is provided, its abort is forwarded to the same
 * controller so callers (superseding moves, app shutdown) can cancel
 * in-flight git ops cleanly. The forwarder is removed on settle so the
 * external signal isn't held referenced after the call resolves.
 *
 * Stdio is drained so Windows conpty buffers can't block the child on
 * write.
 */
export interface GitSpawnOptions {
  /** Wall-clock cap. On expiry the child is killed via internal AbortController. */
  timeoutMs: number;
  /** External cancellation. Race-combined with the internal timeout. */
  signal?: AbortSignal;
}

export function runGitWithTimeout(
  cwd: string,
  args: readonly string[],
  options: GitSpawnOptions,
): Promise<{ stdout: string; stderr: string }> {
  const { timeoutMs, signal: externalSignal } = options;
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    let externalAbortHandler: (() => void) | null = null;
    if (externalSignal) {
      if (externalSignal.aborted) {
        clearTimeout(timeoutHandle);
        reject(new Error(`git ${args.join(' ')} aborted before spawn`));
        return;
      }
      externalAbortHandler = () => controller.abort();
      externalSignal.addEventListener('abort', externalAbortHandler, { once: true });
    }

    const cleanup = () => {
      clearTimeout(timeoutHandle);
      if (externalSignal && externalAbortHandler) {
        externalSignal.removeEventListener('abort', externalAbortHandler);
      }
    };

    const child = spawn('git', [...args], {
      cwd,
      signal: controller.signal,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

    child.on('error', (error: NodeJS.ErrnoException) => {
      cleanup();
      if (error.name === 'AbortError' || error.code === 'ABORT_ERR') {
        const reason = externalSignal?.aborted ? 'external abort' : `timeout after ${timeoutMs}ms`;
        reject(new Error(`git ${args.join(' ')} aborted (${reason}) (child process killed)`));
        return;
      }
      reject(error);
    });

    child.on('close', (code, signalName) => {
      cleanup();
      if (signalName) {
        reject(new Error(`git ${args.join(' ')} killed by signal ${signalName} after ${timeoutMs}ms timeout`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`git ${args.join(' ')} exited with code ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Returns true if the error message indicates the timeout fired (vs a
 * normal git error like "no such branch"). Used by callers that want to
 * log the timeout case distinctly.
 */
export function isGitTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes('aborted (timeout after');
}
