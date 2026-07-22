import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Convex functions run on a V8 isolate, not Node — edge-runtime is the
    // closest local match (per Convex's own convex-test docs). lib/** tests
    // run under the same environment; they don't touch any DOM/browser
    // global directly (storage/timers/ids are all dependency-injected), so
    // there's no need for a jsdom-style environment split yet.
    environment: "edge-runtime",
    include: ["convex/**/*.test.ts", "lib/**/*.test.ts"],
  },
});
