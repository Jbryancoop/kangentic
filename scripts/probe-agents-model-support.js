#!/usr/bin/env node
/**
 * Probe all installed agents for model/effort override flag support.
 * Runs `<agent> --help` for each and parses output to determine:
 * - Whether --model flag is supported
 * - What effort/reasoning options are available
 * - Any other relevant flags
 *
 * Usage: node scripts/probe-agents-model-support.js
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const AGENTS = [
  { name: 'Claude Code', cmd: 'claude' },
  { name: 'Codex CLI', cmd: 'codex' },
  { name: 'Gemini CLI', cmd: 'gemini' },
  { name: 'Cursor CLI', cmd: 'agent' },
  { name: 'GitHub Copilot CLI', cmd: 'gh' },
  { name: 'OpenCode', cmd: 'opencode' },
  { name: 'Qwen Code', cmd: 'qwen' },
  { name: 'Kimi Code', cmd: 'kimi' },
  { name: 'Droid', cmd: 'droid' },
];

function probeAgent(name, cmd, helpArgs = ['--help']) {
  const result = spawnSync(cmd, helpArgs, {
    timeout: 5000,
    encoding: 'utf-8',
    shell: process.platform === 'win32',
  });

  if (result.error) {
    return {
      name,
      cmd,
      ok: false,
      error: `Could not run: ${result.error.message}`,
    };
  }

  const helpText = result.stdout + result.stderr;

  if (result.status !== 0 && !helpText.includes('usage') && !helpText.includes('Usage')) {
    return {
      name,
      cmd,
      ok: false,
      error: `Exit ${result.status}, no help text found`,
    };
  }

  // Parse for model flag
  const hasModelFlag = /--model\s+<|--model\s+\w|--model\s*\n/.test(helpText);
  const modelMatch = helpText.match(/--model[^\n]*\n?([^\n]*)/i);
  const modelDesc = modelMatch ? modelMatch[1].trim().slice(0, 80) : '';

  // Parse for effort/reasoning flags
  const effortMatch = helpText.match(/--(?:effort|reasoning)[^\n]*\n?([^\n]*)/i);
  const effortDesc = effortMatch ? effortMatch[1].trim().slice(0, 80) : '';
  const hasEffortFlag = /--(?:effort|reasoning)\s+<|--(?:effort|reasoning)\s+\w|--(?:effort|reasoning)\s*\n/.test(
    helpText,
  );

  // Parse for specific effort levels (Claude style: "low, medium, high, xhigh, max")
  const effortLevels = helpText.match(/\b(?:low|medium|high|xhigh|x-high|max)\b/g) || [];
  const uniqueLevels = [...new Set(effortLevels)];

  return {
    name,
    cmd,
    ok: true,
    hasModelFlag,
    modelDesc: modelDesc || '(no description found)',
    hasEffortFlag,
    effortDesc: effortDesc || '(no description found)',
    effortLevels: uniqueLevels.length > 0 ? uniqueLevels : undefined,
    helpLength: helpText.length,
  };
}

console.log('Probing agents for model/effort override support...\n');

const results = AGENTS.map(({ name, cmd }) => {
  // Special case: Copilot uses 'gh copilot' subcommand
  const helpArgs = cmd === 'gh' ? ['copilot', '--help'] : ['--help'];
  return probeAgent(name, cmd, helpArgs);
});

console.log('='.repeat(80));
console.log('PROBE RESULTS\n');

results.forEach((result) => {
  if (!result.ok) {
    console.log(`❌ ${result.name} (${result.cmd})`);
    console.log(`   Error: ${result.error}\n`);
  } else {
    console.log(`✅ ${result.name} (${result.cmd})`);
    console.log(`   --model flag: ${result.hasModelFlag ? '✓' : '✗'} ${result.modelDesc}`);
    console.log(
      `   --effort flag: ${result.hasEffortFlag ? '✓' : '✗'} ${result.effortDesc}`,
    );
    if (result.effortLevels) {
      console.log(`   Effort levels detected: ${result.effortLevels.join(', ')}`);
    }
    console.log('');
  }
});

console.log('='.repeat(80));
console.log('SUMMARY TABLE\n');

console.log('Agent Name                 | --model | --effort | Effort Levels');
console.log('---------------------------|---------|----------|-------------------');

results.forEach((result) => {
  const name = result.name.padEnd(26);
  const model = result.ok ? (result.hasModelFlag ? '✓' : '✗') : '?';
  const effort = result.ok ? (result.hasEffortFlag ? '✓' : '✗') : '?';
  const levels = result.effortLevels ? result.effortLevels.join(',') : result.ok ? '-' : 'unknown';
  console.log(`${name} | ${model.padEnd(7)} | ${effort.padEnd(8)} | ${levels}`);
});

console.log('\nDone!');
