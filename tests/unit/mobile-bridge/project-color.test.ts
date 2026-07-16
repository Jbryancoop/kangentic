/**
 * Unit tests for src/main/mobile-bridge/handlers/project-color.ts
 *
 * deriveProjectAccentColor must be pure and deterministic (both sides of
 * a pairing derive the same color with nothing stored), always land
 * inside the curated palette (the wire parser requires #rrggbb), and
 * actually spread distinct ids across the palette rather than clumping.
 */
import { describe, it, expect } from 'vitest';
import { deriveProjectAccentColor, PROJECT_ACCENT_PALETTE } from '../../../src/main/mobile-bridge/handlers/project-color';

describe('deriveProjectAccentColor', () => {
  it('is deterministic for the same project id', () => {
    const first = deriveProjectAccentColor('proj-abc-123');
    for (let repetition = 0; repetition < 5; repetition++) {
      expect(deriveProjectAccentColor('proj-abc-123')).toBe(first);
    }
  });

  it('always returns a palette member in #rrggbb form', () => {
    const wireColorPattern = /^#[0-9a-fA-F]{6}$/;
    for (let index = 0; index < 200; index++) {
      const color = deriveProjectAccentColor(`project-${index}-${index * 31}`);
      expect(PROJECT_ACCENT_PALETTE).toContain(color);
      expect(color).toMatch(wireColorPattern);
    }
    expect(deriveProjectAccentColor('')).toMatch(wireColorPattern);
  });

  it('spreads distinct ids across the palette instead of clumping', () => {
    const seenColors = new Set<string>();
    for (let index = 0; index < 100; index++) {
      seenColors.add(deriveProjectAccentColor(`b7e4c2a0-${index}-uuid-ish-id`));
    }
    // A healthy hash over 100 ids should hit most of a 12-entry palette;
    // requiring 8+ distinct colors catches a broken hash (e.g. one that
    // only looks at the shared prefix) without being flaky.
    expect(seenColors.size).toBeGreaterThanOrEqual(8);
  });

  it('differs for ids that share a long common prefix', () => {
    const colors = new Set(['-1', '-2', '-3', '-4', '-5', '-6'].map((suffix) => deriveProjectAccentColor(`same-long-project-prefix${suffix}`)));
    expect(colors.size).toBeGreaterThan(1);
  });
});
