#!/usr/bin/env node
/**
 * Comprehensive probe of all agents for model/effort support.
 * Quick version that tests multiple agents.
 */

const { spawnSync } = require('node:child_process');

const AGENTS = [
  { name: 'Gemini', cmd: 'gemini', helpArgs: ['--help'] },
  { name: 'Copilot', cmd: 'gh', helpArgs: ['copilot', '--help'] },
  { name: 'OpenCode', cmd: 'opencode', helpArgs: ['--help'] },
  { name: 'Qwen Code', cmd: 'qwen', helpArgs: ['--help'] },
  { name: 'Kimi Code', cmd: 'kimi', helpArgs: ['--help'] },
  { name: 'Droid', cmd: 'droid', helpArgs: ['--help'] },
];

function run(cmd, args = []) {
  const result = spawnSync(cmd, args, {
    timeout: 5000,
    encoding: 'utf-8',
    shell: process.platform === 'win32',
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error?.message || null,
  };
}

function probe(name, cmd, helpArgs) {
  const result = run(cmd, helpArgs);

  if (result.error) {
    return { name, cmd, error: result.error };
  }

  const helpText = result.stdout + result.stderr;

  const modelMatch = helpText.match(/^\s*(-m|--model)\s+([^\n]+)/m);
  const effortMatch = helpText.match(/^\s*(--(?:effort|reasoning))\s+([^\n]+)/m);

  return {
    name,
    cmd,
    hasModel: !!modelMatch,
    modelFlag: modelMatch ? modelMatch[1] : null,
    hasEffort: !!effortMatch,
    effortFlag: effortMatch ? effortMatch[1] : null,
    helpLength: helpText.length,
  };
}

console.log('='.repeat(80));
console.log('COMPREHENSIVE AGENT PROBE\n');

const results = AGENTS.map(({ name, cmd, helpArgs }) => probe(name, cmd, helpArgs));

console.log('Results:\n');
console.log('Agent        | --model | --effort');
console.log('-------------|---------|----------');

results.forEach((r) => {
  const name = (r.name || 'Unknown').padEnd(12);
  const model = r.error ? '❌' : r.hasModel ? '✓' : '✗';
  const effort = r.error ? '❌' : r.hasEffort ? '✓' : '✗';
  console.log(`${name} | ${model.padEnd(7)} | ${effort}`);

  if (r.error) {
    console.log(`   Error: ${r.error}`);
  } else if (r.modelFlag) {
    console.log(`   Model: ${r.modelFlag}`);
  }
  if (r.effortFlag) {
    console.log(`   Effort: ${r.effortFlag}`);
  }
});

console.log('\n' + '='.repeat(80));
