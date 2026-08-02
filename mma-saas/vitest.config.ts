import { readFileSync, existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

// lib/foundingOfferStripe.test.ts talks to real Stripe test mode, and needs
// STRIPE_SECRET_KEY / the price env vars the way Next supplies them at runtime.
// Vitest doesn't load .env.local the way `next dev` does, so pull it in here
// (this config file runs in Node, before the edge-runtime environment is set
// up). Entirely optional: with no .env.local the vars are simply absent and
// that suite skips itself, which is what CI does. Values already present in
// the real environment win, so CI can inject its own without being overridden.
function envLocal(): Record<string, string> {
  const path = new URL("./.env.local", import.meta.url);
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    if (process.env[m[1]] !== undefined) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

export default defineConfig({
  test: {
    env: envLocal(),
    // Convex functions run on a V8 isolate, not Node — edge-runtime is the
    // closest local match (per Convex's own convex-test docs). lib/** tests
    // run under the same environment; they don't touch any DOM/browser
    // global directly (storage/timers/ids are all dependency-injected), so
    // there's no need for a jsdom-style environment split yet.
    environment: "edge-runtime",
    include: ["convex/**/*.test.ts", "lib/**/*.test.ts"],
  },
});
