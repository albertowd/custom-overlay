import { defineConfig } from 'vitest/config';

// The main process and preload run in Node with `electron` mocked. The user interface and its
// tests live in packages/ui.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/main/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts'],
      // Paths relative to the repository root so SonarQube can resolve them.
      reporter: ['text', ['lcov', { projectRoot: '../..' }]],
      reportsDirectory: 'coverage',
    },
  },
});
