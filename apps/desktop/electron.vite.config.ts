import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

/** The dev server injects <style> tags (HMR), so only the dev page allows inline styles. */
function devInlineStyles(): Plugin {
  return {
    name: 'dev-inline-styles-csp',
    apply: 'serve',
    transformIndexHtml: (html) => html.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'"),
  };
}

// Everything (including @custom-overlay/core) is bundled, except what cannot be: the native Skia
// canvas and the ffmpeg executable used by exports, shipped as dependencies (see package.json).
const NATIVE = ['@napi-rs/canvas', 'ffmpeg-static'];

/**
 * Pre-bundled together on purpose: when the dev server discovers them on its own, it emits React
 * twice (one copy for react-dom/client and zustand, another for react and the JSX runtime), hooks
 * then run against a React with no renderer ("Invalid hook call") and the window stays blank.
 */
const REACT_DEPS = [
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'zustand',
];

export default defineConfig({
  main: {
    build: { externalizeDeps: { include: NATIVE }, rollupOptions: { external: NATIVE } },
  },
  preload: {
    build: { externalizeDeps: false },
  },
  renderer: {
    plugins: [react(), devInlineStyles()],
    optimizeDeps: { include: REACT_DEPS },
  },
});
