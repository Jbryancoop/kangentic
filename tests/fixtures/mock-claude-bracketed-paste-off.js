#!/usr/bin/env node
/**
 * Mock Claude variant that emits the bracketed-paste-mode-OFF sequence
 * (\x1b[?2004l) as soon as it sees the bracketed-paste-START byte sequence
 * on stdin, then swallows everything else.
 *
 * Used to verify the paste-engine's modal-detection path: when bracketed
 * paste mode goes off mid-call, the engine MUST skip the \r retry to avoid
 * confirming a destructive permission prompt, and must surface the
 * "permission prompt or modal open" error instead of "Paste landed but
 * Enter did not submit".
 *
 * The variant also writes a sidecar file `bracketed-paste-off.cr-count.txt`
 * next to the settings dir on first \r so the spec can assert the engine
 * sent only ONE \r (no retry).
 *
 * setRawMode(true) suppresses kernel-level PTY echo.
 */

const fs = require('node:fs');
const pathMod = require('node:path');

const args = process.argv.slice(2);

if (args.includes('--version')) {
  console.log('mock-claude-bracketed-paste-off 0.0.0-test');
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

const sessionDir = settingsPath ? pathMod.dirname(settingsPath) : null;
const crCountPath = sessionDir
  ? pathMod.join(sessionDir, 'bracketed-paste-off.cr-count.txt')
  : null;

const PASTE_START = Buffer.from('\x1b[200~');

let crCount = 0;
let stdinBuffer = Buffer.alloc(0);
let pasteOffEmitted = false;

process.stdin.on('data', (chunk) => {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  stdinBuffer = Buffer.concat([stdinBuffer, buffer]);

  // Emit \x1b[?2004l (bracketed-paste-mode OFF) the moment the engine starts
  // its bracketed paste packet. This races into the paste-engine's
  // monitorPasteMode listener so pasteModeOff = true before the \r is sent.
  if (!pasteOffEmitted && stdinBuffer.indexOf(PASTE_START) !== -1) {
    pasteOffEmitted = true;
    process.stdout.write('\x1b[?2004l');
    console.log('MOCK_CLAUDE_BRACKETED_PASTE_OFF_EMITTED');
  }

  // Count \r bytes seen on stdin so the spec can confirm no retry.
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0x0d) {
      crCount += 1;
      if (crCountPath) {
        try { fs.writeFileSync(crCountPath, String(crCount)); } catch { /* ignore */ }
      }
    }
  }
});

const timeout = setTimeout(() => process.exit(0), 60000);
process.on('SIGTERM', () => { clearTimeout(timeout); process.exit(0); });
process.on('SIGINT', () => { clearTimeout(timeout); process.exit(0); });
process.stdin.resume();
