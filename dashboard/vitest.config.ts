import {defineConfig} from "vitest/config";

/**
 * Component tests only. The pure `lib/` tests stay on `node --test`, which needs no
 * bundler; JSX does, so the forms run here, in a simulated DOM.
 */
export default defineConfig({
  esbuild: {jsx: "automatic"},
  test: {
    environment: "happy-dom",
    include: ["test/**/*.test.tsx"],
    setupFiles: ["test/setup.ts"],
  },
});
