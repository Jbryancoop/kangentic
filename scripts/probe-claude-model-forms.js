#!/usr/bin/env node
/**
 * One-shot harness: probe Claude Code's `--model` flag with each form Kangentic
 * might surface to users (alias, unsuffixed family-version, dated full ID).
 * Prints what model actually responded, so we can see whether the dated form
 * is pinned, whether the unsuffixed form rolls forward, and whether the alias
 * resolves to the same target.
 *
 * Calls a real Claude Code session, so it spends API credits. Each run is
 * `--print --max-budget-usd 0.05` with a minimal prompt to keep cost trivial.
 *
 * Usage: node scripts/probe-claude-model-forms.js [model1 model2 ...]
 *   With no args, probes a sensible default set.
 */
const { spawnSync } = require('node:child_process');

const DEFAULT_MODELS = [
  'haiku',                          // alias
  'claude-haiku-4-5',                // unsuffixed family-version
  'claude-haiku-4-5-20251001',       // dated full ID
];

const PROMPT = '1+1';
const TIMEOUT_MS = 60_000;

function run(model) {
  const args = [
    '--print',
    '--output-format', 'json',
    '--max-budget-usd', '0.05',
    '--model', model,
    PROMPT,
  ];
  const start = Date.now();
  const result = spawnSync('claude', args, {
    timeout: TIMEOUT_MS,
    encoding: 'utf-8',
    shell: process.platform === 'win32',
  });
  const elapsed = Date.now() - start;
  if (result.error) {
    return { model, ok: false, error: result.error.message, elapsed };
  }
  if (result.status !== 0) {
    return {
      model,
      ok: false,
      error: `exit ${result.status}: ${(result.stderr || '').slice(0, 400)}`,
      elapsed,
    };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    // The CLI's JSON envelope varies by version. Look for any `model` field
    // anywhere in the top level so we don't tie the harness to a specific
    // shape; print the whole envelope when we cannot find one.
    const reportedModel = parsed.model || parsed.modelId || parsed.model_id
      || (parsed.usage && parsed.usage.model)
      || (parsed.session && parsed.session.model)
      || null;
    return {
      model,
      ok: true,
      reportedModel,
      result: parsed.result || parsed.text || parsed.completion || null,
      raw: reportedModel ? null : parsed,
      elapsed,
    };
  } catch (parseError) {
    return {
      model,
      ok: false,
      error: `parse failed: ${parseError.message}`,
      stdout: result.stdout.slice(0, 600),
      elapsed,
    };
  }
}

function main() {
  const models = process.argv.slice(2);
  const probeList = models.length > 0 ? models : DEFAULT_MODELS;
  console.log(`Probing ${probeList.length} model form(s) with prompt "${PROMPT}"\n`);

  const rows = [];
  for (const model of probeList) {
    process.stdout.write(`-> ${model} ... `);
    const probe = run(model);
    rows.push(probe);
    if (probe.ok) {
      console.log(`OK in ${probe.elapsed}ms (reported model: ${probe.reportedModel || '???'})`);
    } else {
      console.log(`FAIL in ${probe.elapsed}ms (${probe.error || ''})`);
    }
  }

  console.log('\nSummary:');
  for (const row of rows) {
    if (row.ok) {
      console.log(`  ${row.model.padEnd(34)} -> ${row.reportedModel || '(no model field in response)'}`);
    } else {
      console.log(`  ${row.model.padEnd(34)} -> FAILED: ${row.error}`);
    }
  }
  if (rows.some((row) => !row.ok || !row.reportedModel)) {
    console.log('\nFull responses for runs without a model field or that failed:');
    for (const row of rows) {
      if (row.ok && row.reportedModel) continue;
      console.log(`\n[${row.model}]`);
      console.log(JSON.stringify(row.raw || row.stdout || row.error, null, 2));
    }
  }
}

main();
