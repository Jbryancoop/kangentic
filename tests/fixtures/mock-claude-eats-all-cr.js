#!/usr/bin/env node
/**
 * Mock Claude variant that swallows every \r and never writes anything in
 * response to stdin input.
 *
 * Used to drive the paste-engine into both evidence windows timing out,
 * which surfaces as PasteSubmitError('no-submission-evidence') -> the
 * "Paste landed but Enter did not submit" toast.
 *
 * setRawMode(true) suppresses kernel-level PTY echo so the engine never
 * sees data evidence from input echo.
 */

const args = process.argv.slice(2);

if (args.includes('--version')) {
  console.log('mock-claude-eats-all-cr 0.0.0-test');
  process.exit(0);
}

if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: claude [options]');
  console.log('  --model <name>       Override model');
  console.log('  --effort <level>     Effort level for the current session (low, medium, high, xhigh, max)');
  process.exit(0);
}

let sessionId = null;
let resumed = false;
let prompt = null;
let settingsPath = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--session-id' && i + 1 < args.length) { sessionId = args[i + 1]; resumed = false; i++; }
  else if (args[i] === '--resume' && i + 1 < args.length) { sessionId = args[i + 1]; resumed = true; i++; }
  else if (args[i] === '--settings' && i + 1 < args.length) { settingsPath = args[i + 1]; i++; }
  else if (args[i] === '--permission-mode') { i++; }
  else if (args[i] === '--dangerously-skip-permissions' || args[i] === '--print') { /* no value */ }
  else if (args[i] === '--') { if (i + 1 < args.length) prompt = args[i + 1]; break; }
  else if (!args[i].startsWith('-')) { prompt = args[i]; }
}

if (settingsPath) console.log('MOCK_CLAUDE_SETTINGS:' + settingsPath);
if (sessionId) {
  if (resumed) console.log('MOCK_CLAUDE_RESUMED:' + sessionId);
  else console.log('MOCK_CLAUDE_SESSION:' + sessionId);
}
if (prompt) console.log('MOCK_CLAUDE_PROMPT:' + prompt);
else if (!sessionId) console.log('MOCK_CLAUDE_NO_PROMPT');

if (process.stdin.isTTY) {
  try { process.stdin.setRawMode(true); } catch { /* ignore */ }
}

// Drain stdin without writing anything. Both \r evidence windows must time
// out for the test assertion to hold.
process.stdin.on('data', () => { /* swallow */ });

const timeout = setTimeout(() => process.exit(0), 60000);
process.on('SIGTERM', () => { clearTimeout(timeout); process.exit(0); });
process.on('SIGINT', () => { clearTimeout(timeout); process.exit(0); });
process.stdin.resume();
