/**
 * Unit tests for the BROWSER_CLEAR_STORAGE IPC handler in
 * src/main/ipc/handlers/browser.ts.
 *
 * The handler must:
 *   - call session.fromPartition with the exact BROWSER_PARTITION constant
 *   - call clearStorageData with the exact storages array
 *   - then call clearCache, then clearAuthCache, in that order
 *   - propagate rejection when any sub-call throws
 *
 * Strategy mirrors agent-list-handler.test.ts: capture ipcMain.handle
 * registrations via a mocked electron module, then invoke the captured
 * handler directly without a running Electron process.
 *
 * vi.hoisted() is required for the fake session spies because vi.mock()
 * factories are hoisted to the top of the module by Vitest's transform,
 * which means they execute before any top-level variable declarations.
 * Wrapping the spies in vi.hoisted() ensures they are initialized before
 * the factory runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted spy objects
// ---------------------------------------------------------------------------

const {
  capturedHandlers,
  fakeClearStorageData,
  fakeClearCache,
  fakeClearAuthCache,
  fakeFromPartition,
} = vi.hoisted(() => {
  const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();

  const fakeClearStorageData = vi.fn(async () => undefined);
  const fakeClearCache = vi.fn(async () => undefined);
  const fakeClearAuthCache = vi.fn(async () => undefined);

  const fakeSession = {
    clearStorageData: fakeClearStorageData,
    clearCache: fakeClearCache,
    clearAuthCache: fakeClearAuthCache,
  };

  const fakeFromPartition = vi.fn((_partition: string) => fakeSession);

  return {
    capturedHandlers,
    fakeClearStorageData,
    fakeClearCache,
    fakeClearAuthCache,
    fakeFromPartition,
  };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '0.0.0'),
    getPath: vi.fn(() => '/tmp'),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
    on: vi.fn(),
  },
  session: {
    fromPartition: fakeFromPartition,
  },
  Notification: { isSupported: vi.fn(() => false) },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
}));

vi.mock('../../src/main/browser/browser-url-store', () => ({
  browserUrlStore: {
    get: vi.fn(() => null),
    set: vi.fn(),
    clear: vi.fn(),
  },
}));

vi.mock('node:fs', () => ({
  default: {
    promises: {
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined),
    },
  },
  promises: {
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
  },
}));

// ---------------------------------------------------------------------------
// Import under test (must come after all vi.mock() calls)
// ---------------------------------------------------------------------------

import { registerBrowserHandlers } from '../../src/main/ipc/handlers/browser';
import { BROWSER_PARTITION } from '../../src/shared/browser-partition';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext() {
  return {
    currentProjectPath: null,
    currentProjectId: null,
    configManager: {
      loadProjectOverrides: vi.fn(() => null),
    },
    pasteEngine: {
      pasteAndSubmit: vi.fn(async () => undefined),
    },
  };
}

async function invokeClearStorage(): Promise<unknown> {
  const handler = capturedHandlers.get('browser:clearStorage');
  if (!handler) throw new Error('browser:clearStorage handler not registered');
  // Pass undefined as the first arg to match ipcMain.handle's (_event) signature
  // without needing a real IpcMainInvokeEvent object.
  return handler(undefined);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BROWSER_CLEAR_STORAGE IPC handler', () => {
  beforeEach(() => {
    capturedHandlers.clear();
    fakeFromPartition.mockClear();
    fakeClearStorageData.mockClear();
    fakeClearCache.mockClear();
    fakeClearAuthCache.mockClear();
    // Restore default resolving behavior before each test.
    fakeClearStorageData.mockResolvedValue(undefined);
    fakeClearCache.mockResolvedValue(undefined);
    fakeClearAuthCache.mockResolvedValue(undefined);

    const context = makeContext();
    registerBrowserHandlers(context as Parameters<typeof registerBrowserHandlers>[0]);
  });

  it('calls session.fromPartition with the BROWSER_PARTITION constant', async () => {
    await invokeClearStorage();

    expect(fakeFromPartition).toHaveBeenCalledOnce();
    expect(fakeFromPartition).toHaveBeenCalledWith(BROWSER_PARTITION);
    expect(fakeFromPartition).toHaveBeenCalledWith('persist:kangentic-browser');
  });

  it('calls clearStorageData with the exact storages array', async () => {
    await invokeClearStorage();

    expect(fakeClearStorageData).toHaveBeenCalledOnce();
    expect(fakeClearStorageData).toHaveBeenCalledWith({
      storages: ['cookies', 'localstorage', 'indexdb', 'shadercache', 'cachestorage', 'serviceworkers'],
    });
  });

  it('calls clearCache after clearStorageData, then clearAuthCache after clearCache', async () => {
    const callOrder: string[] = [];

    fakeClearStorageData.mockImplementation(async () => { callOrder.push('clearStorageData'); });
    fakeClearCache.mockImplementation(async () => { callOrder.push('clearCache'); });
    fakeClearAuthCache.mockImplementation(async () => { callOrder.push('clearAuthCache'); });

    await invokeClearStorage();

    expect(callOrder).toEqual(['clearStorageData', 'clearCache', 'clearAuthCache']);
  });

  it('propagates rejection when clearStorageData throws', async () => {
    fakeClearStorageData.mockRejectedValue(new Error('disk full'));

    await expect(invokeClearStorage()).rejects.toThrow('disk full');
  });

  it('propagates rejection when clearCache throws after clearStorageData resolves', async () => {
    fakeClearStorageData.mockResolvedValue(undefined);
    fakeClearCache.mockRejectedValue(new Error('cache error'));

    await expect(invokeClearStorage()).rejects.toThrow('cache error');
  });

  it('propagates rejection when clearAuthCache throws after clearStorageData and clearCache resolve', async () => {
    fakeClearStorageData.mockResolvedValue(undefined);
    fakeClearCache.mockResolvedValue(undefined);
    fakeClearAuthCache.mockRejectedValue(new Error('auth cache error'));

    await expect(invokeClearStorage()).rejects.toThrow('auth cache error');
  });

  it('does not call clearCache when clearStorageData rejects (partial-failure stops the chain)', async () => {
    fakeClearStorageData.mockRejectedValue(new Error('storage error'));

    await expect(invokeClearStorage()).rejects.toThrow();

    expect(fakeClearCache).not.toHaveBeenCalled();
  });
});
