/**
 * Regression guard: applyRuntimeConfig must push every config-derived
 * runtime setting into the SessionManager so on-disk config and in-memory
 * state never drift.
 *
 * History: per-project config saves (CONFIG_SET_PROJECT) used to skip
 * setShell/setMaxConcurrent/setIdleTimeout entirely - changing the shell in
 * project settings silently required a project reopen to take effect. This
 * test pins the contract: every setter must fire on every effective-config
 * apply.
 */
import { describe, it, expect, vi } from 'vitest';
import { applyRuntimeConfig } from '../../src/main/config/apply-runtime-config';
import type { SessionManager } from '../../src/main/pty/session-manager';
import type { ConfigManager } from '../../src/main/config/config-manager';
import type { AppConfig } from '../../src/shared/types';

function makeSessionManager() {
  return {
    setMaxConcurrent: vi.fn(),
    setShell: vi.fn(),
    setIdleTimeout: vi.fn(),
  } as unknown as SessionManager & {
    setMaxConcurrent: ReturnType<typeof vi.fn>;
    setShell: ReturnType<typeof vi.fn>;
    setIdleTimeout: ReturnType<typeof vi.fn>;
  };
}

function makeConfigManager(effective: Partial<AppConfig>) {
  return {
    getEffectiveConfig: vi.fn(() => effective as AppConfig),
  } as unknown as ConfigManager & {
    getEffectiveConfig: ReturnType<typeof vi.fn>;
  };
}

describe('applyRuntimeConfig', () => {
  it('pushes every cached runtime setting into SessionManager', () => {
    const sessionManager = makeSessionManager();
    const configManager = makeConfigManager({
      agent: { maxConcurrentSessions: 5, idleTimeoutMinutes: 42 },
      terminal: { shell: '/usr/bin/fish' },
    } as Partial<AppConfig>);

    applyRuntimeConfig(sessionManager, configManager, '/some/project');

    expect(configManager.getEffectiveConfig).toHaveBeenCalledWith('/some/project');
    expect(sessionManager.setMaxConcurrent).toHaveBeenCalledWith(5);
    expect(sessionManager.setShell).toHaveBeenCalledWith('/usr/bin/fish');
    expect(sessionManager.setIdleTimeout).toHaveBeenCalledWith(42);
  });

  it('falls back to global effective config when projectPath is null', () => {
    const sessionManager = makeSessionManager();
    const configManager = makeConfigManager({
      agent: { maxConcurrentSessions: 3, idleTimeoutMinutes: 15 },
      terminal: { shell: null },
    } as Partial<AppConfig>);

    applyRuntimeConfig(sessionManager, configManager, null);

    // Null projectPath becomes undefined for getEffectiveConfig, which then
    // returns the global config without any project overrides applied.
    expect(configManager.getEffectiveConfig).toHaveBeenCalledWith(undefined);
    expect(sessionManager.setShell).toHaveBeenCalledWith(null);
  });
});
