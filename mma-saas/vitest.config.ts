import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Convex functions run on a V8 isolate, not Node — edge-runtime is the
    // closest local match (per Convex's own convex-test docs). Only
    // convex/*.test.ts exist today; add environmentMatchGlobs/projects here
    // if frontend tests are ever added alongside these.
    environment: "edge-runtime",
    include: ["convex/**/*.test.ts"],
  },
});
