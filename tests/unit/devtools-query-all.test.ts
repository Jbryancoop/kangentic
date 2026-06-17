/**
 * Unit tests for `buildSelectorAllExpression` in src/devtools/main/cdp.ts.
 *
 * The function builds the JavaScript expression that the inspection
 * server evaluates (once, via Runtime.evaluate) to measure EVERY element
 * matching a selector. Two concerns are covered:
 *
 *   - Structure: the right collection strategy per selector kind (CSS
 *     querySelectorAll vs. the text/aria candidate-pool loops) and the
 *     opts flags (includeHtml / includeAttributes / limit / htmlMaxChars)
 *     embedded correctly.
 *   - Behavior: the generated CSS-path expression actually returns the
 *     expected shape (box, attributes, truncation) when run against a
 *     fake `document`, and stays syntactically valid for quote-bearing
 *     selectors (proving the target literal is JSON-escaped).
 *
 * Mocks `electron` defensively to match the sibling cdp test, even though
 * cdp.ts imports only types from it.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '0.0.0') },
}));

import { buildSelectorAllExpression, parseSelectorSpec } from '../../src/devtools/main/cdp';

const DEFAULT_OPTS = { includeHtml: false, includeAttributes: true, limit: 100, htmlMaxChars: 1024 };

interface FakeRect {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}

function fakeElement(
  tag: string,
  attributes: Record<string, string>,
  rect: FakeRect,
  outerHTML: string,
): unknown {
  return {
    tagName: tag.toUpperCase(),
    attributes: Object.entries(attributes).map(([name, value]) => ({ name, value })),
    getBoundingClientRect: () => rect,
    outerHTML,
    innerText: '',
    textContent: '',
    getAttribute: (name: string) => attributes[name] ?? null,
  };
}

function rectAt(x: number, y: number, width: number, height: number): FakeRect {
  return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height };
}

/** Evaluate a generated expression against a fake document and return its result. */
function runExpression(expression: string, elements: unknown[]): {
  selector: string;
  kind: string;
  total: number;
  returned: number;
  truncated: boolean;
  elements: Array<{ index: number; tag: string; box: FakeRect; attributes?: Record<string, string>; outerHTML?: string; outerHTMLTruncated?: boolean }>;
} {
  const fakeDocument = { querySelectorAll: () => elements };
  const factory = new Function('document', `return ${expression};`);
  return factory(fakeDocument);
}

describe('buildSelectorAllExpression', () => {
  describe('structure per selector kind', () => {
    it('CSS selectors collect via document.querySelectorAll(target)', () => {
      const expression = buildSelectorAllExpression(parseSelectorSpec('.card'), DEFAULT_OPTS);
      expect(expression).toContain('document.querySelectorAll(target)');
      expect(expression).toContain('kind: "css"');
    });

    it('text= uses the candidate pool with an exact-match comparison', () => {
      const expression = buildSelectorAllExpression(parseSelectorSpec('text=Save'), DEFAULT_OPTS);
      expect(expression).toContain('visibleText === target');
      expect(expression).toContain('[aria-label]');
      expect(expression).toContain('kind: "text"');
    });

    it('text*= uses a substring comparison', () => {
      const expression = buildSelectorAllExpression(parseSelectorSpec('text*=Sav'), DEFAULT_OPTS);
      expect(expression).toContain('visibleText.includes(target)');
      expect(expression).toContain('kind: "text-contains"');
    });

    it('aria= dedupes matches via a Set', () => {
      const expression = buildSelectorAllExpression(parseSelectorSpec('aria=Close'), DEFAULT_OPTS);
      expect(expression).toContain('new Set()');
      expect(expression).toContain('kind: "aria"');
    });
  });

  describe('opts flags are embedded', () => {
    it('reflects includeHtml / includeAttributes / limit / htmlMaxChars', () => {
      const expression = buildSelectorAllExpression(parseSelectorSpec('.x'), {
        includeHtml: true,
        includeAttributes: false,
        limit: 7,
        htmlMaxChars: 42,
      });
      expect(expression).toContain('INCLUDE_HTML = true');
      expect(expression).toContain('INCLUDE_ATTRS = false');
      expect(expression).toContain('LIMIT = 7');
      expect(expression).toContain('HTML_MAX = 42');
    });
  });

  describe('quote-bearing selectors stay valid', () => {
    it('JSON-escapes the target literal so the expression parses', () => {
      const expression = buildSelectorAllExpression(parseSelectorSpec('button[title="a b"]'), DEFAULT_OPTS);
      // Constructing the Function throws on a malformed literal; a clean
      // construction proves the embedded selector was escaped correctly.
      expect(() => new Function('document', `return ${expression};`)).not.toThrow();
    });

    it('JSON-escapes quote-bearing text= and aria= targets', () => {
      // text= and aria= values also go through JSON.stringify(spec.value), so
      // adversarial quotes must not break the generated expression.
      const textExpression = buildSelectorAllExpression(parseSelectorSpec('text=Say "hello"'), DEFAULT_OPTS);
      expect(() => new Function('document', `return ${textExpression};`)).not.toThrow();
      const ariaExpression = buildSelectorAllExpression(parseSelectorSpec('aria=Close "dialog"'), DEFAULT_OPTS);
      expect(() => new Function('document', `return ${ariaExpression};`)).not.toThrow();
    });
  });

  describe('behavior against a fake DOM (CSS path)', () => {
    it('measures every element with tag + attributes + box', () => {
      const expression = buildSelectorAllExpression(parseSelectorSpec('.card'), DEFAULT_OPTS);
      const result = runExpression(expression, [
        fakeElement('div', { 'data-id': '1' }, rectAt(10, 20, 100, 40), '<div></div>'),
        fakeElement('div', { 'data-id': '2' }, rectAt(120, 20, 100, 40), '<div></div>'),
      ]);
      expect(result.total).toBe(2);
      expect(result.returned).toBe(2);
      expect(result.truncated).toBe(false);
      expect(result.elements[0]).toMatchObject({
        index: 0,
        tag: 'div',
        attributes: { 'data-id': '1' },
        box: { x: 10, y: 20, width: 100, height: 40, right: 110, bottom: 60 },
      });
      expect(result.elements[1].box.x).toBe(120);
    });

    it('caps at limit and reports truncation', () => {
      const expression = buildSelectorAllExpression(parseSelectorSpec('.card'), { ...DEFAULT_OPTS, limit: 2 });
      const result = runExpression(expression, [
        fakeElement('span', {}, rectAt(0, 0, 1, 1), '<span></span>'),
        fakeElement('span', {}, rectAt(0, 0, 1, 1), '<span></span>'),
        fakeElement('span', {}, rectAt(0, 0, 1, 1), '<span></span>'),
      ]);
      expect(result.total).toBe(3);
      expect(result.returned).toBe(2);
      expect(result.truncated).toBe(true);
    });

    it('omits attributes when includeAttributes is false', () => {
      const expression = buildSelectorAllExpression(parseSelectorSpec('.card'), {
        ...DEFAULT_OPTS,
        includeAttributes: false,
      });
      const result = runExpression(expression, [fakeElement('div', { a: 'b' }, rectAt(0, 0, 1, 1), '<div></div>')]);
      expect(result.elements[0].attributes).toBeUndefined();
    });

    it('includes and truncates outerHTML when includeHtml is true', () => {
      const expression = buildSelectorAllExpression(parseSelectorSpec('.card'), {
        ...DEFAULT_OPTS,
        includeHtml: true,
        htmlMaxChars: 5,
      });
      const result = runExpression(expression, [
        fakeElement('div', {}, rectAt(0, 0, 1, 1), '<div>1234567890</div>'),
      ]);
      expect(result.elements[0].outerHTML).toBe('<div>');
      expect(result.elements[0].outerHTMLTruncated).toBe(true);
    });
  });
});
