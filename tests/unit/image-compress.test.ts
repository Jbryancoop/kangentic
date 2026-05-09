/**
 * Unit tests for `compressClipboardImage` skip rules and failure path.
 *
 * Covers three gaps identified in the audit:
 *   1. Failure path - createImageBitmap rejects -> toast + original file returned.
 *   2. GIF passthrough - SKIP_RECOMPRESS_MEDIA_TYPES short-circuits before bitmap decode.
 *   3. PNG-already-fits skip - scale === 1 && mediaType === 'image/png' early return.
 *
 * The <500KB skip (MIN_COMPRESS_BYTES) is already covered transitively by the UI
 * tier "small PNG paste is left untouched" test in image-compression.spec.ts.
 *
 * Strategy: mock createImageBitmap, OffscreenCanvas, and the toast+config stores.
 * jsdom lacks both OffscreenCanvas.convertToBlob and createImageBitmap, so we
 * install globals before the module loads via vi.hoisted + beforeEach assignments.
 * The test never reaches the encoding pipeline - we only exercise the skip/catch
 * branches, so OffscreenCanvas only needs to be constructable, not fully functional.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted store mocks - must be declared before any import that transitively
// loads a Zustand store, so vi.hoisted runs at module-evaluation time.
// ---------------------------------------------------------------------------

const storeMocks = vi.hoisted(() => ({
  useToastStore: { getState: vi.fn() },
  useConfigStore: { getState: vi.fn() },
}));

vi.mock('../../src/renderer/stores/toast-store', () => ({
  useToastStore: storeMocks.useToastStore,
}));

vi.mock('../../src/renderer/stores/config-store', () => ({
  useConfigStore: storeMocks.useConfigStore,
}));

// ---------------------------------------------------------------------------
// Browser global stubs - createImageBitmap and OffscreenCanvas must exist
// before the module under test is imported. We assign them in beforeEach so
// individual tests can override createImageBitmap to reject.
// ---------------------------------------------------------------------------

/** Minimal ImageBitmap stub. close() is a no-op. */
function makeImageBitmap(width: number, height: number): ImageBitmap {
  return {
    width,
    height,
    close: vi.fn(),
  } as unknown as ImageBitmap;
}

/** Minimal OffscreenCanvas stub. convertToBlob is never called by the paths we test. */
class StubOffscreenCanvas {
  constructor(
    public readonly width: number,
    public readonly height: number,
  ) {}

  getContext(): CanvasRenderingContext2D {
    return {
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
  }

  convertToBlob(): Promise<Blob> {
    // Not reached by any skip path; the catch path never constructs a canvas.
    return Promise.resolve(new Blob([], { type: 'image/webp' }));
  }
}

// ---------------------------------------------------------------------------
// Imports after mocks are hoisted.
// ---------------------------------------------------------------------------

import { compressClipboardImage, MIN_COMPRESS_BYTES } from '../../src/renderer/components/dialogs/image-compress';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TOAST_CONFIG = {
  config: {
    notifications: {
      toasts: {
        durationSeconds: 4,
        maxCount: 5,
      },
    },
  },
};

/** Build a File large enough to pass the MIN_COMPRESS_BYTES guard. */
function makeLargeFile(mediaType: string, name: string): File {
  // One byte over the threshold so MIN_COMPRESS_BYTES is not the skip trigger.
  const bytes = new Uint8Array(MIN_COMPRESS_BYTES + 1);
  return new File([bytes], name, { type: mediaType });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('compressClipboardImage', () => {
  let addToastMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Reset the toast spy between tests.
    addToastMock = vi.fn();
    storeMocks.useToastStore.getState.mockReturnValue({ addToast: addToastMock });
    storeMocks.useConfigStore.getState.mockReturnValue(TOAST_CONFIG);

    // Install browser globals. Individual tests may override createImageBitmap.
    globalThis.createImageBitmap = vi
      .fn()
      .mockResolvedValue(makeImageBitmap(1000, 800));

    // Cast via `unknown` to satisfy TypeScript without the full constructor signature.
    globalThis.OffscreenCanvas = StubOffscreenCanvas as unknown as typeof OffscreenCanvas;
  });

  describe('GIF passthrough (SKIP_RECOMPRESS_MEDIA_TYPES)', () => {
    it('returns the original GIF file without compression', async () => {
      const gifFile = makeLargeFile('image/gif', 'animation.gif');

      const result = await compressClipboardImage(gifFile);

      expect(result.compressed).toBe(false);
      expect(result.file).toBe(gifFile);
      // createImageBitmap must NOT have been called - skip happens before bitmap decode.
      expect(globalThis.createImageBitmap).not.toHaveBeenCalled();
    });

    it('returns the original SVG file without compression', async () => {
      const svgFile = makeLargeFile('image/svg+xml', 'diagram.svg');

      const result = await compressClipboardImage(svgFile);

      expect(result.compressed).toBe(false);
      expect(result.file).toBe(svgFile);
      expect(globalThis.createImageBitmap).not.toHaveBeenCalled();
    });
  });

  describe('PNG-already-fits skip (scale === 1 && mediaType === image/png)', () => {
    it('returns the original PNG when long edge is under LONG_EDGE_TARGET', async () => {
      // Bitmap dimensions 1000x800 -> long edge 1000 < 1568 -> scale === 1.
      // mediaType === 'image/png' -> early return without encoding.
      const pngFile = makeLargeFile('image/png', 'screenshot.png');

      const result = await compressClipboardImage(pngFile);

      expect(result.compressed).toBe(false);
      expect(result.file).toBe(pngFile);
      expect(addToastMock).not.toHaveBeenCalled();
    });

    it('does NOT skip a JPEG that fits the long-edge target', async () => {
      // JPEG with 1000x800 still gets encoded (no PNG exception for JPEG).
      // We make convertToBlob return a tiny blob so the function succeeds.
      const jpegFile = makeLargeFile('image/jpeg', 'photo.jpg');

      // Override convertToBlob to return a blob small enough to satisfy TARGET_BYTES.
      const tinyBlob = new Blob([new Uint8Array(1000)], { type: 'image/webp' });
      StubOffscreenCanvas.prototype.convertToBlob = vi
        .fn()
        .mockResolvedValue(tinyBlob);

      const result = await compressClipboardImage(jpegFile);

      // The JPEG should have gone through the encoding pipeline.
      expect(result.compressed).toBe(true);
      expect(result.file.type).toBe('image/webp');
    });
  });

  describe('failure path (createImageBitmap rejects)', () => {
    it('returns the original file and emits the warning toast', async () => {
      const decodeError = new Error('GPU process crashed');
      (globalThis.createImageBitmap as ReturnType<typeof vi.fn>).mockRejectedValue(
        decodeError,
      );

      const pngFile = makeLargeFile('image/png', 'corrupt.png');
      // Use a PNG with long edge > LONG_EDGE_TARGET so we do not hit the
      // PNG-already-fits skip before createImageBitmap is invoked.
      // We achieve this by mocking createImageBitmap to reject -- the mock
      // is already set up to reject, so the PNG dimensions never matter.

      const result = await compressClipboardImage(pngFile);

      expect(result.compressed).toBe(false);
      expect(result.file).toBe(pngFile);

      // Toast must have been called exactly once with the canonical message.
      expect(addToastMock).toHaveBeenCalledOnce();
      expect(addToastMock).toHaveBeenCalledWith({
        message: 'Could not compress image - using original.',
        variant: 'warning',
      });
    });

    it('does not re-throw the error', async () => {
      (globalThis.createImageBitmap as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Out of memory'),
      );

      const file = makeLargeFile('image/png', 'big.png');
      // Confirm the function resolves rather than rejects.
      await expect(compressClipboardImage(file)).resolves.toBeDefined();
    });
  });
});
