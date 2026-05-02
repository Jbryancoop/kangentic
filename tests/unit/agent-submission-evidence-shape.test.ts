/**
 * Verifies each agent adapter's `submissionEvidence` matches the
 * strategy table agreed during the per-adapter submission evidence
 * feature (branch per-adapter-submissi-38609c8d).
 *
 * Strategy table:
 *   claude      - { hookEventType: 'prompt' } only
 *   codex       - { hookEventType: 'prompt', minBytes: 100 }
 *   gemini      - { hookEventType: 'prompt' } only
 *   qwen-code   - { hookEventType: 'prompt' } only
 *   All others  - { minBytes: 100 } only
 *     (opencode, copilot, aider, cursor, droid, kimi, warp)
 *
 * No mocks needed - adapters are instantiated directly; submissionEvidence
 * is a plain readonly property with no I/O.
 */
import { describe, it, expect } from 'vitest';
import { EventType } from '../../src/shared/types';

// Adapters that use a hook-event as the primary signal (strongest evidence).
const HOOK_ONLY_ADAPTERS = [
  { name: 'claude',    importPath: '../../src/main/agent/adapters/claude/claude-adapter',       className: 'ClaudeAdapter' },
  { name: 'gemini',   importPath: '../../src/main/agent/adapters/gemini/gemini-adapter',       className: 'GeminiAdapter' },
  { name: 'qwen',     importPath: '../../src/main/agent/adapters/qwen-code/qwen-adapter',      className: 'QwenAdapter' },
] as const;

// Adapters that use a hook-event plus a minimum-bytes floor.
const HOOK_PLUS_BYTES_ADAPTERS = [
  { name: 'codex', importPath: '../../src/main/agent/adapters/codex/codex-adapter', className: 'CodexAdapter' },
] as const;

// Adapters that rely only on minimum-bytes evidence (no hook pipeline yet).
const BYTES_ONLY_ADAPTERS = [
  { name: 'opencode', importPath: '../../src/main/agent/adapters/opencode/opencode-adapter',  className: 'OpenCodeAdapter' },
  { name: 'copilot',  importPath: '../../src/main/agent/adapters/copilot/copilot-adapter',    className: 'CopilotAdapter' },
  { name: 'aider',    importPath: '../../src/main/agent/adapters/aider/aider-adapter',        className: 'AiderAdapter' },
  { name: 'cursor',   importPath: '../../src/main/agent/adapters/cursor/cursor-adapter',      className: 'CursorAdapter' },
  { name: 'droid',    importPath: '../../src/main/agent/adapters/droid/droid-adapter',        className: 'DroidAdapter' },
  { name: 'kimi',     importPath: '../../src/main/agent/adapters/kimi/kimi-adapter',          className: 'KimiAdapter' },
  { name: 'warp',     importPath: '../../src/main/agent/adapters/warp/warp-adapter',          className: 'WarpAdapter' },
] as const;

describe('Adapter submissionEvidence shapes', () => {
  describe('Hook-only adapters (hookEventType: Prompt, no minBytes)', () => {
    it.each(HOOK_ONLY_ADAPTERS)(
      '$name declares hookEventType=Prompt and no minBytes',
      async ({ importPath, className }) => {
        // Dynamic import so vitest only loads what it needs
        const module = await import(importPath);
        const AdapterClass = module[className] as new () => { submissionEvidence: Record<string, unknown> };
        const adapter = new AdapterClass();
        const evidence = adapter.submissionEvidence;

        expect(evidence.hookEventType).toBe(EventType.Prompt);
        expect(evidence.minBytes).toBeUndefined();
      },
    );
  });

  describe('Hook + bytes adapters (hookEventType: Prompt and minBytes: 100)', () => {
    it.each(HOOK_PLUS_BYTES_ADAPTERS)(
      '$name declares hookEventType=Prompt and minBytes=100',
      async ({ importPath, className }) => {
        const module = await import(importPath);
        const AdapterClass = module[className] as new () => { submissionEvidence: Record<string, unknown> };
        const adapter = new AdapterClass();
        const evidence = adapter.submissionEvidence;

        expect(evidence.hookEventType).toBe(EventType.Prompt);
        expect(evidence.minBytes).toBe(100);
      },
    );
  });

  describe('Bytes-only adapters (minBytes: 100, no hookEventType)', () => {
    it.each(BYTES_ONLY_ADAPTERS)(
      '$name declares minBytes=100 and no hookEventType',
      async ({ importPath, className }) => {
        const module = await import(importPath);
        const AdapterClass = module[className] as new () => { submissionEvidence: Record<string, unknown> };
        const adapter = new AdapterClass();
        const evidence = adapter.submissionEvidence;

        expect(evidence.minBytes).toBe(100);
        expect(evidence.hookEventType).toBeUndefined();
      },
    );
  });

  it('every registered adapter declares submissionEvidence', async () => {
    // Exhaustive check: no adapter in the registry is missing the property.
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    for (const adapterName of agentRegistry.list()) {
      const adapter = agentRegistry.get(adapterName);
      expect(adapter?.submissionEvidence, `${adapterName} is missing submissionEvidence`).toBeDefined();
    }
  });
});
