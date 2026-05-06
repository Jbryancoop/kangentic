import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import rendererOptimizeDeps from './scripts/renderer-optimize-deps.json';

export default defineConfig(({ mode }) => ({
  // Build-time constant gating dev-only renderer code (DevtoolsBootstrap,
  // DevToolsSections). `mode === 'production'` happens during `npm run build`,
  // dropping the conditional blocks from the production renderer bundle.
  // The dev path (Vite's dev server, started via scripts/dev.js) sets the
  // same constant inline at createServer time for worktrees, or via this
  // function for non-worktree dev.
  define: {
    __KANGENTIC_DEV__: JSON.stringify(mode !== 'production'),
  },
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      '@shared': '/src/shared',
    },
  },
  server: {
    watch: {
      // Ignore non-renderer directories to prevent unnecessary HMR triggers.
      // .kangentic/ contains worktrees and session data, .claude/ has agent configs,
      // docs/ and tests/ are markdown/test files that don't affect the renderer.
      ignored: ['**/.kangentic/**', '**/.claude/**', '**/.codex/**', '**/.aider/**', '**/.qwen/**', '**/docs/**', '**/tests/**', '**/kangentic.json', '**/kangentic.local.json'],
    },
  },
  optimizeDeps: {
    include: rendererOptimizeDeps,
  },
  build: {
    // Electron loads from disk, so large chunks are not a performance concern.
    // Split xterm into its own chunk to keep the main bundle smaller.
    rolldownOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('@xterm/xterm') || id.includes('@xterm/addon-webgl')) return 'xterm';
          if (id.includes('monaco-editor')) return 'monaco';
        },
      },
    },
    chunkSizeWarningLimit: 3000,
  },
}));
