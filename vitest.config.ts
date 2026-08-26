import { defineConfig } from 'vitest/config';

/**
 * Two test environments, chosen per file rather than globally.
 *
 * The pure-logic suites (scoring, formatting, masking, pipeline resolution) run
 * in `node`, which starts in milliseconds. Only the files under
 * `src/pages/__smoke__` need a DOM, and jsdom costs real time to construct — so
 * it is scoped to them by path instead of imposed on everything.
 */
export default defineConfig({
  test: {
    environmentMatchGlobs: [
      ['src/pages/__smoke__/**', 'jsdom'],
    ],
    environment: 'node',
    setupFiles: ['./src/test/setup.ts'],
    // A component that hangs is a failure, not a reason to wait.
    testTimeout: 10_000,
  },
});
