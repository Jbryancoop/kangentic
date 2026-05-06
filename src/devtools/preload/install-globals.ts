import { installMutationObserver } from './mutation-observer';
import {
  installRenderTracker,
  queryReactComponent,
  reactTree,
  recentRenders,
} from './react-fiber-walker';

/**
 * Installs the dev-only `window.__kangentic*` globals consumed by the
 * inspection bridge through `Runtime.evaluate`. Lives in preload so it
 * runs before any application code and survives even if the renderer's
 * `index.tsx` throws on boot.
 *
 * The Zustand state mirror itself (`window.__kangenticPreviewSnapshot`)
 * is installed by the renderer-side bootstrap (see
 * `src/devtools/renderer/install.tsx`) because it needs access to the
 * Zustand store instances which only exist in the renderer bundle.
 *
 * Idempotent: subsequent calls during HMR are no-ops.
 */
export function installDevtoolsPreloadHooks(): void {
  type DevtoolsWindow = Window & {
    __kangenticPreviewMutations?: (sinceMs: number) => unknown;
    __kangenticPreviewReact?: {
      query: (selector: string) => unknown;
      tree: (rootSelector: string, maxDepth: number) => unknown;
      recentRenders: (limit: number) => unknown;
    };
    __kangenticDevtoolsPreloadInstalled?: boolean;
  };
  const target = window as DevtoolsWindow;
  if (target.__kangenticDevtoolsPreloadInstalled) return;
  target.__kangenticDevtoolsPreloadInstalled = true;

  target.__kangenticPreviewMutations = installMutationObserver();
  installRenderTracker();
  target.__kangenticPreviewReact = {
    query: queryReactComponent,
    tree: reactTree,
    recentRenders,
  };
}
