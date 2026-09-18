import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';

// React Testing Library doesn't auto-unmount between tests unless vitest's own `globals: true` is
// set (this repo deliberately keeps explicit `import { describe, it, expect } from 'vitest'`
// instead) — without this, a later test's `render()` finds the previous test's still-mounted DOM
// still in `document.body`, corrupting queries like `getByText` with duplicate matches.
afterEach(() => cleanup());

// Runs for every test file in the whole monorepo (one shared vitest.config.ts, see its own doc
// comment) — guarded since only files under renderer/ actually run in a jsdom environment with a
// real `window` to patch. Radix UI's own pointer/scroll/resize-observer usage has no jsdom
// implementation at all; without these, its Select/Dialog components throw mid-interaction
// (`hasPointerCapture is not a function`, `ResizeObserver is not defined`, etc.) — a well-known
// gap, not a bug in this app's own code.
if (typeof window !== 'undefined') {
  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }

  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }

  if (!window.matchMedia) {
    window.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
  }
}
