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
// ---------------------------------------------------------------------------
// TWO THINGS THIS GOT WRONG ON ITS FIRST RUN, both fixed here, both worth
// knowing because they are the ways a checker lies to you.
//
// 1. REDIRECTS WERE COUNTED AS SUCCESS. kombatdesk.com 308s to
//    www.kombatdesk.com, so every single route returned 308 and the script
//    printed "All 9 routes live." without ever reaching the app. A 404 would
//    have looked exactly the same. Redirects are now FOLLOWED and the verdict
//    comes from where you land.
//
// 2. PROTECTED ROUTES CANNOT BE EXISTENCE-CHECKED ANONYMOUSLY. Clerk's
//    middleware runs BEFORE Next resolves the route, so /settings/documents
//    and /settings/total-nonsense both redirect to sign-in for a signed-out
//    caller. Reporting those as "ok" would be a lie. They are now listed as
//    UNVERIFIABLE and excluded from the verdict.
//
// The load-bearing checks are therefore the PUBLIC routes — which is enough:
// /kiosk/signup is public, and it is exactly the route whose 404 proved the
// build was stale.
// ---------------------------------------------------------------------------

const DEFAULT_BASE = "https://kombatdesk.com";

// `public: true` must match middleware.ts's isPublicRoute matcher. If a route
// moves between public and protected there, move it here too — otherwise this
// starts reporting a healthy auth redirect as a failure, or worse, stops
// checking something it used to check.
const ROUTES = [
  { path: "/", public: true, note: "homepage" },
  { path: "/pricing", public: true, note: "three tiers + founding section" },
  { path: "/terms", public: true, note: "carrier cross-checks this" },
  { path: "/privacy", public: true, note: "carrier cross-checks this" },
  { path: "/consent/demo", public: true, note: "member opt-in — a gym that loses this is dead" },
  { path: "/checkin", public: true, note: "check-in kiosk; no token, expect 'Kiosk not configured'" },
  { path: "/kiosk/signup", public: true, note: "signup kiosk — shipped 2026-08-11" },
  { path: "/settings/documents", public: false, note: "waiver editor — shipped 2026-08-11" },
  { path: "/dashboard", public: false, note: "owner home" },
];

// A landing URL that looks like an auth wall rather than the page asked for.
const AUTH_LANDING = /\/sign-in|\/sign-up|accounts\.|clerk\./i;

const args = process.argv.slice(2);
const baseIdx = args.indexOf("--base");
const base = (baseIdx !== -1 ? args[baseIdx + 1] : DEFAULT_BASE).replace(/\/$/, "");

console.log(`\n  Verifying ${base}\n`);

const failures = [];
let unreachable = 0;
let unverifiable = 0;

for (const route of ROUTES) {
  const url = `${base}${route.path}`;
  try {
    // FOLLOW redirects. The apex->www 308 is not information about whether the
    // route exists, and treating it as a pass is what made the first version of
    // this script useless.
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": "kombatdesk-verify-deploy" },
    });

    const landedOnAuth = AUTH_LANDING.test(res.url);
    const redirected = new URL(res.url).pathname !== route.path;
    const missing = res.status === 404 || res.status >= 500;

    let verdict;
    if (missing) {
      verdict = "FAIL";
      failures.push(route);
    } else if (landedOnAuth) {
      // Expected for a protected route, and a real problem for a public one:
      // it means middleware.ts no longer treats it as public.
      if (route.public) {
        verdict = "FAIL";
        failures.push({ ...route, note: `${route.note} — PUBLIC route now behind auth; check middleware.ts` });
      } else {
        verdict = "prot";
        unverifiable++;
      }
    } else {
      verdict = " ok ";
    }

    let line = `${verdict}  ${String(res.status).padEnd(3)}  ${route.path}`;
    if (verdict === "prot") line += "   (auth wall — existence not verifiable signed out)";
    else if (redirected) line += `   -> ${res.url}`;
    if (verdict === "FAIL") line += `\n          ${route.note}`;
    console.log(`  ${line}`);
  } catch (err) {
    unreachable++;
    console.log(`    ?   ---  ${route.path}\n          unreachable: ${err.message}`);
  }
}

console.log("");

if (failures.length) {
  console.error(`  ${failures.length} route${failures.length === 1 ? "" : "s"} missing or erroring on ${base}.`);
  console.error("");
  console.error("  A 404 on a route you just shipped means the build did not land.");
  console.error("  Check the Vercel deployment log before changing any code — the");
  console.error("  last four times this happened the code was fine and the build");
  console.error("  was red. See claude/typecheck-blind-spot-api-d-ts.md");
  console.error("");
  process.exit(1);
}

if (unreachable) {
  console.error(`  ${unreachable} route${unreachable === 1 ? "" : "s"} unreachable — check the network or the base URL.`);
  console.error("");
  process.exit(1);
}

const checked = ROUTES.length - unverifiable;
console.log(`  ${checked} public route${checked === 1 ? "" : "s"} live.`);
if (unverifiable) {
  console.log(
    `  ${unverifiable} protected route${unverifiable === 1 ? "" : "s"} sat behind the auth wall and were NOT verified —`
  );
  console.log("  open those in a signed-in browser if the deploy touched them.");
}
console.log("");
