import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const PUBLIC_DIR = join(import.meta.dirname, 'public');
const SERVICE_WORKER = join(import.meta.dirname, 'src', 'service-worker.js');

/** The dev server injects <style> tags (HMR), so only the dev page allows inline styles. */
function devInlineStyles(): Plugin {
  return {
    name: 'dev-inline-styles-csp',
    apply: 'serve',
    transformIndexHtml: (html) => html.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'"),
  };
}

function publicFiles(dir = PUBLIC_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? publicFiles(path) : [relative(PUBLIC_DIR, path).split('\\').join('/')];
  });
}

/**
 * Emits `sw.js`, which precaches every file of the build so the app opens offline. Its version is a
 * hash of the files: any change makes the browser install the new worker.
 */
export function serviceWorker(): Plugin {
  return {
    name: 'custom-overlay-service-worker',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const hash = createHash('sha256');
      const files: string[] = [];
      for (const [fileName, output] of Object.entries(bundle)) {
        if (fileName.endsWith('.map')) continue;
        files.push(fileName);
        hash.update(fileName).update(output.type === 'chunk' ? output.code : output.source);
      }
      for (const fileName of publicFiles()) {
        files.push(fileName);
        hash.update(fileName).update(readFileSync(join(PUBLIC_DIR, fileName)));
      }
      const source = readFileSync(SERVICE_WORKER, 'utf8')
        .replace('__VERSION__', JSON.stringify(hash.digest('hex').slice(0, 16)))
        .replace('__PRECACHE__', JSON.stringify(['./', ...files.sort((a, b) => a.localeCompare(b))]));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  // Relative URLs: the app can be served from any folder (e.g. GitHub Pages' /custom-overlay/).
  base: './',
  plugins: [react(), devInlineStyles(), serviceWorker()],
  worker: { format: 'es' },
});
