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
    //
    // 30s, not 10, because of WHAT the smoke tests measure. Each one is
    // `expect(() => render(<Page />)).not.toThrow()` — it either passes in a
    // few hundred milliseconds or throws immediately. It can only run long for
    // one reason: the FIRST test in a file pays for transforming that page's
    // whole import tree, and with eight files transforming at once on a busy
    // machine that cold start alone exceeded ten seconds. The two suites then
    // failed on their first page while all forty-one passed in isolation.
    //
    // Raising this does not let a hung component through: nothing here awaits a
    // timer or a network call, so a genuine hang still fails — just later.
    testTimeout: 30_000,
  },
});
