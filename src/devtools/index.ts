/**
 * Public surface of the dev-only inspection-bridge subsystem. External
 * consumers (the seven product hook lines that gate `__KANGENTIC_DEV__`)
 * import only what's re-exported here. Internal modules under
 * `src/devtools/main/`, `preload/`, `renderer/`, `mcp/`, `shared/` are
 * implementation details.
 *
 * Production builds drop the entire `src/devtools/` tree via esbuild
 * dead-code elimination behind `if (__KANGENTIC_DEV__) { ... }` guards.
 */

export { installDevtools, notifyDevtoolsRefresh } from './install';
export type { DevtoolsContext } from './install';
