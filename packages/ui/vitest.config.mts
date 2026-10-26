import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Host code (value evaluation) and the shared contract run in Node; the app runs in jsdom with a
// fake API (test/app/setup.ts).
export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'host',
          environment: 'node',
          include: ['test/host/**/*.test.ts', 'test/shared/**/*.test.ts'],
        },
      },
      {
        extends: true,
        plugins: [react()],
        test: {
          name: 'app',
          environment: 'jsdom',
          include: ['test/app/**/*.test.{ts,tsx}'],
          setupFiles: ['test/app/setup.ts'],
        },
      },
    ],
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
