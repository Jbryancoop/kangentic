/**
 * Unit tests for the shutdown leak fixes:
 *   - mcp-http-server.close() calls closeAllConnections() BEFORE close()
 *   - inspection-server.stopInspectionServer() calls closeAllConnections() BEFORE close()
 *
 * Both fixes plug the keep-alive HTTP socket leak that was keeping Electron
 * processes alive past the 6s hard-failsafe (recurrence reported on
 * 2026-05-09 from a normal `npm run dev` close).
 *
 * The close logic is exported as standalone helpers
 * (`closeMcpHttpServerSafely`, `closeInspectionServerSafely`) so these
 * tests can drive a hand-rolled stub WITHOUT loading the heavy host
 * modules. Loading `src/main/agent/mcp-http-server` here would pull in
 * the full @modelcontextprotocol/sdk + agent commands graph, and any
 * upstream test that already loaded `node:http` would defeat per-test
 * vi.mock isolation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { closeMcpHttpServerSafely } from '../../src/main/agent/mcp-http-server';
import { closeInspectionServerSafely } from '../../src/devtools/main/inspection-server';

interface ServerStub {
  close: ReturnType<typeof vi.fn>;
  closeAllConnections: ReturnType<typeof vi.fn>;
  callOrder: string[];
}

function makeServerStub(): ServerStub {
  const callOrder: string[] = [];
  return {
    callOrder,
    close: vi.fn(() => { callOrder.push('close'); }),
    closeAllConnections: vi.fn(() => { callOrder.push('closeAllConnections'); }),
  };
}

describe('closeMcpHttpServerSafely', () => {
  let stub: ServerStub;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    stub = makeServerStub();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('calls closeAllConnections() BEFORE close() on shutdown', () => {
    // Cast lossy because the real Server has 100+ members; the helper
    // only reads the two we care about.
    closeMcpHttpServerSafely(stub as unknown as Parameters<typeof closeMcpHttpServerSafely>[0]);

    expect(stub.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(stub.close).toHaveBeenCalledTimes(1);
    expect(stub.callOrder).toEqual(['closeAllConnections', 'close']);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('skips close() when closeAllConnections() throws and logs the error', () => {
    stub.closeAllConnections.mockImplementationOnce(() => {
      throw new Error('synthetic failure');
    });

    closeMcpHttpServerSafely(stub as unknown as Parameters<typeof closeMcpHttpServerSafely>[0]);

    // The try/catch wraps BOTH calls intentionally: shutdown is best-effort
    // and the hard failsafe is the backstop. If closeAllConnections throws,
    // close() does NOT run; the catch logs the error and returns.
    expect(stub.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(stub.close).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      '[mcp-http] close() failed:',
      expect.any(Error),
    );
  });

  it('logs and swallows when close() itself throws', () => {
    stub.close.mockImplementationOnce(() => {
      throw new Error('synthetic close failure');
    });

    expect(() =>
      closeMcpHttpServerSafely(stub as unknown as Parameters<typeof closeMcpHttpServerSafely>[0]),
    ).not.toThrow();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});

describe('closeInspectionServerSafely', () => {
  let stub: ServerStub;

  beforeEach(() => {
    vi.restoreAllMocks();
    stub = makeServerStub();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('calls closeAllConnections() BEFORE close() on shutdown', () => {
    closeInspectionServerSafely(stub as unknown as Parameters<typeof closeInspectionServerSafely>[0]);

    expect(stub.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(stub.close).toHaveBeenCalledTimes(1);
    expect(stub.callOrder).toEqual(['closeAllConnections', 'close']);
  });

  it('swallows errors silently (best-effort)', () => {
    stub.closeAllConnections.mockImplementationOnce(() => {
      throw new Error('synthetic failure');
    });

    expect(() =>
      closeInspectionServerSafely(stub as unknown as Parameters<typeof closeInspectionServerSafely>[0]),
    ).not.toThrow();
    // close() not called because closeAllConnections threw before it.
    expect(stub.close).not.toHaveBeenCalled();
  });
});
