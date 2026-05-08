#!/usr/bin/env node

/**
 * devtools-bench.js -- Microbenchmark for the dev-only inspection bridge.
 *
 * Drives the localhost HTTP bridge directly (skipping MCP) so we can
 * measure server-side latency without MCP-transport noise. Reports
 * p50/p95/avg per endpoint over N iterations.
 *
 * Usage: node scripts/devtools-bench.js [--iterations=20] [--instance=<worktreePath>]
 *
 * Requires a running preview with `developer.previewInspectionServer` ON.
 * Discovers the lockfile via the same code path as the MCP tools so it
 * picks up whatever instance is responding.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

const argv = process.argv.slice(2);
const iterations = (() => {
  const arg = argv.find((entry) => entry.startsWith('--iterations='));
  if (!arg) return 20;
  const parsed = Number.parseInt(arg.split('=')[1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
})();
const explicitInstance = (() => {
  const arg = argv.find((entry) => entry.startsWith('--instance='));
  return arg ? arg.split('=')[1] : null;
})();

function readLockfile(worktreePath) {
  const file = path.join(worktreePath, '.kangentic', 'preview.lock');
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Discover preview instances by checking the kangentic checkout root and
 * each worktree under `.kangentic/worktrees/`. Bounded to the project's
 * own filesystem - never walks the user's home directory.
 *
 * `process.cwd()` is the user's invocation directory; we walk up from
 * there until we hit either the repo root (sibling to package.json) or
 * a worktree path matching `.kangentic/worktrees/`. The script lives at
 * `<repo>/scripts/devtools-bench.js`, so `__dirname/..` is always the
 * repo root.
 */
function findRepoRoot() {
  return path.resolve(__dirname, '..');
}

function discoverInstance() {
  if (explicitInstance) {
    const lockfile = readLockfile(explicitInstance);
    if (!lockfile) throw new Error(`No lockfile at ${explicitInstance}/.kangentic/preview.lock`);
    return { port: lockfile.port, worktreePath: explicitInstance };
  }
  const repoRoot = findRepoRoot();
  const candidates = [];

  const rootLockfile = readLockfile(repoRoot);
  if (rootLockfile) candidates.push({ port: rootLockfile.port, worktreePath: repoRoot });

  const worktreesDir = path.join(repoRoot, '.kangentic', 'worktrees');
  let worktreeEntries = [];
  try {
    worktreeEntries = fs.readdirSync(worktreesDir, { withFileTypes: true });
  } catch {
    // No worktrees yet - that's fine, we may still have a root lockfile.
  }
  for (const entry of worktreeEntries) {
    if (!entry.isDirectory()) continue;
    const worktreePath = path.join(worktreesDir, entry.name);
    const lockfile = readLockfile(worktreePath);
    if (lockfile) candidates.push({ port: lockfile.port, worktreePath });
  }

  if (candidates.length === 0) {
    throw new Error(
      `No responding preview instance found under ${repoRoot}. Start one via "npm start" or "npm run worktree-preview".`,
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      `${candidates.length} preview instances found. Pass --instance=<worktreePath>. Candidates: ${candidates
        .map((entry) => entry.worktreePath)
        .join(', ')}`,
    );
  }
  return candidates[0];
}

function callEndpoint(port, method, urlPath, body) {
  const start = process.hrtime.bigint();
  return new Promise((resolve, reject) => {
    const requestBody = body ? JSON.stringify(body) : undefined;
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method,
        timeout: 30000,
        headers: requestBody
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(requestBody) }
          : undefined,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
          const raw = Buffer.concat(chunks).toString('utf-8');
          let payload;
          try {
            payload = raw ? JSON.parse(raw) : null;
          } catch {
            payload = raw;
          }
          resolve({ elapsedMs, statusCode: response.statusCode, payload });
        });
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy(new Error('timeout'));
    });
    if (requestBody) request.write(requestBody);
    request.end();
  });
}

function summarize(samples) {
  if (samples.length === 0) return { count: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  return {
    count: sorted.length,
    avg: Math.round(sum / sorted.length),
    p50: Math.round(p(0.5)),
    p95: Math.round(p(0.95)),
    min: Math.round(sorted[0]),
    max: Math.round(sorted[sorted.length - 1]),
  };
}

async function runScenario(name, port, iterations, fn) {
  const samples = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    try {
      const elapsed = await fn();
      samples.push(elapsed);
    } catch (error) {
      console.warn(`[bench] ${name} iteration ${iteration} failed: ${error.message}`);
    }
  }
  return { name, ...summarize(samples) };
}

async function main() {
  const instance = discoverInstance();
  console.log(`[bench] Targeting ${instance.worktreePath} (port ${instance.port})`);
  console.log(`[bench] Iterations per scenario: ${iterations}`);

  const scenarios = [];

  scenarios.push(
    await runScenario('info (cold path)', instance.port, iterations, async () => {
      const result = await callEndpoint(instance.port, 'GET', '/info');
      return result.elapsedMs;
    }),
  );

  scenarios.push(
    await runScenario('query_dom (body)', instance.port, iterations, async () => {
      const result = await callEndpoint(instance.port, 'GET', '/dom?selector=body');
      return result.elapsedMs;
    }),
  );

  scenarios.push(
    await runScenario('bounding_box (body)', instance.port, iterations, async () => {
      const result = await callEndpoint(instance.port, 'GET', '/bounding-box?selector=body');
      return result.elapsedMs;
    }),
  );

  scenarios.push(
    await runScenario('screenshot viewport jpeg q80', instance.port, iterations, async () => {
      const result = await callEndpoint(
        instance.port,
        'GET',
        '/screenshot?format=jpeg&quality=80',
      );
      return result.elapsedMs;
    }),
  );

  scenarios.push(
    await runScenario('screenshot fullPage jpeg q75', instance.port, iterations, async () => {
      const result = await callEndpoint(
        instance.port,
        'GET',
        '/screenshot?format=jpeg&quality=75&fullPage=true',
      );
      return result.elapsedMs;
    }),
  );

  console.log('');
  console.log('Endpoint                          | count | avg(ms) | p50 | p95 | min | max');
  console.log('----------------------------------|-------|---------|-----|-----|-----|-----');
  for (const scenario of scenarios) {
    const padded = scenario.name.padEnd(33, ' ');
    console.log(
      `${padded} | ${String(scenario.count).padStart(5)} | ${String(scenario.avg).padStart(7)} | ${String(scenario.p50).padStart(3)} | ${String(scenario.p95).padStart(3)} | ${String(scenario.min).padStart(3)} | ${String(scenario.max).padStart(3)}`,
    );
  }
}

main().catch((error) => {
  console.error('[bench] Fatal:', error.message);
  process.exit(1);
});
