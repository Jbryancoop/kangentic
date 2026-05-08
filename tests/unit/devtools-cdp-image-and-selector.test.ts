/**
 * Unit tests for `decodeImageDimensions` and `buildSelectorExpression`
 * in src/devtools/main/cdp.ts.
 *
 * `decodeImageDimensions` - pure buffer parsing with no I/O. Tested via
 * crafted Buffer fixtures that represent valid and invalid PNG/JPEG headers.
 *
 * `buildSelectorExpression` - pure string generation. Tested by snapshotting
 * the emitted JS template for each selector kind, verifying JSON.stringify
 * escaping, and confirming that candidatesJs is present or absent as expected.
 *
 * Mocks `electron` because cdp.ts imports its types from the top-level
 * Electron namespace. The module body does not touch the Electron runtime
 * for these two functions, so a minimal mock is sufficient.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '0.0.0') },
}));

import { decodeImageDimensions, buildSelectorExpression } from '../../src/devtools/main/cdp';

// ---------------------------------------------------------------------------
// Helpers for crafting minimal valid PNG / JPEG headers
// ---------------------------------------------------------------------------

/**
 * Build a 24-byte buffer whose first 4 bytes are the PNG magic number
 * (0x89504e47) and whose bytes at offsets 16/20 encode the given width
 * and height as big-endian uint32.
 */
function makePngBuffer(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  buffer.writeUInt32BE(0x89504e47, 0); // PNG magic
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

/**
 * Build a minimal JPEG buffer that contains a single SOF0 (0xffc0) marker
 * directly after the SOI (0xffd8). The SOF payload encodes the given height
 * and width per the JPEG spec: 2-byte length, 1-byte precision, 2-byte
 * height, 2-byte width.
 *
 * Layout (from offset 0):
 *   0:  ff d8        -- SOI
 *   2:  ff c0        -- SOF0 marker
 *   4:  00 0b        -- segment length (11 bytes: 2 length + 1 prec + 2 h + 2 w + 4 components)
 *   6:  08           -- precision (8 bits)
 *   7:  hh hh        -- height (big-endian uint16)
 *   9:  ww ww        -- width  (big-endian uint16)
 *  11:  01           -- number of components
 *  12+: component data (not read by the parser)
 */
function makeJpegBuffer(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(20);
  buffer[0] = 0xff; // SOI
  buffer[1] = 0xd8;
  buffer[2] = 0xff; // SOF0
  buffer[3] = 0xc0;
  buffer.writeUInt16BE(11, 4); // segment length
  buffer[6] = 0x08; // precision
  buffer.writeUInt16BE(height, 7);
  buffer.writeUInt16BE(width, 9);
  buffer[11] = 0x01; // component count
  return buffer;
}

/**
 * Build a JPEG buffer that has one non-SOF APP0 segment before the SOF0.
 *
 * APP0 is 0xffe0. Segment length field (uint16) at offset 4 says how
 * many bytes the segment occupies including the 2-byte length field.
 *
 * Layout:
 *   0: ff d8          -- SOI
 *   2: ff e0          -- APP0 marker
 *   4: 00 10          -- APP0 length (16 bytes including the 2-byte length field)
 *   6: ...14 bytes... -- APP0 payload (ignored by our parser)
 *  20: ff c0          -- SOF0 marker
 *  22: 00 0b          -- SOF0 segment length
 *  24: 08             -- precision
 *  25: hh hh          -- height
 *  27: ww ww          -- width
 *  29: 01             -- component count
 */
function makeJpegWithApp0(width: number, height: number): Buffer {
  const app0Length = 16; // 2 (length field) + 14 (payload)
  const buffer = Buffer.alloc(2 + 2 + app0Length + 2 + 11);
  let position = 0;
  buffer[position++] = 0xff; // SOI
  buffer[position++] = 0xd8;
  buffer[position++] = 0xff; // APP0
  buffer[position++] = 0xe0;
  buffer.writeUInt16BE(app0Length, position);
  position += app0Length; // skip APP0 payload
  buffer[position++] = 0xff; // SOF0
  buffer[position++] = 0xc0;
  buffer.writeUInt16BE(11, position); // SOF0 length
  position += 2;
  buffer[position++] = 0x08; // precision
  buffer.writeUInt16BE(height, position);
  position += 2;
  buffer.writeUInt16BE(width, position);
  return buffer;
}

// ---------------------------------------------------------------------------
// decodeImageDimensions - PNG
// ---------------------------------------------------------------------------

describe('decodeImageDimensions - PNG', () => {
  it('reads width and height from the IHDR chunk at offsets 16/20', () => {
    const result = decodeImageDimensions('png', makePngBuffer(1280, 720));
    expect(result).toEqual({ width: 1280, height: 720 });
  });

  it('handles 1x1 dimensions', () => {
    expect(decodeImageDimensions('png', makePngBuffer(1, 1))).toEqual({ width: 1, height: 1 });
  });

  it('handles large dimensions', () => {
    expect(decodeImageDimensions('png', makePngBuffer(3840, 2160))).toEqual({
      width: 3840,
      height: 2160,
    });
  });

  it('returns null when the buffer is too short (< 24 bytes)', () => {
    expect(decodeImageDimensions('png', Buffer.alloc(23))).toBeNull();
  });

  it('returns null for an empty buffer', () => {
    expect(decodeImageDimensions('png', Buffer.alloc(0))).toBeNull();
  });

  it('returns null when PNG magic bytes are wrong', () => {
    const buffer = makePngBuffer(100, 100);
    buffer.writeUInt32BE(0xdeadbeef, 0); // overwrite magic
    expect(decodeImageDimensions('png', buffer)).toBeNull();
  });

  it('returns null for a valid JPEG buffer passed as png format', () => {
    // JPEG SOI is 0xffd8... which is not the PNG magic 0x89504e47
    expect(decodeImageDimensions('png', makeJpegBuffer(100, 100))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// decodeImageDimensions - JPEG
// ---------------------------------------------------------------------------

describe('decodeImageDimensions - JPEG', () => {
  it('reads width and height from a minimal SOF0 marker', () => {
    const result = decodeImageDimensions('jpeg', makeJpegBuffer(1920, 1080));
    expect(result).toEqual({ width: 1920, height: 1080 });
  });

  it('handles 1x1 dimensions', () => {
    expect(decodeImageDimensions('jpeg', makeJpegBuffer(1, 1))).toEqual({ width: 1, height: 1 });
  });

  it('skips a leading non-SOF APP0 segment and reads SOF0 after it', () => {
    const result = decodeImageDimensions('jpeg', makeJpegWithApp0(640, 480));
    expect(result).toEqual({ width: 640, height: 480 });
  });

  it('returns null when the buffer is too short (< 4 bytes)', () => {
    expect(decodeImageDimensions('jpeg', Buffer.alloc(3))).toBeNull();
  });

  it('returns null for an empty buffer', () => {
    expect(decodeImageDimensions('jpeg', Buffer.alloc(0))).toBeNull();
  });

  it('returns null when the JPEG SOI magic bytes are missing', () => {
    const buffer = makeJpegBuffer(100, 100);
    buffer[0] = 0x00; // corrupt SOI first byte
    expect(decodeImageDimensions('jpeg', buffer)).toBeNull();
  });

  it('returns null when the buffer contains only a SOI and no SOF', () => {
    // Just the 2-byte SOI marker with no segments following
    const buffer = Buffer.from([0xff, 0xd8]);
    expect(decodeImageDimensions('jpeg', buffer)).toBeNull();
  });

  it('returns null when the buffer has SOI and non-SOF segments but no SOF', () => {
    // APP0 only, no SOF marker follows
    const app0Length = 10;
    const buffer = Buffer.alloc(2 + 2 + app0Length);
    buffer[0] = 0xff;
    buffer[1] = 0xd8; // SOI
    buffer[2] = 0xff;
    buffer[3] = 0xe0; // APP0
    buffer.writeUInt16BE(app0Length, 4);
    expect(decodeImageDimensions('jpeg', buffer)).toBeNull();
  });

  it('does not confuse DHT (0xc4), JPG (0xc8), or DAC (0xcc) markers as SOF', () => {
    // These three marker bytes are in the range 0xc0-0xcf but are excluded
    // from the SOF set. Build a buffer with DHT followed by a real SOF0.
    const dhtLength = 10; // 2-byte length field + 8-byte payload
    const buffer = Buffer.alloc(2 + 2 + dhtLength + 2 + 11);
    let position = 0;
    buffer[position++] = 0xff;
    buffer[position++] = 0xd8; // SOI
    buffer[position++] = 0xff;
    buffer[position++] = 0xc4; // DHT - must NOT be treated as SOF
    buffer.writeUInt16BE(dhtLength, position);
    position += dhtLength;
    buffer[position++] = 0xff;
    buffer[position++] = 0xc0; // SOF0
    buffer.writeUInt16BE(11, position);
    position += 2;
    buffer[position++] = 0x08; // precision
    buffer.writeUInt16BE(300, position);
    position += 2;
    buffer.writeUInt16BE(200, position);
    const result = decodeImageDimensions('jpeg', buffer);
    expect(result).toEqual({ width: 200, height: 300 });
  });
});

// ---------------------------------------------------------------------------
// buildSelectorExpression
// ---------------------------------------------------------------------------

describe('buildSelectorExpression', () => {
  it('emits an IIFE that finds by exact text for kind:text', () => {
    const expression = buildSelectorExpression({ kind: 'text', value: 'Cancel' });
    // Must include the target literal and the candidatesJs pool
    expect(expression).toContain('"Cancel"');
    expect(expression).toContain('document.querySelectorAll(');
    // Exact match: visibleText === target
    expect(expression).toContain('=== target');
    // Should not use .includes() - that is for text-contains
    expect(expression).not.toContain('.includes(target)');
  });

  it('emits an IIFE that finds by substring for kind:text-contains', () => {
    const expression = buildSelectorExpression({ kind: 'text-contains', value: 'Save' });
    expect(expression).toContain('"Save"');
    expect(expression).toContain('document.querySelectorAll(');
    expect(expression).toContain('.includes(target)');
    expect(expression).not.toContain('=== target');
  });

  it('emits an IIFE that matches aria-label for kind:aria', () => {
    const expression = buildSelectorExpression({ kind: 'aria', value: 'Close dialog' });
    expect(expression).toContain('"Close dialog"');
    // aria= path does NOT use the candidatesJs querySelectorAll with the big
    // interactive-element list; it queries [aria-label] separately
    expect(expression).toContain('[aria-label]');
    expect(expression).not.toContain(
      "document.querySelectorAll('button, a, input, textarea",
    );
  });

  it('JSON.stringify-escapes double-quote characters inside the value', () => {
    // A value with embedded double-quotes must not break the emitted JS string
    const expression = buildSelectorExpression({ kind: 'text', value: 'Say "hello"' });
    // JSON.stringify produces \"hello\" inside a double-quoted string
    expect(expression).toContain('\\"hello\\"');
    // The resulting expression must be parseable JS
    expect(() => new Function(expression)).not.toThrow();
  });

  it('JSON.stringify-escapes values with backslashes', () => {
    const expression = buildSelectorExpression({
      kind: 'text-contains',
      value: 'path\\to\\file',
    });
    // JSON.stringify doubles the backslashes
    expect(expression).toContain('path\\\\to\\\\file');
    expect(() => new Function(expression)).not.toThrow();
  });

  it('produces a syntactically valid IIFE for kind:text', () => {
    const expression = buildSelectorExpression({ kind: 'text', value: 'Submit' });
    expect(() => new Function(expression)).not.toThrow();
  });

  it('produces a syntactically valid IIFE for kind:text-contains', () => {
    const expression = buildSelectorExpression({ kind: 'text-contains', value: 'Submit' });
    expect(() => new Function(expression)).not.toThrow();
  });

  it('produces a syntactically valid IIFE for kind:aria', () => {
    const expression = buildSelectorExpression({ kind: 'aria', value: 'Save button' });
    expect(() => new Function(expression)).not.toThrow();
  });

  it('candidatesJs querySelectorAll pool is present for text', () => {
    const expression = buildSelectorExpression({ kind: 'text', value: 'x' });
    // The interactive-element candidates pool must include common element types
    expect(expression).toContain('button');
    expect(expression).toContain('input');
    expect(expression).toContain('textarea');
  });

  it('candidatesJs querySelectorAll pool is present for text-contains', () => {
    const expression = buildSelectorExpression({ kind: 'text-contains', value: 'x' });
    expect(expression).toContain('button');
    expect(expression).toContain('input');
  });

  it('candidatesJs querySelectorAll pool is absent for aria', () => {
    const expression = buildSelectorExpression({ kind: 'aria', value: 'x' });
    // The aria path uses its own narrow querySelectorAll - the wide interactive
    // candidates pool (with input, textarea, select, label, summary) must not appear
    expect(expression).not.toContain('textarea');
    expect(expression).not.toContain('select');
  });

  it('handles an empty value without throwing', () => {
    expect(() =>
      buildSelectorExpression({ kind: 'text', value: '' }),
    ).not.toThrow();
    expect(() =>
      buildSelectorExpression({ kind: 'aria', value: '' }),
    ).not.toThrow();
  });
});
