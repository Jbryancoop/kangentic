/**
 * Build-time constant injected by esbuild (main + preload) and Vite (renderer).
 *
 * `true` in dev builds (`npm start`, `npm run dev`).
 * `false` in production builds (`npm run package`, `npm run make`).
 *
 * Wrap dev-only code in `if (__KANGENTIC_DEV__) { ... }`. Esbuild's dead-code
 * elimination drops both the import statement and the body in production
 * bundles, so anything under `src/devtools/` is unreachable at runtime AND
 * tree-shaken out of the shipped binary.
 *
 * The product diagnostics surface (`src/main/diagnostics/`) is NOT gated by
 * this flag - it ships in all builds.
 */
declare const __KANGENTIC_DEV__: boolean;
