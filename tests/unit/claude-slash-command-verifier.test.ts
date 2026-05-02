/**
 * Tests for the Claude slash-command JSONL verifier.
 *
 * Background: between `/model X` and `/effort Y` writes, an overlay or
 * autocomplete sometimes swallows the Enter, causing the next command's
 * text to concatenate into the previous prompt buffer. Claude then records
 * a single combined invocation like `<command-args>X\n/effort Y</command-args>`
 * which fails as "Model 'X\n/effort Y' not found". The verifier reads the
 * session JSONL and only confirms when an entry matches the EXACT command
 * we sent (single-line args, no embedded next-command).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSlashCommandVerifier } from '../../src/main/agent/adapters/claude/slash-command-verifier';

let tmpDir: string;
let jsonlPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-verifier-'));
  jsonlPath = path.join(tmpDir, 'session.jsonl');
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

function appendEntry(entry: Record<string, unknown>): void {
  fs.appendFileSync(jsonlPath, JSON.stringify(entry) + '\n');
}

function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

describe('createSlashCommandVerifier', () => {
  it('returns null when no jsonlPath is provided (caller falls back to time-based settle)', () => {
    expect(createSlashCommandVerifier(null)).toBeNull();
    expect(createSlashCommandVerifier('')).toBeNull();
  });

  it('confirms a slash command when an exact-args entry appears after sentAt', async () => {
    const verifier = createSlashCommandVerifier(jsonlPath, { timeoutMs: 1000, pollIntervalMs: 25 })!;
    const sentAt = Date.now();

    // Simulate Claude writing the success entry shortly after we sent.
    setTimeout(() => {
      appendEntry({
        type: 'system',
        subtype: 'local_command',
        content: '<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>claude-opus-4-7</command-args>',
        timestamp: nowIso(),
      });
      appendEntry({
        type: 'system',
        subtype: 'local_command',
        content: '<local-command-stdout>Set model to Opus 4.7</local-command-stdout>',
        timestamp: nowIso(),
      });
    }, 100);

    const result = await verifier('/model claude-opus-4-7', sentAt);
    expect(result).toBe(true);
  });

  it('returns false on timeout when no matching entry appears', async () => {
    const verifier = createSlashCommandVerifier(jsonlPath, { timeoutMs: 250, pollIntervalMs: 25 })!;
    const sentAt = Date.now();
    const result = await verifier('/model claude-opus-4-7', sentAt);
    expect(result).toBe(false);
  });

  it('rejects a combined-args entry: /model with concatenated /effort args is treated as a non-match', async () => {
    // This is the canonical failure mode from the real-world bug. The
    // verifier MUST NOT accept this as confirmation, otherwise the burst
    // would advance to /effort while Claude was reporting "model not found".
    const verifier = createSlashCommandVerifier(jsonlPath, { timeoutMs: 250, pollIntervalMs: 25 })!;
    const sentAt = Date.now();
    appendEntry({
      type: 'system',
      subtype: 'local_command',
      content: '<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>claude-opus-4-7\n/effort xhigh</command-args>',
      timestamp: nowIso(10),
    });
    const result = await verifier('/model claude-opus-4-7', sentAt);
    expect(result).toBe(false);
  });

  it('ignores entries with timestamps older than sentAt (stale match from a prior schedule)', async () => {
    const verifier = createSlashCommandVerifier(jsonlPath, { timeoutMs: 250, pollIntervalMs: 25 })!;
    // Pre-existing matching entry from a prior burst (1 second ago).
    appendEntry({
      type: 'system',
      subtype: 'local_command',
      content: '<command-name>/model</command-name>\n            <command-args>claude-opus-4-7</command-args>',
      timestamp: nowIso(-1000),
    });
    const sentAt = Date.now();
    const result = await verifier('/model claude-opus-4-7', sentAt);
    expect(result).toBe(false);
  });

  it('matches user-message form (where slash entries appear under message.content instead of top-level content)', async () => {
    const verifier = createSlashCommandVerifier(jsonlPath, { timeoutMs: 1000, pollIntervalMs: 25 })!;
    const sentAt = Date.now();
    setTimeout(() => {
      appendEntry({
        type: 'user',
        message: {
          role: 'user',
          content: '<command-name>/effort</command-name>\n            <command-message>effort</command-message>\n            <command-args>xhigh</command-args>',
        },
        timestamp: nowIso(),
      });
    }, 50);
    const result = await verifier('/effort xhigh', sentAt);
    expect(result).toBe(true);
  });

  it('returns true immediately for non-slash text (no JSONL signal expected)', async () => {
    const verifier = createSlashCommandVerifier(jsonlPath, { timeoutMs: 5000, pollIntervalMs: 25 })!;
    const start = Date.now();
    const result = await verifier('analyze the failing test', Date.now());
    expect(result).toBe(true);
    expect(Date.now() - start).toBeLessThan(100);
  });

  it('returns false gracefully when the jsonl file does not exist yet', async () => {
    const verifier = createSlashCommandVerifier(path.join(tmpDir, 'missing.jsonl'), {
      timeoutMs: 200,
      pollIntervalMs: 25,
    })!;
    const result = await verifier('/model opus', Date.now());
    expect(result).toBe(false);
  });

  it('matches a no-arg slash command (e.g. /clear) when the entry has empty args', async () => {
    const verifier = createSlashCommandVerifier(jsonlPath, { timeoutMs: 500, pollIntervalMs: 25 })!;
    const sentAt = Date.now();
    setTimeout(() => {
      appendEntry({
        type: 'system',
        subtype: 'local_command',
        content: '<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>',
        timestamp: nowIso(),
      });
    }, 50);
    const result = await verifier('/clear', sentAt);
    expect(result).toBe(true);
  });
});
