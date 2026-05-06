import * as path from 'node:path';

/**
 * Resolver function consulted by `SessionTelemetry`'s `debugDumpDir` option.
 * Returns the directory where `ActivitySnapshotWriter` writes per-session
 * JSON snapshots, or `undefined` to disable the dump for the current state.
 *
 * Resolution order:
 *   1. If `developer.activityDebugOverlay` is on AND a project is open,
 *      return `<projectRoot>/.kangentic/debug/`. This is the dev-loop
 *      path: dumps live alongside other per-project diagnostic output.
 *   2. Otherwise, fall back to the existing `KANGENTIC_DATA_DIR` env-based
 *      path that production installs already set. This preserves the
 *      pre-rewire behavior so packaged releases still get post-mortem dumps.
 *   3. Otherwise, return `undefined` (no dump).
 *
 * The resolver is configured once at startup via `configureDebugDumpResolver`
 * and called by `SessionTelemetry` on every snapshot write attempt. Because
 * the toggle and project root are looked up via callbacks, flipping the
 * setting at runtime updates the dump destination live (no restart).
 */

interface ResolverConfig {
  getProjectRoot: () => string | null;
  getActivityDebugOverlayEnabled: () => boolean;
}

let configured: ResolverConfig | null = null;

export function configureDebugDumpResolver(config: ResolverConfig): void {
  configured = config;
}

export function resolveDebugDumpDir(): string | undefined {
  if (configured) {
    if (configured.getActivityDebugOverlayEnabled()) {
      const root = configured.getProjectRoot();
      if (root) {
        return path.join(root, '.kangentic', 'debug');
      }
    }
  }
  if (process.env.KANGENTIC_DATA_DIR) {
    return path.resolve(process.env.KANGENTIC_DATA_DIR, '..', 'debug');
  }
  return undefined;
}
