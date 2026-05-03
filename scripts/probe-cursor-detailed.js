#!/usr/bin/env node
/**
 * Detailed probe of Cursor CLI (agent command) for model/effort flag support.
 * Tests:
 * 1. Parse `agent --help` for exact flag signatures
 * 2. List available models via `agent about --format json` (if supported)
 * 3. Test --model flag with a real invocation
 * 4. Check for reasoning/effort level control
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
console.log('CURSOR CLI DETAILED PROBE\n');

// Test 1: Get help text and extract exact flags
console.log('1. Parsing `agent --help`...');
const helpResult = run('agent', ['--help']);

if (helpResult.error) {
  console.log(`   ❌ Error: ${helpResult.error}\n`);
  process.exit(1);
}

const helpText = helpResult.stdout + helpResult.stderr;

// Look for exact flag patterns
const modelFlagMatch = helpText.match(/^\s*(-m|--model)\s+([^\n]+)/m);
const modelFlag = modelFlagMatch ? modelFlagMatch[1] : null;
const modelDesc = modelFlagMatch ? modelFlagMatch[2].trim() : null;

const effortFlagMatch = helpText.match(/^\s*(--(?:effort|reasoning))\s+([^\n]+)/m);
const effortFlag = effortFlagMatch ? effortFlagMatch[1] : null;
const effortDesc = effortFlagMatch ? effortFlagMatch[2].trim() : null;

const promptFlagMatch = helpText.match(/^\s*(-p|--prompt)\s+([^\n]+)/m);
const promptFlag = promptFlagMatch ? promptFlagMatch[1] : null;

console.log(`   Model flag:    ${modelFlag ? `✓ ${modelFlag} - ${modelDesc}` : '✗ Not found'}`);
console.log(`   Effort flag:   ${effortFlag ? `✓ ${effortFlag} - ${effortDesc}` : '✗ Not found'}`);
console.log(`   Prompt flag:   ${promptFlag ? `✓ ${promptFlag}` : '✗ Not found'}\n`);

// Test 2: Try to get model info via `agent about --format json`
console.log('2. Testing `agent about --format json`...');
const aboutResult = run('agent', ['about', '--format', 'json']);

let modelInfo = null;
if (aboutResult.status === 0 && aboutResult.stdout.includes('model')) {
  try {
    modelInfo = JSON.parse(aboutResult.stdout);
    console.log(`   ✓ Got model info: ${modelInfo.model || 'unknown'}`);
    if (modelInfo.models) {
      console.log(`   Available models: ${modelInfo.models.join(', ')}`);
    }
  } catch (e) {
    console.log(`   ✗ Could not parse JSON`);
  }
} else {
  console.log(`   ✗ Command failed or no model info`);
}
console.log('');

// Test 3: Try `agent --version` or similar to verify CLI is working
console.log('3. Verifying CLI version...');
const versionResult = run('agent', ['--version']);
console.log(`   ${versionResult.stdout || versionResult.stderr}`.trim());
console.log('');

// Test 4: Look for reasoning/thinking modes
console.log('4. Checking for thinking/reasoning support in help...');
const hasThinking = /thinking|reasoning|effort|deep|full|plan|analyze/i.test(helpText);
console.log(`   Thinking modes mentioned: ${hasThinking ? 'Yes' : 'No'}\n`);

// Test 5: Try a real command with --model flag (dry run / help only)
if (modelFlag) {
  console.log(`5. Testing actual invocation with ${modelFlag}...`);
  // Try with --help to see if the flag is accepted (without running a real session)
  const testResult = run('agent', [modelFlag, 'sonnet-4-thinking', '--help']);
  if (testResult.status === 0) {
    console.log(`   ✓ Flag accepted (help showed without error)`);
  } else if (testResult.stderr.includes('unknown') || testResult.stderr.includes('unrecognized')) {
    console.log(`   ✗ Flag not recognized: ${testResult.stderr.slice(0, 100)}`);
  } else {
    console.log(`   ? Unexpected exit: ${testResult.status}`);
  }
  console.log('');
}

// Summary
console.log('='.repeat(80));
console.log('SUMMARY\n');
console.log('Cursor CLI Model/Effort Support:');
console.log(`  --model flag:   ${modelFlag ? '✓ SUPPORTED' : '✗ NOT SUPPORTED'}`);
console.log(`  Effort/reasoning: ${effortFlag ? '✓ SUPPORTED' : '✗ NOT SUPPORTED'}`);
console.log(`  Live swap potential: ${modelFlag ? 'Check for /model slash command' : 'Respawn-only (no live swap)'}`);
console.log('');
