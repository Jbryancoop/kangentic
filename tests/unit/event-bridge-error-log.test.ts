/**
 * Unit tests for the error-logging path added to event-bridge.js.
 *
 * The bridge runs as a short-lived Node subprocess spawned by Claude Code
 * hooks. When `fs.appendFileSync(outputPath, ...)` throws (file locked,
 * path missing, disk full), the new catch block writes a one-line entry
 * to `<sessionDir>/events-bridge.error.log` so genuine pipeline failures
 * are diagnosable.
 *
 * To force the primary write to fail cross-platform, the tests pre-create
 * `events.jsonl` as a directory. `appendFileSync` to a path that is a
 * directory fails with EISDIR (POSIX) or EPERM (Windows). The sibling
 * `events-bridge.error.log` write succeeds because its parent directory
 * is the regular tmpdir.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const BRIDGE = path.resolve(__dirname, '../../src/main/agent/event-bridge.js');

let tempDirectory: string;

beforeEach(() => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'event-bridge-error-test-'));
});

afterEach(() => {
  try {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

function runBridge(stdin: string, args: string[]): void {
  execFileSync(process.execPath, [BRIDGE, ...args], {
    input: stdin,
    timeout: 5000,
  });
}

function readFile(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf-8');
}

describe('event-bridge: error log path', () => {
  it('happy path: a successful write does NOT create an error log', () => {
    const outputFile = path.join(tempDirectory, 'events.jsonl');
    runBridge('{}', [outputFile, 'idle']);

    expect(fs.existsSync(outputFile)).toBe(true);
    const errorLog = path.join(tempDirectory, 'events-bridge.error.log');
    expect(fs.existsSync(errorLog)).toBe(false);
  });

  it('appendFileSync failure writes an error line to events-bridge.error.log', () => {
    // Force `appendFileSync(events.jsonl, ...)` to fail by making the path a directory.
    const outputFile = path.join(tempDirectory, 'events.jsonl');
    fs.mkdirSync(outputFile, { recursive: true });

    runBridge('{}', [outputFile, 'idle']);

    const errorLog = path.join(tempDirectory, 'events-bridge.error.log');
    const errorContents = readFile(errorLog);
    expect(errorContents).not.toBeNull();
    expect(errorContents!).toContain('idle');
    // The error message must be present (e.g. 'EISDIR', 'EPERM', or similar).
    // We don't assert a specific code because the kernel error code varies
    // by OS; just check that there is non-trivial text after the type token.
    const lines = errorContents!.split('\n').filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    // ISO timestamp prefix.
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('error log includes the event type even when the primary write fails', () => {
    const outputFile = path.join(tempDirectory, 'events.jsonl');
    fs.mkdirSync(outputFile, { recursive: true });

    runBridge('{}', [outputFile, 'tool_start']);

    const errorLog = path.join(tempDirectory, 'events-bridge.error.log');
    const errorContents = readFile(errorLog);
    expect(errorContents).not.toBeNull();
    expect(errorContents!).toContain('tool_start');
  });

  it('inner catch swallows: when both writes fail, the bridge does not crash', () => {
    // Use a path that doesn't exist anywhere (parent dir is missing too).
    // Both appendFileSync(outputFile, ...) and appendFileSync(errorLog, ...) fail.
    const missingDir = path.join(tempDirectory, 'missing', 'deep', 'path');
    const outputFile = path.join(missingDir, 'events.jsonl');

    // The bridge must exit cleanly with no thrown error; execFileSync would
    // throw on non-zero exit. If the inner catch leaks, this test fails.
    expect(() => runBridge('{}', [outputFile, 'idle'])).not.toThrow();

    expect(fs.existsSync(outputFile)).toBe(false);
    const errorLog = path.join(missingDir, 'events-bridge.error.log');
    expect(fs.existsSync(errorLog)).toBe(false);
  });

  it('multiple failed events accumulate in the error log', () => {
    const outputFile = path.join(tempDirectory, 'events.jsonl');
    fs.mkdirSync(outputFile, { recursive: true });

    runBridge('{}', [outputFile, 'tool_start']);
    runBridge('{}', [outputFile, 'tool_end']);
    runBridge('{}', [outputFile, 'idle']);

    const errorLog = path.join(tempDirectory, 'events-bridge.error.log');
    const errorContents = readFile(errorLog);
    expect(errorContents).not.toBeNull();
    const lines = errorContents!.split('\n').filter((line) => line.length > 0);
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain('tool_start');
    expect(lines[1]).toContain('tool_end');
    expect(lines[2]).toContain('idle');
  });
});
