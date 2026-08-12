#!/usr/bin/env node
// Did the thing you just pushed actually go live?
//
// WHY THIS EXISTS. On 2026-08-11 four consecutive Vercel builds failed over six
// hours and nobody noticed. Documents & Waivers was written up as shipped that
// morning; /settings/documents and /kiosk/signup returned 404 on production the
// entire day. Later the same night the kiosk lockdown deployed Convex-side
// while the frontend stayed on a build from before Documents existed, which
// took /checkin down — the deploy-Convex-before-Vercel rule was followed and
// still produced an outage, because "Vercel deploys after a push" was an
// assumption rather than a check.
//
// A PUSH IS NOT A DEPLOY. `git push` succeeding tells you GitHub accepted the
// commit and nothing else. This asks the only question that matters: does the
// route exist on the origin serving customers?
//
//   npm run verify:deploy
//   npm run verify:deploy -- --base https://mma-saas-abc123.vercel.app
//
// Deliberately checks "not 404" rather than "200". Auth-gated pages redirect to
// Clerk (307) and that is a healthy answer — a route that is MISSING is the
// signal, because that is what a stale build looks like. Add a route here the
// same day you add it to the app; a check that lags the features it is meant to
// cover is how six hours passed.

const DEFAULT_BASE = "https://kombatdesk.com";

const ROUTES = [
  { path: "/", note: "homepage" },
  { path: "/pricing", note: "three tiers + founding section" },
  { path: "/terms", note: "carrier cross-checks this" },
  { path: "/privacy", note: "carrier cross-checks this" },
  { path: "/consent/demo", note: "member opt-in — a gym that loses this is dead" },
  { path: "/checkin", note: "check-in kiosk (no token: expects 'Kiosk not configured')" },
  { path: "/kiosk/signup", note: "signup kiosk — shipped 2026-08-11" },
  { path: "/settings/documents", note: "waiver editor — shipped 2026-08-11, auth-gated" },
  { path: "/dashboard", note: "auth-gated, expect a redirect" },
];

const args = process.argv.slice(2);
const baseIdx = args.indexOf("--base");
const base = (baseIdx !== -1 ? args[baseIdx + 1] : DEFAULT_BASE).replace(/\/$/, "");

console.log(`\n  Verifying ${base}\n`);

let failed = 0;
let unreachable = 0;

for (const route of ROUTES) {
  const url = `${base}${route.path}`;
  let line;
  try {
    // redirect: "manual" so a Clerk auth redirect reads as 307 rather than
    // silently following to a sign-in page that returns 200 — which would make
    // a missing route indistinguishable from a protected one.
    const res = await fetch(url, { redirect: "manual", headers: { "User-Agent": "kombatdesk-verify-deploy" } });
    const bad = res.status === 404 || res.status >= 500;
    if (bad) failed++;
    line = `${bad ? "FAIL" : " ok "}  ${String(res.status).padEnd(3)}  ${route.path}`;
    if (bad) line += `\n          ${route.note}`;
  } catch (err) {
    unreachable++;
    line = `  ?   ---  ${route.path}\n          unreachable: ${err.message}`;
  }
  console.log(`  ${line}`);
}

console.log("");

if (failed > 0) {
  console.error(`  ${failed} route${failed === 1 ? "" : "s"} missing or erroring on ${base}.`);
  console.error("");
  console.error("  A 404 on a route you just shipped means the build did not land.");
  console.error("  Check the Vercel deployment log before changing any code — the");
  console.error("  last four times this happened the code was fine and the build");
  console.error("  was red. See claude/typecheck-blind-spot-api-d-ts.md");
  console.error("");
  process.exit(1);
}

if (unreachable > 0) {
  console.error(`  ${unreachable} route${unreachable === 1 ? "" : "s"} unreachable — check the network or the base URL.`);
  console.error("");
  process.exit(1);
}

console.log(`  All ${ROUTES.length} routes live.\n`);
