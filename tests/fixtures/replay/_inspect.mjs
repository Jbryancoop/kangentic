// DEVELOPER UTILITY - not run in CI.
//
// One-shot debug: replay a fixture and print final engine state.
// Usage: node tests/fixtures/replay/_inspect.mjs <fixture.jsonl>
//
// Run manually when adding new replay fixtures or diagnosing a
// production session's event totals.
import fs from 'node:fs';
import path from 'node:path';

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: node _inspect.mjs <fixture.jsonl>');
  process.exit(1);
}

const lines = fs.readFileSync(inputPath, 'utf-8').trim().split('\n');
const events = lines.map((l) => JSON.parse(l));

let bgStarts = 0;
let bgEnds = 0;
let toolStarts = 0;
let toolEnds = 0;
let interrupted = 0;
let prompts = 0;
let idles = 0;
let permissionIdles = 0;
let subagentStarts = 0;
let subagentStops = 0;

for (const event of events) {
  switch (event.type) {
    case 'background_shell_start': bgStarts++; break;
    case 'background_shell_end': bgEnds++; break;
    case 'tool_start': toolStarts++; break;
    case 'tool_end': toolEnds++; break;
    case 'interrupted': interrupted++; break;
    case 'prompt': prompts++; break;
    case 'idle': if (event.detail === 'permission') permissionIdles++; else idles++; break;
    case 'subagent_start': subagentStarts++; break;
    case 'subagent_stop': subagentStops++; break;
  }
}

console.log(JSON.stringify({
  total: events.length,
  bgStarts, bgEnds, bgNet: bgStarts - bgEnds,
  toolStarts, toolEnds, toolNet: toolStarts - toolEnds,
  interrupted,
  prompts,
  idles,
  permissionIdles,
  subagentStarts, subagentStops, subagentDepthNet: subagentStarts - subagentStops,
}, null, 2));
