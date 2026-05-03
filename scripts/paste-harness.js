#!/usr/bin/env node
/**
 * Paste-reliability test harness.
 *
 * Spawns a real agent CLI (Claude / Codex / Gemini / Aider / etc.) in a
 * node-pty PTY, sends a payload via a chosen submit strategy, captures
 * every byte the agent emits, and reports whether the agent appeared to
 * receive the prompt and start processing.
 *
 * The harness exists because the embedded browser pane and TerminalSubmitScheduler
 * both need RELIABLE paste-and-submit across all agents and OSes, and we
 * need to observe ground-truth byte timing to debug it. Pure unit tests
 * can't reproduce ConPTY/Ink/React-commit behavior.
 *
 * Usage:
 *   node scripts/paste-harness.js [options]
 *
 * Options:
 *   --agent <command>      Agent CLI to spawn. Default: 'claude'
 *   --args <args>          Quoted args string for the agent. Default: ''
 *   --cwd <path>           Working directory for the agent. Default: cwd
 *   --strategy <name>      Submit strategy. See STRATEGIES below. Default: 'all'
 *   --payload <name>       Payload preset: 'small' | 'medium' | 'large'.
 *                          Default: 'medium'.
 *   --custom-payload <s>   Override payload with literal string (escaped \n etc).
 *   --warmup <ms>          Wait this long after spawn before sending paste.
 *                          Default: 4000.
 *   --observe <ms>         Wait this long after submit before reporting.
 *                          Default: 8000.
 *   --quiet                Don't print every byte; only summary.
 *   --json                 Emit machine-readable JSON summary at end.
 *   --runs <n>             Repeat each strategy n times. Default: 1.
 *
 * Strategies:
 *   combined-cr            \e[200~PAYLOAD\e[201~\r   single write (engine v1)
 *   separate-cr            paste, drain, settle, \r  (engine current)
 *   delay-200-cr           paste, 200ms, \r
 *   delay-500-cr           paste, 500ms, \r
 *   delay-1000-cr          paste, 1000ms, \r
 *   delay-2000-cr          paste, 2000ms, \r
 *   double-cr              paste, settle, \r\r       (two enters)
 *   lf-only                paste, settle, \n         (linefeed instead of CR)
 *   crlf                   paste, settle, \r\n
 *   plain-cr               no markers, raw text + \r (control)
 *   no-submit              paste, no submit key      (placeholder verify)
 *   all                    run every strategy in sequence
 *
 * Detection:
 *   The harness watches for output bytes that indicate the agent received
 *   our prompt and started processing. Heuristics:
 *     - Increase in output volume after submit
 *     - Specific substrings (configurable per agent)
 *     - Activity hooks (not used; see paste-engine.ts for that path)
 */

const path = require('node:path');
const process = require('node:process');

let pty;
try {
  pty = require('node-pty');
} catch (error) {
  console.error('Failed to load node-pty. Try: npm rebuild node-pty');
  console.error('Error:', error.message);
  process.exit(1);
}

// --- Argument parsing ----------------------------------------------------

function parseArgs(argv) {
  const args = {
    agent: 'claude',
    agentArgs: '',
    cwd: process.cwd(),
    strategy: 'all',
    payload: 'medium',
    customPayload: null,
    warmup: 4000,
    observe: 8000,
    quiet: false,
    json: false,
    runs: 1,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--args') args.agentArgs = argv[++i];
    else if (arg === '--cwd') args.cwd = argv[++i];
    else if (arg === '--strategy') args.strategy = argv[++i];
    else if (arg === '--payload') args.payload = argv[++i];
    else if (arg === '--custom-payload') args.customPayload = argv[++i];
    else if (arg === '--warmup') args.warmup = parseInt(argv[++i], 10);
    else if (arg === '--observe') args.observe = parseInt(argv[++i], 10);
    else if (arg === '--quiet') args.quiet = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--runs') args.runs = parseInt(argv[++i], 10);
    else if (arg === '--warm-conversation') args.warmConversation = true;
    else if (arg === '--shell-wrap') args.shellWrap = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      console.log(require('node:fs').readFileSync(__filename, 'utf8').split('\n').slice(1, 50).join('\n'));
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${arg}`);
      process.exit(1);
    }
  }
  return args;
}

// --- Payloads ------------------------------------------------------------

const PAYLOADS = {
  small: 'What is 1 + 1?',
  medium: [
    'Look at this picked element and tell me which file it is rendered from.',
    '',
    '<browser_context>',
    '  <url>https://example.com/</url>',
    '  <picked_element>',
    '    <selector>section.hero > p.heading</selector>',
    '    <classes>heading, font-bold</classes>',
    '    <accessible_name>Welcome to the test</accessible_name>',
    '    <rect x="100" y="200" width="600" height="80" />',
    '    <styles>',
    '      color: rgb(50, 50, 50)',
    '      fontSize: 32px',
    '      fontWeight: 700',
    '    </styles>',
    '    <ancestors>div.container > main > section.hero</ancestors>',
    '  </picked_element>',
    '</browser_context>',
  ].join('\n'),
  large: (() => {
    const lines = [
      'Look at this picked element and tell me which file it is rendered from.',
      '',
      '<browser_context>',
      '  <url>https://example.com/some/very/long/path?with=querystring&and=multiple&parameters=here</url>',
      '  <picked_element>',
      '    <selector>div.app > main.layout > section.hero-container > div.hero-content > div.w-full > p.hero-heading.font-heading.font-light</selector>',
      '    <classes>hero-heading, font-heading, font-light, leading-none, text-center, text-text-primary, max-w-4xl, mx-auto, mb-12</classes>',
      '    <accessible_name>Custom Software Development Experts. We build solutions for enterprise organizations.</accessible_name>',
      '    <rect x="187" y="257" width="760" height="113" />',
      '    <styles>',
      '      color: rgb(55, 52, 62)',
      '      fontSize: 56.3802px',
      '      fontFamily: "Space Grotesk", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      '      fontWeight: 300',
      '      lineHeight: 56.3802px',
      '    </styles>',
      '    <ancestors>div.w-full.lg:w-[75%].mx-auto > div.hero-content.max-w-container.w-full > section.hero-container > div.component-block</ancestors>',
      '    <outer_html>',
      '      <p class="hero-heading font-heading font-light leading-none text-center text-text-primary">Custom Software Development Experts.</p>',
      '    </outer_html>',
      '  </picked_element>',
      '</browser_context>',
    ];
    // Inflate to ~5KB by repeating the picked_element block
    while (lines.join('\n').length < 5000) {
      lines.push(...lines.slice(2, -1));
    }
    return lines.join('\n');
  })(),
};

// --- Strategies ----------------------------------------------------------

const ESC_PASTE_START = '\x1b[200~';
const ESC_PASTE_END = '\x1b[201~';

function sanitize(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f]/g, '');
}

const STRATEGIES = {
  'combined-cr': async (ptyProcess, text) => {
    const safe = sanitize(text);
    ptyProcess.write(`${ESC_PASTE_START}${safe}${ESC_PASTE_END}\r`);
  },
  'separate-cr': async (ptyProcess, text) => {
    const safe = sanitize(text);
    ptyProcess.write(`${ESC_PASTE_START}${safe}${ESC_PASTE_END}`);
    await sleep(400); // settle
    ptyProcess.write('\r');
  },
  'delay-200-cr': async (ptyProcess, text) => {
    const safe = sanitize(text);
    ptyProcess.write(`${ESC_PASTE_START}${safe}${ESC_PASTE_END}`);
    await sleep(200);
    ptyProcess.write('\r');
  },
  'delay-500-cr': async (ptyProcess, text) => {
    const safe = sanitize(text);
    ptyProcess.write(`${ESC_PASTE_START}${safe}${ESC_PASTE_END}`);
    await sleep(500);
    ptyProcess.write('\r');
  },
  'delay-1000-cr': async (ptyProcess, text) => {
    const safe = sanitize(text);
    ptyProcess.write(`${ESC_PASTE_START}${safe}${ESC_PASTE_END}`);
    await sleep(1000);
    ptyProcess.write('\r');
  },
  'delay-2000-cr': async (ptyProcess, text) => {
    const safe = sanitize(text);
    ptyProcess.write(`${ESC_PASTE_START}${safe}${ESC_PASTE_END}`);
    await sleep(2000);
    ptyProcess.write('\r');
  },
  'double-cr': async (ptyProcess, text) => {
    const safe = sanitize(text);
    ptyProcess.write(`${ESC_PASTE_START}${safe}${ESC_PASTE_END}`);
    await sleep(500);
    ptyProcess.write('\r');
    await sleep(100);
    ptyProcess.write('\r');
  },
  'lf-only': async (ptyProcess, text) => {
    const safe = sanitize(text);
    ptyProcess.write(`${ESC_PASTE_START}${safe}${ESC_PASTE_END}`);
    await sleep(500);
    ptyProcess.write('\n');
  },
  'crlf': async (ptyProcess, text) => {
    const safe = sanitize(text);
    ptyProcess.write(`${ESC_PASTE_START}${safe}${ESC_PASTE_END}`);
    await sleep(500);
    ptyProcess.write('\r\n');
  },
  'plain-cr': async (ptyProcess, text) => {
    // No markers - control case to see how the agent handles raw multi-line.
    const safe = sanitize(text);
    ptyProcess.write(safe);
    await sleep(500);
    ptyProcess.write('\r');
  },
  'no-submit': async (ptyProcess, text) => {
    // Just paste; do not submit. Useful for verifying the placeholder
    // appears (proves bracketed paste is working without conflating
    // it with the Enter problem).
    const safe = sanitize(text);
    ptyProcess.write(`${ESC_PASTE_START}${safe}${ESC_PASTE_END}`);
  },
  'chunked-4k-separate-cr': async (ptyProcess, text) => {
    // Mirrors the app's writeQueue: chunks payload into 4KB pieces with
    // setImmediate yields between, then settle, then \r. Hypothesis:
    // the chunking with libuv yields between is what breaks Claude TUI's
    // bracketed-paste atomicity in the app context.
    const safe = sanitize(text);
    const wrapped = `${ESC_PASTE_START}${safe}${ESC_PASTE_END}`;
    const chunkSize = 4096;
    for (let i = 0; i < wrapped.length; i += chunkSize) {
      ptyProcess.write(wrapped.slice(i, i + chunkSize));
      // Mimic write-queue's setImmediate yield between chunks
      await new Promise((resolve) => setImmediate(resolve));
    }
    await sleep(400);
    ptyProcess.write('\r');
  },
  'chunked-4k-combined-cr': async (ptyProcess, text) => {
    // Same as above but \r is in the same byte stream (last chunk).
    const safe = sanitize(text);
    const wrapped = `${ESC_PASTE_START}${safe}${ESC_PASTE_END}\r`;
    const chunkSize = 4096;
    for (let i = 0; i < wrapped.length; i += chunkSize) {
      ptyProcess.write(wrapped.slice(i, i + chunkSize));
      await new Promise((resolve) => setImmediate(resolve));
    }
  },
  'chunked-1k-combined-cr': async (ptyProcess, text) => {
    // Smaller chunks - more setImmediate yields. If this also works,
    // chunking is fine; if it breaks, chunking IS the issue.
    const safe = sanitize(text);
    const wrapped = `${ESC_PASTE_START}${safe}${ESC_PASTE_END}\r`;
    const chunkSize = 1024;
    for (let i = 0; i < wrapped.length; i += chunkSize) {
      ptyProcess.write(wrapped.slice(i, i + chunkSize));
      await new Promise((resolve) => setImmediate(resolve));
    }
  },
  'split-marker-cr': async (ptyProcess, text) => {
    // Hostile case: send everything UP TO close-marker as one write,
    // yield (mimics chunking gap), then send `\e[201~\r` as second write.
    // Exposes whether Claude TUI's parser breaks when the close marker
    // doesn't arrive in the same kernel read as preceding content.
    const safe = sanitize(text);
    ptyProcess.write(`${ESC_PASTE_START}${safe}`);
    await new Promise((resolve) => setImmediate(resolve));
    ptyProcess.write(`${ESC_PASTE_END}\r`);
  },
  'split-cr': async (ptyProcess, text) => {
    // Even more hostile: send full bracketed paste, yield, then \r alone.
    // Equivalent to the engine path: paste atom completes via kernel pipe,
    // then \r arrives as a separate keystroke read.
    const safe = sanitize(text);
    ptyProcess.write(`${ESC_PASTE_START}${safe}${ESC_PASTE_END}`);
    await new Promise((resolve) => setImmediate(resolve));
    ptyProcess.write('\r');
  },
  // Single-line auto_command flavour: simulates the TerminalSubmit.submitKeystrokes path.
  // Used to validate the engine's `prefix` and `escapeBeforeEnter` options.
  'cmd-atomic': async (ptyProcess, text) => {
    // Single atomic write: text + Esc + Enter. No bracketed paste markers
    // (single-line commands don't need them).
    const safe = sanitize(text);
    ptyProcess.write(`${safe}\x1b\r`);
  },
  'cmd-atomic-with-ctrlc': async (ptyProcess, text) => {
    // Full TerminalSubmit.submitKeystrokes flavour: Ctrl+C + text + Esc + Enter
    // in a single atomic write. Validates whether the leading Ctrl+C
    // races against immediately-following text (it shouldn't, since
    // they're parsed in order from one kernel read).
    const safe = sanitize(text);
    ptyProcess.write(`\x03${safe}\x1b\r`);
  },
  'cmd-no-escape': async (ptyProcess, text) => {
    // Bare baseline: text + Enter atomically, no Escape, no Ctrl+C.
    // If this works, the existing TerminalSubmit.submitKeystrokes Escape may be
    // unnecessary defensiveness rather than a load-bearing keystroke.
    const safe = sanitize(text);
    ptyProcess.write(`${safe}\r`);
  },
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Detection ------------------------------------------------------------

// Strip ANSI escapes for substring matching against agent output.
// Replace cursor-right-by-N sequences with N spaces so word matches survive
// Claude's spaceless layout. Other cursor moves are dropped entirely.
function stripAnsi(s) {
  return s
    // Cursor-right by N -> N spaces (Claude uses this instead of literal space)
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[(\d+)C/g, (_, n) => ' '.repeat(parseInt(n, 10)))
    // Cursor positioning ESC[<row>;<col>H -> newline (rough but useful for line-based rx)
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[\d+;\d+H/g, '\n')
    // Drop everything else
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07]*\x07/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b./g, '');
}

// Heuristics for "agent acknowledged my prompt and is processing".
const SUBMIT_INDICATORS = [
  /Cooked for/i,                  // Claude Code response/thinking
  /Worked for/i,                  // Claude Code variant
  /Brewed for/i,                  // Claude Code variant
  /Baked for/i,                   // Claude Code variant
  /Hyperspacing/i,                // Claude Code variant
  /Zesting/i,                     // Claude Code variant
  /Pondering/i,                   // Claude Code variant
  /Thinking/i,                    // Many agents
  /Processing/i,                  // Many agents
  /Generating/i,                  // Many agents
  /Loading/i,
  /⤵/,                       // ↵ glyph some agents print
];

// Heuristic for "paste was placed in input but not submitted".
const PENDING_INDICATORS = [
  /Pasted text \+\d+ lines?/i,
  /paste again to expand/i,
];

function classifyOutcome(outputBeforeSubmit, outputAfterSubmit) {
  const cleanedAfter = stripAnsi(outputAfterSubmit);
  const cleanedBefore = stripAnsi(outputBeforeSubmit);

  const submitted = SUBMIT_INDICATORS.some((rx) => rx.test(cleanedAfter));
  const stuckInPending = !submitted && PENDING_INDICATORS.some((rx) => rx.test(cleanedAfter));
  const newBytes = outputAfterSubmit.length;

  let outcome;
  if (submitted) outcome = 'submitted';
  else if (stuckInPending) outcome = 'pending-no-submit';
  else if (newBytes > 100) outcome = 'output-but-no-indicator';
  else if (newBytes > 0) outcome = 'minimal-output';
  else outcome = 'no-output';

  return {
    outcome,
    submitted,
    stuckInPending,
    bytesAfterSubmit: newBytes,
    bytesBeforeSubmit: outputBeforeSubmit.length,
  };
}

// --- Run a single strategy -----------------------------------------------

async function runStrategy(args, strategyName, payload, options = {}) {
  const startTime = Date.now();
  console.log(`\n=== Strategy: ${strategyName} (payload=${payload.length} bytes, agent=${args.agent}${options.warmConversation ? ', mid-conversation' : ''}) ===`);

  const spawnArgs = args.agentArgs ? args.agentArgs.split(' ') : [];
  // If a shellWrap was provided, spawn the shell and run the agent inside it
  // (matches Kangentic's app spawn flow which always wraps in a shell).
  const ptyProcess = options.shellWrap
    ? pty.spawn(options.shellWrap.exe, options.shellWrap.args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: args.cwd,
        env: process.env,
      })
    : pty.spawn(args.agent, spawnArgs, {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: args.cwd,
        env: process.env,
      });

  if (options.shellWrap) {
    // Tell the shell to run the agent.
    setTimeout(() => {
      ptyProcess.write(`${args.agent} ${spawnArgs.join(' ')}\r`);
    }, 1500);
  }

  let allOutput = '';
  let outputBeforeSubmit = '';
  let outputAfterSubmit = '';
  let submitFiredAt = null;

  ptyProcess.onData((data) => {
    allOutput += data;
    if (submitFiredAt === null) outputBeforeSubmit += data;
    else outputAfterSubmit += data;
    if (!args.quiet) {
      process.stdout.write(`[${(Date.now() - startTime).toString().padStart(5, ' ')}ms] ${JSON.stringify(data)}\n`);
    }
  });

  // Warmup: let the agent finish its splash. For Claude Code the first
  // screen is a "trust this folder?" confirm; we auto-answer "1" if we
  // see it. Other agents may have similar gating.
  const trustPromptRx = /Is this (project|folder) you|trust this folder/i;
  const initialWarmup = Math.min(args.warmup, 4000);
  console.log(`[initial warmup ${initialWarmup}ms]`);
  await sleep(initialWarmup);

  if (trustPromptRx.test(stripAnsi(allOutput))) {
    console.log(`[${Date.now() - startTime}ms] trust prompt detected -> sending "1<Enter>"`);
    ptyProcess.write('1\r');
    await sleep(2000);
  }

  // Wait remaining warmup so post-trust splash settles
  const remainingWarmup = Math.max(0, args.warmup - initialWarmup - (trustPromptRx.test(stripAnsi(allOutput)) ? 2000 : 0));
  if (remainingWarmup > 0) {
    console.log(`[${Date.now() - startTime}ms] post-trust warmup ${remainingWarmup}ms`);
    await sleep(remainingWarmup);
  }

  // Optional: warm conversation so the agent is in mid-response state
  // similar to what the user's app session looks like.
  if (options.warmConversation) {
    console.log(`[${Date.now() - startTime}ms] warm-conversation: sending hello prompt`);
    ptyProcess.write('hello\r');
    await sleep(6000);  // let Claude respond
    console.log(`[${Date.now() - startTime}ms] warm-conversation done; ready for actual test`);
  }

  // Snapshot output before submit
  outputBeforeSubmit = allOutput;
  submitFiredAt = Date.now() - startTime;
  console.log(`[${submitFiredAt}ms] sending paste via strategy '${strategyName}'`);

  const strategy = STRATEGIES[strategyName];
  if (!strategy) {
    console.error(`Unknown strategy: ${strategyName}`);
    ptyProcess.kill();
    return null;
  }

  await strategy(ptyProcess, payload);

  console.log(`[${Date.now() - startTime}ms] strategy complete; observing for ${args.observe}ms...`);
  await sleep(args.observe);

  ptyProcess.kill();

  const verdict = classifyOutcome(outputBeforeSubmit, outputAfterSubmit);
  const totalMs = Date.now() - startTime;
  console.log(`[${totalMs}ms] outcome: ${verdict.outcome}`);
  console.log(`  submitted=${verdict.submitted} stuck-in-pending=${verdict.stuckInPending}`);
  console.log(`  bytes before submit=${verdict.bytesBeforeSubmit} after=${verdict.bytesAfterSubmit}`);

  return {
    strategy: strategyName,
    payloadBytes: payload.length,
    ...verdict,
    totalMs,
    submitFiredAt,
  };
}

// --- Main -----------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  const payload = args.customPayload ?? PAYLOADS[args.payload];
  if (!payload) {
    console.error(`Unknown payload preset: ${args.payload}`);
    process.exit(1);
  }

  const strategies = args.strategy === 'all'
    ? Object.keys(STRATEGIES)
    : [args.strategy];

  for (const name of strategies) {
    if (!STRATEGIES[name]) {
      console.error(`Unknown strategy: ${name}`);
      process.exit(1);
    }
  }

  console.log('=== Paste Reliability Harness ===');
  console.log(`Agent:    ${args.agent} ${args.agentArgs}`);
  console.log(`CWD:      ${args.cwd}`);
  console.log(`Payload:  ${args.payload} (${payload.length} bytes)`);
  console.log(`Runs:     ${args.runs} per strategy`);
  console.log('');

  const results = [];

  const runOptions = {};
  if (args.warmConversation) runOptions.warmConversation = true;
  if (args.shellWrap) {
    if (args.shellWrap === 'powershell') {
      runOptions.shellWrap = { exe: 'powershell.exe', args: ['-NoLogo'] };
    } else if (args.shellWrap === 'cmd') {
      runOptions.shellWrap = { exe: 'cmd.exe', args: [] };
    } else {
      runOptions.shellWrap = { exe: args.shellWrap, args: [] };
    }
  }

  for (const strategyName of strategies) {
    for (let run = 0; run < args.runs; run++) {
      if (args.runs > 1) console.log(`  --- run ${run + 1}/${args.runs} ---`);
      const result = await runStrategy(args, strategyName, payload, runOptions);
      if (result) results.push({ ...result, run });
      // Brief pause between runs so agents settle.
      await sleep(1000);
    }
  }

  // Summary table
  console.log('\n=== Summary ===');
  const colW = { strategy: 18, outcome: 25, bytes: 10 };
  console.log(
    'STRATEGY'.padEnd(colW.strategy)
    + 'OUTCOME'.padEnd(colW.outcome)
    + 'BYTES_AFTER'.padEnd(colW.bytes)
    + 'BYTES_BEFORE'
  );
  console.log('-'.repeat(70));
  for (const result of results) {
    console.log(
      result.strategy.padEnd(colW.strategy)
      + result.outcome.padEnd(colW.outcome)
      + String(result.bytesAfterSubmit).padEnd(colW.bytes)
      + String(result.bytesBeforeSubmit)
    );
  }

  if (args.json) {
    console.log('\n=== JSON ===');
    console.log(JSON.stringify(results, null, 2));
  }

  // Exit code: 0 if any submitted, 1 if none did
  const anySubmitted = results.some((result) => result.submitted);
  process.exit(anySubmitted ? 0 : 1);
}

main().catch((error) => {
  console.error('[FATAL]', error);
  process.exit(1);
});
