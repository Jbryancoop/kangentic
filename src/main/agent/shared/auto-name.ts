import { spawn } from 'node:child_process';

const PROMPT_BUDGET = 4000; // characters of input we forward to the CLI
const OUTPUT_BUDGET = 2048; // bytes of stdout we accept before terminating
const TITLE_LIMIT = 80;
const DEFAULT_TIMEOUT_MS = 15_000;

const SYSTEM_PROMPT_PREFIX =
  'Summarize the following task description as a concise imperative title (4-8 words). '
  + 'Use Title Case. No quotes, no trailing period, no markdown formatting. '
  + 'Output exactly one line, the title only.\n\nTask description:\n';

export function buildSummarizePrompt(input: string): string {
  const trimmed = input.trim().slice(0, PROMPT_BUDGET);
  return SYSTEM_PROMPT_PREFIX + trimmed;
}

export function cleanSummarizeOutput(raw: string): string {
  let text = raw ?? '';

  text = text.replace(/```[\s\S]*?```/g, ' ');
  text = text.replace(/`/g, '');

  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? '';

  let cleaned = firstLine
    .replace(/^['"“‘]+|['"”’]+$/g, '')
    .replace(/^[*_>\-#\s]+/, '')
    .replace(/[.!?\s]+$/, '')
    .trim();

  if (cleaned.length > TITLE_LIMIT) {
    cleaned = cleaned.slice(0, TITLE_LIMIT).replace(/[\s\-_,;:]+$/, '').trim();
  }
  return cleaned;
}

/**
 * Lines whose `type` field marks them as the final assistant turn we want to
 * extract a title from. Stream-json formats vary across CLIs:
 *   - Codex / Droid emit `type: 'completion' | 'result'`
 *   - Cursor's stream-json uses `type: 'assistant'` / `type: 'message'`
 *   - Anthropic-style APIs use `type: 'assistant' | 'message_delta'`
 * We accept the union and ignore unrelated event lines (`init`, `tool_call`,
 * `tool_result`, `system`, etc.) that may carry a `text` field with metadata
 * unrelated to the assistant's response.
 */
const FINAL_MESSAGE_TYPES = new Set(['assistant', 'message', 'completion', 'result', 'final']);

/**
 * Extractor for adapters whose non-interactive output is NDJSON (one JSON object per line).
 * Walks the stream from the end and, for lines whose `type` field appears in
 * FINAL_MESSAGE_TYPES, returns the first non-empty `text` / `finalText` /
 * `content` / `delta` / `message.content` field. If no `type`-tagged line
 * matches, falls back to the same field probe on any JSON line. If neither
 * yields anything, returns the raw stdout so `cleanSummarizeOutput` can still
 * try heuristics.
 *
 * Used by Cursor (`--output-format stream-json`) and any future adapter that
 * opts into stream-json by passing this as `extractRaw` to `runCliPrintSummarize`.
 */
export function extractFinalAssistantText(stdout: string): string {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);

  // First pass: prefer lines explicitly tagged as a final assistant message.
  for (let index = lines.length - 1; index >= 0; index--) {
    const record = parseJsonLine(lines[index]);
    if (!record) continue;
    const recordType = typeof record.type === 'string' ? record.type : null;
    if (!recordType || !FINAL_MESSAGE_TYPES.has(recordType)) continue;
    const candidate = pickAssistantText(record);
    if (candidate) return candidate;
  }

  // Fallback: untagged stream (some CLIs omit `type` on the final line).
  for (let index = lines.length - 1; index >= 0; index--) {
    const record = parseJsonLine(lines[index]);
    if (!record) continue;
    const candidate = pickAssistantText(record);
    if (candidate) return candidate;
  }
  return stdout;
}

function parseJsonLine(rawLine: string): Record<string, unknown> | null {
  const line = rawLine.trim();
  if (!line.startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  return parsed as Record<string, unknown>;
}

function pickAssistantText(record: Record<string, unknown>): string | null {
  return (
    pickStringField(record, 'text')
    ?? pickStringField(record, 'finalText')
    ?? pickStringField(record, 'content')
    ?? pickStringField(record, 'delta')
    ?? pickAssistantMessage(record)
  );
}

function pickStringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function pickAssistantMessage(record: Record<string, unknown>): string | null {
  const message = record.message;
  if (typeof message === 'string' && message.trim().length > 0) return message;
  if (typeof message === 'object' && message !== null) {
    const inner = message as Record<string, unknown>;
    return pickStringField(inner, 'content') ?? pickStringField(inner, 'text');
  }
  return null;
}

export interface RunCliPrintOptions {
  cliPath: string;
  /** Fixed CLI args (subcommand, flags). When `promptVia: 'arg'`, the prompt is appended
   *  to this list as the final positional argument. */
  args: string[];
  /** Wrapped prompt text (call buildSummarizePrompt first). */
  prompt: string;
  cwd: string;
  timeoutMs?: number;
  /**
   * How the prompt is delivered to the CLI:
   *   - 'stdin' (default): piped via the child's stdin, args are unchanged.
   *   - 'arg': appended to args as the final positional argument; stdin is closed empty.
   * Use 'arg' for CLIs whose non-interactive mode requires the prompt directly on the
   * command line (Cursor `agent -p "<prompt>"`, Copilot `copilot -p "<prompt>"`).
   */
  promptVia?: 'stdin' | 'arg';
  /**
   * Optional pre-cleanup transform: receives raw stdout, returns the candidate title text
   * to feed into `cleanSummarizeOutput`. Useful when the CLI emits NDJSON / stream-json:
   * the adapter parses each line, picks the final assistant message, and returns its
   * `text` field. Returning empty string (or throwing) marks the run as a failure.
   */
  extractRaw?: (stdout: string) => string;
  /**
   * Optional environment variables merged into the spawn. Adapters that need to disable
   * a TUI banner via env var (e.g. `NO_COLOR=1`, custom analytics opt-out) supply them here.
   */
  env?: Record<string, string>;
}

/**
 * Spawns the agent's CLI in non-interactive mode, writes the prompt to stdin, captures up
 * to OUTPUT_BUDGET bytes of stdout, optionally runs an adapter-specific extractor, then
 * cleans the result into a single-line title. Throws on non-zero exit, timeout, or empty
 * output.
 */
export async function runCliPrintSummarize(options: RunCliPrintOptions): Promise<string> {
  const {
    cliPath,
    args,
    prompt,
    cwd,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    promptVia = 'stdin',
    extractRaw,
    env,
  } = options;

  return new Promise<string>((resolve, reject) => {
    const finalArgs = promptVia === 'arg' ? [...args, prompt] : args;
    const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cliPath);
    // When useShell is true, args are interpolated into a single command string and
    // parsed by cmd.exe. We single-quote-wrap the prompt as a defensive measure: any
    // embedded double quotes have been replaced upstream (see buildSummarizePrompt
    // doesn't insert any), and arbitrary user description text could otherwise be
    // mis-parsed by the shell. For non-shell spawns (macOS/Linux/Windows .exe) Node
    // passes args literally to the child without shell interpretation.
    const shellArgs = useShell ? finalArgs.map(quoteForCmdShell) : finalArgs;
    const command = useShell ? `"${cliPath}" ${shellArgs.join(' ')}` : cliPath;
    const spawnArgs = useShell ? [] : finalArgs;

    const mergedEnv = env ? { ...process.env, ...env } : process.env;

    const child = spawn(command, spawnArgs, {
      cwd,
      shell: useShell,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: mergedEnv,
    });

    let stdoutSize = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let terminated = false;

    const timer = setTimeout(() => {
      terminated = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 1000).unref();
      reject(new Error('summarize timed out'));
    }, timeoutMs);
    timer.unref();

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutSize += chunk.length;
      if (stdoutSize > OUTPUT_BUDGET) {
        terminated = true;
        child.kill('SIGTERM');
      } else {
        stdoutChunks.push(chunk);
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    const finish = (rawStdout: string, code: number | null, partial: boolean): void => {
      let candidate = rawStdout;
      if (extractRaw) {
        try {
          candidate = extractRaw(rawStdout);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
      const cleaned = cleanSummarizeOutput(candidate);
      if (cleaned) {
        resolve(cleaned);
        return;
      }
      if (partial) {
        reject(new Error('summarize terminated before producing output'));
        return;
      }
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim().slice(0, 200);
        reject(new Error(`summarize CLI exited ${code}${stderr ? `: ${stderr}` : ''}`));
        return;
      }
      reject(new Error('summarize produced empty output'));
    };

    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      finish(stdout, code, terminated);
    });

    try {
      if (promptVia === 'stdin') {
        child.stdin.end(prompt);
      } else {
        child.stdin.end();
      }
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * Quote an arbitrary argument for cmd.exe parsing when invoking via `shell: true` on
 * Windows. Wraps the value in double quotes and escapes:
 *   - embedded double quotes by doubling them ("" is the cmd convention)
 *   - percent signs by doubling them (cmd expands %VAR% inside any string, even
 *     inside double quotes; %% prevents expansion when the prompt contains
 *     env-var-like text such as a user pasting a Windows path with %APPDATA%)
 * We never run our prompt through cmd-builtin redirection or pipes, so backticks
 * and `^` need no special handling.
 * @internal Exported for unit tests only; not part of the public API.
 */
export function quoteForCmdShell(value: string): string {
  if (!/[\s"&<>|^()%]/.test(value) && value.length > 0) return value;
  const escaped = value.replace(/"/g, '""').replace(/%/g, '%%');
  return `"${escaped}"`;
}
