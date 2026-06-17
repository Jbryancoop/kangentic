import type { StoreStateResult } from '../shared/types';

/**
 * Pure helpers backing the dev-only `kangentic_devtools_store_state` tool.
 *
 * Deliberately import-light (only a type from `../shared/types`) so the
 * path-walk and serialization logic can be unit-tested in node without
 * pulling in the renderer's Zustand store graph. The store registry that
 * binds names to live `getState` hooks lives in `state-mirror.ts`, which
 * passes it to `readStoreStateFrom` here.
 */

const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_ARRAY = 100;

/**
 * Tokenize a dot/bracket access path into keys. Supports `a.b.c`,
 * `a[0].b`, `a['key'].c`, and `a["key"]`. Keys containing a literal `.`
 * are not supported (acceptable for a dev inspection tool).
 */
export function parseStatePath(path: string): string[] {
  if (!path) return [];
  const normalized = path
    .replace(/\[(\d+)\]/g, '.$1')
    .replace(/\["([^"]*)"\]/g, '.$1')
    .replace(/\['([^']*)'\]/g, '.$1');
  return normalized.split('.').filter((token) => token.length > 0);
}

/**
 * Walk `value` along `path`. Resolves plain-object keys, array indices,
 * and `Map` keys. Returns `{ found: false }` (rather than throwing) when
 * any segment is missing so the caller can report a clean error.
 */
export function getByPath(value: unknown, path: string): { found: boolean; value: unknown } {
  const tokens = parseStatePath(path);
  let current: unknown = value;
  for (const token of tokens) {
    if (current === null || current === undefined) return { found: false, value: undefined };
    if (current instanceof Map) {
      if (!current.has(token)) return { found: false, value: undefined };
      current = current.get(token);
      continue;
    }
    if (typeof current !== 'object') return { found: false, value: undefined };
    const record = current as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, token)) return { found: false, value: undefined };
    current = record[token];
  }
  return { found: true, value: current };
}

/**
 * Convert arbitrary store state into a JSON-serializable shape for
 * round-tripping through `Runtime.evaluate`. `Map` becomes an object,
 * `Set` and arrays become arrays (truncated past `maxArray`), functions
 * become `[Function: name]`, and recursion is bounded by `maxDepth`.
 * True cycles are detected via an enter/exit stack so shared-but-acyclic
 * references are still serialized.
 */
export function sanitizeForSerialization(
  value: unknown,
  opts: { maxDepth?: number; maxArray?: number } = {},
): unknown {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxArray = opts.maxArray ?? DEFAULT_MAX_ARRAY;
  const stack = new WeakSet<object>();

  function walk(node: unknown, depth: number): unknown {
    if (node === null) return null;
    const type = typeof node;
    if (type === 'string' || type === 'boolean') return node;
    if (type === 'number') return Number.isFinite(node as number) ? node : String(node);
    if (type === 'bigint') return String(node);
    if (type === 'undefined') return undefined;
    if (type === 'symbol') return (node as symbol).toString();
    if (type === 'function') return `[Function: ${(node as { name?: string }).name || 'anonymous'}]`;

    const objectNode = node as object;
    if (stack.has(objectNode)) return '[Circular]';
    if (depth >= maxDepth) return '[Truncated: max depth]';
    stack.add(objectNode);

    let result: unknown;
    if (node instanceof Map) {
      const out: Record<string, unknown> = {};
      let count = 0;
      for (const [key, mapValue] of node) {
        if (count >= maxArray) {
          out._truncated = `${node.size - maxArray} more entries`;
          break;
        }
        out[String(key)] = walk(mapValue, depth + 1);
        count += 1;
      }
      result = out;
    } else if (node instanceof Set) {
      const items: unknown[] = Array.from(node)
        .slice(0, maxArray)
        .map((item) => walk(item, depth + 1));
      if (node.size > maxArray) items.push(`[Truncated: ${node.size - maxArray} more]`);
      result = items;
    } else if (Array.isArray(node)) {
      const items: unknown[] = node.slice(0, maxArray).map((item) => walk(item, depth + 1));
      if (node.length > maxArray) items.push(`[Truncated: ${node.length - maxArray} more]`);
      result = items;
    } else {
      const record = node as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(record)) {
        const walked = walk(record[key], depth + 1);
        if (walked !== undefined) out[key] = walked;
      }
      result = out;
    }

    stack.delete(objectNode);
    return result;
  }

  return walk(value, 0);
}

/** Minimal shape this module needs from a Zustand store. */
export interface ReadableStore {
  getState: () => unknown;
}

/**
 * Read one store's state (optionally at `path`) from `registry`, returning
 * a sanitized, JSON-safe result. Always echoes the `available` store names
 * so an unknown-store caller can self-correct. Pure: the registry is
 * injected, so this is testable with a fake registry.
 */
export function readStoreStateFrom(
  registry: Record<string, ReadableStore>,
  storeName: string,
  path?: string | null,
): StoreStateResult {
  const available = Object.keys(registry).sort();
  const store = registry[storeName];
  if (!store) {
    return {
      store: storeName,
      path: path ?? null,
      available,
      error: `Unknown store "${storeName}". Registered stores: ${available.join(', ')}.`,
    };
  }
  let state: unknown;
  try {
    state = store.getState();
  } catch (error) {
    return {
      store: storeName,
      path: path ?? null,
      available,
      error: `Failed to read store "${storeName}": ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!path) {
    return { store: storeName, path: null, available, value: sanitizeForSerialization(state) };
  }
  const resolved = getByPath(state, path);
  if (!resolved.found) {
    return { store: storeName, path, available, error: `Path "${path}" not found in store "${storeName}".` };
  }
  return { store: storeName, path, available, value: sanitizeForSerialization(resolved.value) };
}
