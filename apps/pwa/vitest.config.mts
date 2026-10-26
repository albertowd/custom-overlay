import { defineConfig } from 'vitest/config';

// The page side (web API, files, export driver) runs in jsdom; the workers' code runs in Node,
// which has what a worker scope has (MessageChannel, fetch, Blob, File); build helpers too.
export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: { name: 'page', environment: 'jsdom', include: ['test/page/**/*.test.ts'] },
      },
      {
        extends: true,
        test: { name: 'workers', environment: 'node', include: ['test/workers/**/*.test.ts'] },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
      // Paths relative to the repository root so SonarQube can resolve them.
      reporter: ['text', ['lcov', { projectRoot: '../..' }]],
      reportsDirectory: 'coverage',
    },
  },
});
