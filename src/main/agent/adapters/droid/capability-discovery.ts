/**
 * Droid capability discovery: intentional model override omission.
 *
 * Droid is a TUI-first agent with interactive controls for model selection,
 * autonomy cycling (Tab key), and other settings. The design intent
 * (see .claude/rules/cli-features-over-custom-layers.md) is to NOT shadow the
 * TUI with per-spawn CLI flags or Kangentic settings injection.
 *
 * This adapter returns supportsModelOverride: false to hide the model/effort
 * dropdowns in the UI, leaving model selection entirely to the Droid TUI.
 */

import type { AgentCapabilities } from '../../../../shared/types';

/**
 * Discover Droid's capabilities. Returns supportsModelOverride: false
 * by design - Droid's TUI already exposes all settings, no need to shadow them.
 */
export async function discoverDroidCapabilities(_cliPath: string): Promise<AgentCapabilities> {
  return {
    // Droid is TUI-first. Model/effort selection stays in the TUI.
    supportsModelOverride: false,
    // Droid has no effort concept
    effortLevels: [],
  };
}
