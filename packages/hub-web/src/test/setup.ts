import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// Lazy routes and dialogs can take more than the default 1s to render on a cold
// Windows worker under a parallel run. Allow longer for elements to appear; the
// assertions themselves are unchanged.
configure({ asyncUtilTimeout: 5_000 });

afterEach(() => {
  cleanup();
});

// jsdom's Request rejects React Router 7 navigation AbortSignals as the wrong realm.
const NativeRequest = globalThis.Request;
globalThis.Request = class Request extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    if (!init?.signal) {
      super(input, init);
      return;
    }
    const { signal: _signal, ...rest } = init;
    super(input, rest);
  }
} as typeof Request;

Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }),
});
