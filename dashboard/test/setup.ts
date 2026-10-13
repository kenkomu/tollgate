import {cleanup} from "@testing-library/react";
import {afterEach, expect, vi} from "vitest";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// Every form refreshes the route after a write. There is no router in a unit test.
vi.mock("next/navigation", () => ({
  useRouter: () => ({refresh: vi.fn(), push: vi.fn()}),
}));

// The two DOM matchers these tests need, without pulling in jest-dom for them.
expect.extend({
  toBeDisabled(element: HTMLButtonElement) {
    return {pass: element.disabled, message: () => `expected ${element.outerHTML} to be disabled`};
  },
  toBeEnabled(element: HTMLButtonElement) {
    return {pass: !element.disabled, message: () => `expected ${element.outerHTML} to be enabled`};
  },
});

declare module "vitest" {
  interface Assertion {
    toBeDisabled(): void;
    toBeEnabled(): void;
  }
}
