import { describe, it, expect } from 'vitest';
import { discoverDroidCapabilities } from '../../src/main/agent/adapters/droid/capability-discovery';

describe('Droid Capability Discovery', () => {
  it('returns supportsModelOverride: false by design', async () => {
    const caps = await discoverDroidCapabilities('/usr/bin/droid');

    expect(caps).toBeDefined();
    expect(caps.supportsModelOverride).toBe(false);
  });

  it('returns empty effortLevels since Droid is TUI-first', async () => {
    const caps = await discoverDroidCapabilities('/usr/bin/droid');

    // Droid has no effort levels - TUI handles all settings
    expect(caps.effortLevels).toEqual([]);
  });

  it('returns no models since model selection is TUI-only', async () => {
    const caps = await discoverDroidCapabilities('/usr/bin/droid');

    // Droid model selection is TUI-only per user preference
    expect(caps.models).toBeUndefined();
  });

  it('always returns the same capabilities object', async () => {
    const caps1 = await discoverDroidCapabilities('/usr/bin/droid');
    const caps2 = await discoverDroidCapabilities('/nonexistent/droid');

    // Always returns the same intentional omission
    expect(caps1.supportsModelOverride).toBe(false);
    expect(caps2.supportsModelOverride).toBe(false);
  });
});
