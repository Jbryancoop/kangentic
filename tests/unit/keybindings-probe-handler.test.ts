/**
 * Unit tests for the KEYBINDINGS_PROBE_GLOBAL IPC handler in
 * src/main/ipc/handlers/system.ts.
 *
 * Strategy: mirror config-handler-wiring.test.ts - mock electron's ipcMain to
 * capture registered handlers, then invoke them directly with controlled
 * globalShortcut stub responses.
 *
 * Covered behaviors:
 *  (a) Combo whose comboToAccelerator returns null → 'unsupported', no register.
 *  (b) globalShortcut.register returns true → 'available', unregister called.
 *  (c) globalShortcut.register returns false → 'taken', unregister NOT called.
 *  (d) globalShortcut.isRegistered returns true → 'available', no second register.
 *  (e) globalShortcut.register throws → 'unsupported'.
 *
 * Tier: Unit (vitest, no browser, no Electron).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks - must be declared before any imports that trigger them.
// vi.hoisted() runs before vi.mock() factories, so the mock objects are
// available when the factory is evaluated at hoist time.
// ---------------------------------------------------------------------------

const { capturedHandlers, mockGlobalShortcut } = vi.hoisted(() => {
  const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();
  const mockGlobalShortcut = {
    isRegistered: vi.fn(() => false),
    register: vi.fn(() => true),
    unregister: vi.fn(),
  };
  return { capturedHandlers, mockGlobalShortcut };
});

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '0.0.0'), getPath: vi.fn(() => '/tmp') },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
    on: vi.fn(),
  },
  Notification: { isSupported: vi.fn(() => false) },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
  globalShortcut: mockGlobalShortcut,
}));

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    list: vi.fn(() => []),
    get: vi.fn(() => null),
    getOrThrow: vi.fn(),
    has: vi.fn(() => false),
  },
}));

vi.mock('../../src/main/git/worktree-manager', () => ({ WorktreeManager: class {} }));
vi.mock('../../src/main/git/git-checks', () => ({ isGitRepo: vi.fn(() => false) }));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn() }));
vi.mock('../../src/main/db/repositories/handoff-repository', () => ({
  HandoffRepository: class { listByTaskId = vi.fn(() => []); },
}));
vi.mock('../../src/shared/object-utils', () => ({
  deepMergeConfig: vi.fn((a: unknown, b: unknown) => ({ ...(a as object), ...(b as object) })),
}));
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({ pid: 1234, unref: vi.fn() })),
  exec: vi.fn(),
  execFile: vi.fn(),
}));
vi.mock('../../src/main/config/apply-runtime-config', () => ({
  applyRuntimeConfig: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/projects', () => ({
  syncProjectMcpConfig: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import under test (after all mocks are registered).
// ---------------------------------------------------------------------------

import { registerSystemHandlers } from '../../src/main/ipc/handlers/system';

// ---------------------------------------------------------------------------
// Test context factory (minimal - probe handler needs no project state).
// ---------------------------------------------------------------------------

function makeContext() {
  return {
    configManager: {
      load: vi.fn(() => ({
        agent: { cliPaths: {}, maxConcurrentSessions: 5, idleTimeoutMinutes: 30 },
        terminal: { shell: null },
        mcpServer: { enabled: false },
        autoNameRateLimitPerHour: 60,
      })),
      getEffectiveConfig: vi.fn(() => ({
        agent: { maxConcurrentSessions: 5, idleTimeoutMinutes: 30 },
        terminal: { shell: null },
      })),
      save: vi.fn(),
      saveProjectOverrides: vi.fn(),
      loadProjectOverrides: vi.fn(() => null),
    },
    sessionManager: {
      setMaxConcurrent: vi.fn(),
      setShell: vi.fn(),
      setIdleTimeout: vi.fn(),
    },
    boardConfigManager: { getDefaultBaseBranch: vi.fn(() => null) },
    projectRepo: { list: vi.fn(() => []) },
    shellResolver: { getAvailableShells: vi.fn(() => []), getDefaultShell: vi.fn(() => 'bash') },
    gitDetector: { detect: vi.fn(() => ({ found: false })) },
    mainWindow: {
      minimize: vi.fn(), maximize: vi.fn(), unmaximize: vi.fn(),
      isMaximized: vi.fn(() => false), close: vi.fn(), isFocused: vi.fn(() => true),
      flashFrame: vi.fn(), isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => false), restore: vi.fn(), show: vi.fn(),
      focus: vi.fn(), once: vi.fn(), webContents: { send: vi.fn() },
    },
    currentProjectPath: null,
    currentProjectId: null,
    mcpServerHandle: null,
  };
}

function invokeProbeHandler(combos: string[]): Record<string, 'available' | 'taken' | 'unsupported'> {
  const handler = capturedHandlers.get('keybindings:probeGlobal');
  if (!handler) throw new Error('Handler not registered for keybindings:probeGlobal');
  return handler(undefined, combos) as Record<string, 'available' | 'taken' | 'unsupported'>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('KEYBINDINGS_PROBE_GLOBAL IPC handler', () => {
  beforeEach(() => {
    capturedHandlers.clear();
    mockGlobalShortcut.isRegistered.mockReset().mockReturnValue(false);
    mockGlobalShortcut.register.mockReset().mockReturnValue(true);
    mockGlobalShortcut.unregister.mockReset();
    registerSystemHandlers(makeContext() as Parameters<typeof registerSystemHandlers>[0]);
  });

  // ── (a) Combos that comboToAccelerator cannot express → 'unsupported' ────

  it('returns unsupported for Mod+= (symbol key, no accelerator)', () => {
    const result = invokeProbeHandler(['Mod+=']);
    expect(result['Mod+=']).toBe('unsupported');
  });

  it('returns unsupported for Escape (named key without modifier)', () => {
    const result = invokeProbeHandler(['Escape']);
    expect(result['Escape']).toBe('unsupported');
  });

  it('returns unsupported for Mod+Enter (named key)', () => {
    const result = invokeProbeHandler(['Mod+Enter']);
    expect(result['Mod+Enter']).toBe('unsupported');
  });

  it('does NOT call globalShortcut.register for unsupported combos', () => {
    invokeProbeHandler(['Mod+=', 'Escape']);
    expect(mockGlobalShortcut.register).not.toHaveBeenCalled();
  });

  // ── (b) register() returns true → 'available', unregister() is called ────

  it('returns available when globalShortcut.register succeeds', () => {
    mockGlobalShortcut.register.mockReturnValue(true);
    const result = invokeProbeHandler(['Mod+Shift+P']);
    expect(result['Mod+Shift+P']).toBe('available');
  });

  it('calls unregister after a successful register to release the shortcut', () => {
    mockGlobalShortcut.register.mockReturnValue(true);
    invokeProbeHandler(['Mod+Shift+P']);
    expect(mockGlobalShortcut.unregister).toHaveBeenCalledTimes(1);
    // The accelerator passed to unregister should be the Electron accelerator form.
    expect(mockGlobalShortcut.unregister).toHaveBeenCalledWith('CommandOrControl+Shift+P');
  });

  // ── (c) register() returns false → 'taken', unregister NOT called ────────

  it('returns taken when globalShortcut.register returns false', () => {
    mockGlobalShortcut.register.mockReturnValue(false);
    const result = invokeProbeHandler(['Mod+Shift+P']);
    expect(result['Mod+Shift+P']).toBe('taken');
  });

  it('does NOT call unregister when register returns false (combo was not registered)', () => {
    mockGlobalShortcut.register.mockReturnValue(false);
    invokeProbeHandler(['Mod+Shift+P']);
    expect(mockGlobalShortcut.unregister).not.toHaveBeenCalled();
  });

  // ── (d) isRegistered() true → 'available' without a second register ───────

  it('returns available without calling register when already registered in-process', () => {
    mockGlobalShortcut.isRegistered.mockReturnValue(true);
    const result = invokeProbeHandler(['Mod+N']);
    expect(result['Mod+N']).toBe('available');
    expect(mockGlobalShortcut.register).not.toHaveBeenCalled();
  });

  // ── (e) register() throws → 'unsupported' ────────────────────────────────

  it('returns unsupported when globalShortcut.register throws', () => {
    mockGlobalShortcut.register.mockImplementation(() => {
      throw new Error('platform refused to register');
    });
    const result = invokeProbeHandler(['Mod+Shift+P']);
    expect(result['Mod+Shift+P']).toBe('unsupported');
  });

  it('does NOT call unregister when register throws', () => {
    mockGlobalShortcut.register.mockImplementation(() => {
      throw new Error('kaboom');
    });
    invokeProbeHandler(['Mod+Shift+P']);
    expect(mockGlobalShortcut.unregister).not.toHaveBeenCalled();
  });

  // ── Multiple combos in one call ───────────────────────────────────────────

  it('returns independent results for each combo in a batch', () => {
    // Mod+Shift+S: accelerator-supported, register succeeds → available.
    // Mod+=: no accelerator → unsupported.
    // Mod+N: isRegistered returns false, register returns false → taken.
    mockGlobalShortcut.isRegistered.mockReturnValue(false);
    mockGlobalShortcut.register
      .mockReturnValueOnce(true) // first supportable combo: Mod+Shift+S
      .mockReturnValueOnce(false); // second supportable combo: Mod+N

    const result = invokeProbeHandler(['Mod+Shift+S', 'Mod+=', 'Mod+N']);
    expect(result['Mod+Shift+S']).toBe('available');
    expect(result['Mod+=']).toBe('unsupported');
    expect(result['Mod+N']).toBe('taken');
  });
});
