/**
 * Extract per-test timings from a Playwright HTML report.
 *
 * Decodes the base64-encoded report payload embedded in tests/reports/index.html
 * (the <template id="playwrightReportBase64"> tag) and prints sorted timings.
 *
 * The Playwright HTML reporter shards results: one JSON file per spec file in
 * the embedded zip, plus a top-level report.json. We collect tests across all
 * shards.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const reportPath = path.resolve(__dirname, '..', 'tests', 'reports', 'index.html');
const html = fs.readFileSync(reportPath, 'utf8');

const match = html.match(
  /<template id="playwrightReportBase64"[^>]*>data:application\/zip;base64,([\s\S]*?)<\/template>/,
);
if (!match) {
  console.error('Could not find playwrightReportBase64 payload');
  process.exit(1);
}

const base64 = match[1].trim();
const buffer = Buffer.from(base64, 'base64');

function readUInt32LE(buffer, offset) { return buffer.readUInt32LE(offset); }
function readUInt16LE(buffer, offset) { return buffer.readUInt16LE(offset); }

function parseZip(buffer) {
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (readUInt32LE(buffer, i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error('EOCD not found');

  const cdEntries = readUInt16LE(buffer, eocdOffset + 10);
  const cdOffset = readUInt32LE(buffer, eocdOffset + 16);

  const files = {};
  let offset = cdOffset;
  for (let i = 0; i < cdEntries; i++) {
    const compMethod = readUInt16LE(buffer, offset + 10);
    const compSize = readUInt32LE(buffer, offset + 20);
    const fileNameLen = readUInt16LE(buffer, offset + 28);
    const extraLen = readUInt16LE(buffer, offset + 30);
    const commentLen = readUInt16LE(buffer, offset + 32);
    const localHeaderOffset = readUInt32LE(buffer, offset + 42);
    const fileName = buffer.slice(offset + 46, offset + 46 + fileNameLen).toString('utf8');

    const lhFileNameLen = readUInt16LE(buffer, localHeaderOffset + 26);
    const lhExtraLen = readUInt16LE(buffer, localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + lhFileNameLen + lhExtraLen;
    const compressed = buffer.slice(dataStart, dataStart + compSize);
    const uncompressed = compMethod === 8 ? zlib.inflateRawSync(compressed) : compressed;
    files[fileName] = uncompressed;

    offset += 46 + fileNameLen + extraLen + commentLen;
  }
  return files;
}

const files = parseZip(buffer);

const rows = [];

for (const [name, content] of Object.entries(files)) {
  if (!name.endsWith('.json')) continue;
  let payload;
  try { payload = JSON.parse(content.toString('utf8')); } catch { continue; }
  if (!payload || !payload.fileName || !Array.isArray(payload.tests)) continue;
  const baseName = path.basename(payload.fileName);
  for (const test of payload.tests) {
    const projectName = test.projectName || '';
    const durationMs = typeof test.duration === 'number' ? test.duration : 0;
    const outcome = test.outcome || 'unknown';
    rows.push({
      file: baseName,
      project: projectName,
      title: `${(test.path || []).join(' > ')} > ${test.title}`.replace(/^\s*>\s*/, ''),
      durationMs,
      outcome,
    });
  }
}

rows.sort((a, b) => b.durationMs - a.durationMs);

const electronRows = rows.filter((r) => r.project === 'electron');
const totalElectronMs = electronRows.reduce((sum, r) => sum + r.durationMs, 0);

console.log(`\nElectron test count: ${electronRows.length}`);
console.log(`Sum of electron test durations: ${(totalElectronMs / 1000).toFixed(1)}s (${(totalElectronMs / 60000).toFixed(2)}min)\n`);

console.log('Top 30 slowest electron tests:');
console.log('  duration  outcome   file > title');
console.log('  --------  --------  -----------');
for (const row of electronRows.slice(0, 30)) {
  const dur = `${(row.durationMs / 1000).toFixed(1)}s`.padStart(8);
  const outcome = row.outcome.padEnd(8);
  console.log(`  ${dur}  ${outcome}  ${row.file} > ${row.title}`);
}

console.log('\nPer-spec totals (electron only):');
const perSpec = {};
const perSpecCount = {};
for (const row of electronRows) {
  perSpec[row.file] = (perSpec[row.file] || 0) + row.durationMs;
  perSpecCount[row.file] = (perSpecCount[row.file] || 0) + 1;
}
const specRows = Object.entries(perSpec).sort((a, b) => b[1] - a[1]);
for (const [file, ms] of specRows) {
  const count = perSpecCount[file];
  console.log(`  ${(ms / 1000).toFixed(1).padStart(7)}s  (${count} tests)\t${file}`);
}
