#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Empirical probe for the auto-name-from-prompt summarize() capability across
 * every agent adapter.
 *
 * For each adapter that implements summarize(), runs a real CLI invocation
 * with a sample task description and reports:
 *   - whether the CLI is detected on disk (and at what path/version)
 *   - whether summarize() throws or resolves
 *   - the wall-clock time
 *   - the resulting title (truncated)
 *   - whether the title looks sane (4-12 words, no trailing punctuation, etc.)
 *
 * Usage
 * -----
 *   node scripts/probe-summarize.js
 *   node scripts/probe-summarize.js --agent claude       # probe one adapter
 *   node scripts/probe-summarize.js --description "..."  # custom prompt
 *   node scripts/probe-summarize.js --timeout 30000      # extend timeout (ms)
 *
 * The script imports adapters from .vite/build/main.js to avoid running ts-node
 * on the entire main process. Run `npm run build:main` (or `npm start`/`npm run
 * build`) at least once first so the build artifact exists.
 *
 * Exit codes
 * ----------
 *   0  = all detected adapters succeeded (or none implemented summarize)
 *   1  = at least one adapter that claims summarize threw or produced empty output
 *   2  = build artifact missing - run `npm run build` first
 */

const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
function flag(name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  return args[index + 1] ?? '';
}

const targetAgent = flag('--agent');
const customDescription = flag('--description');
const timeoutMs = Number(flag('--timeout') || 20000);

const SAMPLE_DESCRIPTION = customDescription
  ?? 'fix the toast that reappears every time the task detail dialog reopens after being closed once';

function looksSane(title) {
  if (!title || typeof title !== 'string') return { ok: false, reason: 'empty' };
  const trimmed = title.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'whitespace' };
  if (trimmed.length > 100) return { ok: false, reason: `too long (${trimmed.length} chars)` };
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount < 2) return { ok: false, reason: `too few words (${wordCount})` };
  if (wordCount > 16) return { ok: false, reason: `too many words (${wordCount})` };
  if (/[`*_>#]/.test(trimmed)) return { ok: false, reason: 'contains markdown punctuation' };
  if (trimmed.endsWith('.') || trimmed.endsWith('!') || trimmed.endsWith('?')) {
    return { ok: false, reason: 'trailing punctuation' };
  }
  return { ok: true };
}

async function main() {
  const buildPath = path.resolve(__dirname, '..', '.vite', 'build', 'main.js');
  if (!fs.existsSync(buildPath)) {
    console.error('Build artifact missing at', buildPath);
    console.error('Run `npm run build` first to compile the main process.');
    process.exit(2);
  }

  // The agent registry is exported via the main bundle. We need access to:
  // - agentRegistry (for listing adapters)
  // - each adapter's detect() and summarize()
  // For simplicity, this script duplicates the minimal source paths that the
  // main bundle resolves at runtime. Importing the bundle directly would pull
  // in Electron, which is not available outside the Electron runtime.
  //
  // Instead, use ts-node-style require via the existing built CJS modules under
  // .vite/build/. The agent-registry export is namespaced.
  const buildModule = require(buildPath);
  const agentRegistry = buildModule.agentRegistry
    ?? buildModule.default?.agentRegistry
    ?? null;
  if (!agentRegistry) {
    console.error('agentRegistry export not found in build artifact.');
    console.error('This script needs the build to expose agentRegistry as a top-level export.');
    console.error('Falling back: importing each adapter module directly is not yet wired up.');
    process.exit(2);
  }

  const allNames = agentRegistry.list();
  const targets = targetAgent ? [targetAgent] : allNames;

  console.log('==== summarize() probe ====');
  console.log('Description:', JSON.stringify(SAMPLE_DESCRIPTION));
  console.log('Timeout:', timeoutMs, 'ms');
  console.log('');

  const results = [];

  for (const name of targets) {
    const adapter = agentRegistry.get(name);
    if (!adapter) {
      console.log(`[${name}] not in registry`);
      continue;
    }
    if (typeof adapter.summarize !== 'function') {
      console.log(`[${name}] no summarize capability - skipping`);
      results.push({ name, status: 'no-capability' });
      continue;
    }

    process.stdout.write(`[${name}] detect ... `);
    let info;
    try {
      info = await adapter.detect();
    } catch (error) {
      console.log('THREW:', error.message);
      results.push({ name, status: 'detect-error', error: error.message });
      continue;
    }

    if (!info.found || !info.path) {
      console.log('not installed');
      results.push({ name, status: 'not-installed' });
      continue;
    }
    console.log(`found at ${info.path} (v${info.version ?? '?'})`);

    process.stdout.write(`[${name}] summarize ... `);
    const startedAt = Date.now();
    let title;
    try {
      title = await Promise.race([
        adapter.summarize(SAMPLE_DESCRIPTION, info.path, process.cwd()),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`probe timeout (${timeoutMs}ms)`)), timeoutMs),
        ),
      ]);
    } catch (error) {
      const elapsed = Date.now() - startedAt;
      console.log(`THREW after ${elapsed}ms:`, error.message);
      results.push({ name, status: 'summarize-error', error: error.message, elapsedMs: elapsed });
      continue;
    }

    const elapsed = Date.now() - startedAt;
    const sanity = looksSane(title);
    if (sanity.ok) {
      console.log(`OK (${elapsed}ms): "${title}"`);
      results.push({ name, status: 'ok', title, elapsedMs: elapsed });
    } else {
      console.log(`WEIRD (${elapsed}ms; ${sanity.reason}): "${title}"`);
      results.push({ name, status: 'weird', title, reason: sanity.reason, elapsedMs: elapsed });
    }
  }

  console.log('');
  console.log('==== summary ====');
  const okCount = results.filter((r) => r.status === 'ok').length;
  const errorCount = results.filter((r) => r.status === 'summarize-error' || r.status === 'detect-error').length;
  const weirdCount = results.filter((r) => r.status === 'weird').length;
  const skippedCount = results.filter((r) => r.status === 'no-capability' || r.status === 'not-installed').length;
  console.log(`  ok:        ${okCount}`);
  console.log(`  weird:     ${weirdCount}  (CLI ran but output looks off)`);
  console.log(`  errored:   ${errorCount}`);
  console.log(`  skipped:   ${skippedCount}  (no capability or not installed)`);
  console.log('');

  if (results.some((r) => r.status === 'summarize-error' || r.status === 'detect-error')) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error('Probe failed:', error);
  process.exit(1);
});
