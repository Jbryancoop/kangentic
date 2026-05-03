#!/usr/bin/env node
/**
 * Detailed probe of Codex CLI for model/effort flag support.
 */

const { spawnSync } = require('node:child_process');

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

console.log('='.repeat(80));
console.log('CODEX CLI DETAILED PROBE\n');

console.log('1. Parsing `codex --help`...');
const helpResult = run('codex', ['--help']);

if (helpResult.error) {
  console.log(`   ❌ Error: ${helpResult.error}\n`);
  process.exit(1);
}

const helpText = helpResult.stdout + helpResult.stderr;

// Extract exact flags
const modelFlagMatch = helpText.match(/^\s*(-m|--model)\s+([^\n]+)/m);
const modelFlag = modelFlagMatch ? modelFlagMatch[1] : null;
const modelDesc = modelFlagMatch ? modelFlagMatch[2].trim() : null;

const effortFlagMatch = helpText.match(/^\s*(--reasoning-effort)\s+([^\n]+)/m);
const effortFlag = effortFlagMatch ? effortFlagMatch[1] : null;
const effortDesc = effortFlagMatch ? effortFlagMatch[2].trim() : null;

console.log(`   Model flag:    ${modelFlag ? `✓ ${modelFlag} - ${modelDesc}` : '✗ Not found'}`);
console.log(`   Effort flag:   ${effortFlag ? `✓ ${effortFlag} - ${effortDesc}` : '✗ Not found'}`);

// Extract available effort levels
const effortLevels = helpText.match(/\b(none|low|medium|high|full)\b/g);
if (effortLevels) {
  const unique = [...new Set(effortLevels)];
  console.log(`   Available effort levels: ${unique.join(', ')}`);
}
console.log('');

console.log('2. Checking for slash commands in help...');
const hasSlashModel = /\/model|slash.*model/i.test(helpText);
const hasSlashEffort = /\/reasoning|slash.*effort/i.test(helpText);
console.log(`   /model slash: ${hasSlashModel ? 'mentioned' : 'not mentioned'}`);
console.log(`   /reasoning slash: ${hasSlashEffort ? 'mentioned' : 'not mentioned'}`);
console.log('');

console.log('='.repeat(80));
console.log('SUMMARY\n');
console.log('Codex CLI Model/Effort Support:');
console.log(`  --model flag:      ${modelFlag ? '✓ SUPPORTED' : '✗ NOT SUPPORTED'}`);
console.log(`  --reasoning-effort: ${effortFlag ? '✓ SUPPORTED' : '✗ NOT SUPPORTED'}`);
if (effortLevels) {
  console.log(`  Effort levels:     ${[...new Set(effortLevels)].join(', ')}`);
}
console.log('');
