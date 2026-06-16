import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

self.MonacoEnvironment = {
  getWorker(_: string, label: string) {
    if (label === 'json') return new jsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  },
};

loader.config({ monaco });

// Dev-only: expose the monaco instance for UI test automation (Playwright
// page.evaluate), e.g. asserting `editor.getModels()` returns to baseline after
// a DiffEditor unmounts (no leaked TextModels). Production builds drop this via
// dead-code elimination (import.meta.env.DEV is false). Mirrors the
// __zustandStores handle in App.tsx. This is a read-only debug handle, not a
// behavior change.
// @ts-expect-error - Vite defines import.meta.env; tsc doesn't support it
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__monaco = monaco;
}
