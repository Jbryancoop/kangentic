/**
 * In-renderer DOM mutation ring buffer. Installed on
 * `window.__kangenticPreviewMutations` so the inspection server can
 * read it via `Runtime.evaluate`. Captures the last few seconds of
 * mutations so an agent can answer "what changed when I clicked X?".
 *
 * Each entry: `{ ts, target, kind, addedNodes, removedNodes, attributeName }`.
 * Targets are reported as best-effort selectors (id/data-testid/tag) to
 * keep the response readable without leaking sensitive text content.
 */

interface MutationEntry {
  ts: number;
  target: string;
  kind: 'attributes' | 'characterData' | 'childList';
  addedNodes: number;
  removedNodes: number;
  attributeName: string | null;
}

const RING_SIZE = 1000;

export interface MutationApi {
  /** Returns mutations newer than `Date.now() - sinceMs`. */
  (sinceMs: number): MutationEntry[];
}

export function installMutationObserver(): MutationApi {
  const ring: MutationEntry[] = [];

  const observer = new MutationObserver((records) => {
    const ts = Date.now();
    for (const record of records) {
      ring.push({
        ts,
        target: describeNode(record.target),
        kind: record.type,
        addedNodes: record.addedNodes.length,
        removedNodes: record.removedNodes.length,
        attributeName: record.attributeName,
      });
      if (ring.length > RING_SIZE) ring.shift();
    }
  });

  // Defer until the body is available - preload runs before the renderer
  // mounts, so document.body may be null at first.
  const start = (): void => {
    if (!document.body) return;
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: false,
    });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

  const api: MutationApi = (sinceMs: number) => {
    const cutoff = Date.now() - Math.max(0, sinceMs);
    return ring.filter((entry) => entry.ts >= cutoff);
  };
  return api;
}

function describeNode(node: Node): string {
  if (node instanceof Element) {
    if (node.id) return `#${node.id}`;
    const testId = node.getAttribute('data-testid');
    if (testId) return `[data-testid="${testId}"]`;
    return node.tagName.toLowerCase();
  }
  if (node.nodeType === Node.TEXT_NODE) return '#text';
  return node.nodeName.toLowerCase();
}
