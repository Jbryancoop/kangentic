/**
 * Unit tests for the BROWSER_PARTITION constant in
 * src/shared/browser-partition.ts.
 *
 * The constant must be a stable string that both the renderer (<webview partition>)
 * and the main process (session.fromPartition) import from the same source.
 * Any accidental change would silently create a second partition and break
 * the clear-storage IPC handler.
 */

import { describe, it, expect } from 'vitest';
import { BROWSER_PARTITION } from '../../src/shared/browser-partition';

describe('BROWSER_PARTITION', () => {
  it('equals the canonical string "persist:kangentic-browser"', () => {
    expect(BROWSER_PARTITION).toBe('persist:kangentic-browser');
  });

  it('starts with "persist:" so Electron creates a named persistent session', () => {
    expect(BROWSER_PARTITION.startsWith('persist:')).toBe(true);
  });
});
