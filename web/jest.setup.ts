import '@testing-library/jest-dom';

// jsdom has no ResizeObserver; cmdk (command palette) and @tanstack/react-virtual expect it.
// The stub reports a fixed viewport size once on observe() so virtualization produces a
// bounded window of rows in tests (real layout provides this in the browser).
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    private cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
    }
    observe(target: Element): void {
      const contentRect = {
        width: 800,
        height: 600,
        top: 0,
        left: 0,
        right: 800,
        bottom: 600,
        x: 0,
        y: 0,
        toJSON() {},
      } as DOMRectReadOnly;
      this.cb(
        [
          {
            target,
            contentRect,
            borderBoxSize: [{ inlineSize: 800, blockSize: 600 }],
            contentBoxSize: [{ inlineSize: 800, blockSize: 600 }],
            devicePixelContentBoxSize: [{ inlineSize: 800, blockSize: 600 }],
          } as unknown as ResizeObserverEntry,
        ],
        this as unknown as ResizeObserver,
      );
    }
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

// jsdom doesn't implement scrollIntoView; cmdk calls it on the active item. No-op it.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// jsdom has no matchMedia; next-themes (and other libs) expect it. Provide a no-op stub.
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

/**
 * Radix Select needs three DOM APIs jsdom does not implement. Without them the listbox throws the
 * moment it opens, which reads as "the component is broken" rather than "the environment is thin".
 *
 * ⚠️ Added when the Inbox's filters moved off native `<select>` elements — a native dropdown opens an
 * OS-level popup, and choosing from one froze the renderer (see `features/inbox/choice.tsx`).
 */
if (typeof Element !== 'undefined') {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  // Radix scrolls the selected item into view on open; jsdom's stub above may already cover it.
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});
}
