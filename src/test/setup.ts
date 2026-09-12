/**
 * Test setup, shared by both environments.
 *
 * Deliberately thin. The smoke tests below stub the API per file rather than
 * globally, because a global stub is a second implementation of the backend
 * that drifts from the real one — and a page passing against a fiction is
 * worse than no test.
 */

// jsdom implements neither, and components that measure or observe layout
// throw on mount without them. Guarded so the node-environment suites, which
// have no window at all, are untouched.
if (typeof window !== 'undefined') {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }

  if (!('ResizeObserver' in window)) {
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }

  if (!('IntersectionObserver' in window)) {
    (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
    };
  }

  // Recharts measures its container; jsdom reports every element as 0×0, so
  // charts render nothing and — worse — some chart code divides by the width.
  // A non-zero box makes them mount.
  Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 1024 });
  Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 768 });
}
