import { describe, it, expect, beforeEach } from 'vitest';
import { UsageAccumulator } from '../../src/main/pty/activity/usage-accumulator';
import type { SessionUsage } from '../../src/shared/types';

/**
 * UsageAccumulator.setSessionUsage() merge behavior tests.
 *
 * The merge logic uses shallow spread:
 *   contextWindow: { ...base.contextWindow, ...(partial.contextWindow ?? {}) }
 *
 * This means partial updates must only include fields that were actually
 * captured. If a partial includes `contextWindowSize: 0` (default for
 * uncaptured), it overwrites a previously-set non-zero value. These
 * tests verify the merge produces correct results when telemetry
 * arrives across multiple chunks (Codex append-mode JSONL).
 */
describe('UsageAccumulator.setSessionUsage - merge behavior', () => {
  let usage: UsageAccumulator;

  beforeEach(() => {
    usage = new UsageAccumulator();
  });

  it('partial contextWindow merge does not overwrite base values with zeros', () => {
    let merged = usage.setSessionUsage('test-session', {
      contextWindow: { contextWindowSize: 200000 },
    } as Partial<SessionUsage>);
    expect(merged.contextWindow.contextWindowSize).toBe(200000);

    merged = usage.setSessionUsage('test-session', {
      model: { id: 'gpt-5.3-codex', displayName: 'gpt-5.3-codex' },
    } as Partial<SessionUsage>);

    expect(merged.contextWindow.contextWindowSize).toBe(200000);
    expect(merged.model.id).toBe('gpt-5.3-codex');
  });

  it('usedPercentage is recalculated after cross-chunk merge', () => {
    let merged = usage.setSessionUsage('test-session', {
      contextWindow: { contextWindowSize: 200000 },
    } as Partial<SessionUsage>);
    expect(merged.contextWindow.usedPercentage).toBe(0);

    merged = usage.setSessionUsage('test-session', {
      contextWindow: { usedTokens: 180000 },
    } as Partial<SessionUsage>);

    expect(merged.contextWindow.contextWindowSize).toBe(200000);
    expect(merged.contextWindow.usedTokens).toBe(180000);
    expect(merged.contextWindow.usedPercentage).toBeCloseTo(
      (180000 / 200000) * 100,
      2,
    );
  });

  it('model merge preserves base model when partial has no model', () => {
    let merged = usage.setSessionUsage('test-session', {
      model: { id: 'gpt-5.3-codex', displayName: 'gpt-5.3-codex' },
    } as Partial<SessionUsage>);
    expect(merged.model.id).toBe('gpt-5.3-codex');

    merged = usage.setSessionUsage('test-session', {
      contextWindow: {
        usedTokens: 50000,
        totalInputTokens: 50000,
        contextWindowSize: 200000,
      },
    } as Partial<SessionUsage>);

    expect(merged.model.id).toBe('gpt-5.3-codex');
    expect(merged.model.displayName).toBe('gpt-5.3-codex');
    expect(merged.contextWindow.usedTokens).toBe(50000);
  });

  it('three-chunk Codex sequence produces correct final state', () => {
    usage.setSessionUsage('test-session', {
      contextWindow: { contextWindowSize: 258400 },
    } as Partial<SessionUsage>);

    usage.setSessionUsage('test-session', {
      model: { id: 'gpt-5.3-codex', displayName: 'gpt-5.3-codex' },
    } as Partial<SessionUsage>);

    const final = usage.setSessionUsage('test-session', {
      contextWindow: {
        usedTokens: 180000,
        totalInputTokens: 180000,
        totalOutputTokens: 50,
        cacheTokens: 5000,
      },
    } as Partial<SessionUsage>);

    expect(final.model.id).toBe('gpt-5.3-codex');
    expect(final.contextWindow.contextWindowSize).toBe(258400);
    expect(final.contextWindow.usedTokens).toBe(180000);
    expect(final.contextWindow.totalOutputTokens).toBe(50);
    expect(final.contextWindow.cacheTokens).toBe(5000);
    expect(final.contextWindow.usedPercentage).toBeCloseTo(
      (180000 / 258400) * 100,
      2,
    );
  });
});
