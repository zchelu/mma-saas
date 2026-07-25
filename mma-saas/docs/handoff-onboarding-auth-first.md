# KombatDesk — Handoff: Auth-First Onboarding Flow

**Last updated:** 2026-07-23
**Lane:** Claude Code terminal session (this document's author). A separate parallel
session owns check-in/offline-queue/CSV-import work — see `docs/handoff.md` for
that lane, not this one. Do not merge these two documents.

## The goal we're working toward

Convert signup from pay-first/guest-checkout to auth-first (decided prior to this
session, implemented in commit `535ca57`):

```
pricing CTA → /sign-up?plan=X → /onboarding (gym info [→ SMS consent if Pro/Elite])
  → Stripe Checkout → /dashboard?checkout=success
```

Within *this* session specifically, the work has been: fix a real bug in that flow
(checkout could be permanently bypassed), cut the wizard from 3 steps to 2 (product
decision — remove the "add members" step), gate SMS consent by plan, add a legally
required auto-renewal disclosure, and — most urgently — diagnose why the live site
is currently broken for every signup.

## Current state of the code

**Repo root (git):** `C:\Users\zainc\mma-saas` — **App root (package.json, convex/,
.env.local):** `C:\Users\zainc\mma-saas\mma-saas` (nested folder, same name as
parent, confirmed not a rename/mistake — it is genuinely one level deeper than the
git root). All commands below assume you're in the nested app folder.

### Commits made this session, in order, all on `master`:

1. `1525fe7` — Fixed the real bug: `convex/onboarding.ts:completeOnboarding` used to
   write `onboardingCompleted: true` + a fake `plan: "starter"`/`planStatus:
   "inactive"` **before** Stripe Checkout ever ran. An abandoned/failed checkout
   permanently stranded the gym on a fake unpurchased plan, and
   `app/onboarding/page.tsx`'s redirect guard sent anyone with `onboardingCompleted`
   truthy straight to `/dashboard` with no `planStatus` check. Fix: `onboardingCompleted`
   is now only ever set `true` by `convex/subscriptions.ts:upsertSubscription` — the
   mutation the Stripe webhook actually calls once a real subscription exists. The
   onboarding-page guard now also requires `planStatus` in `("active", "trialing")`.
2. `9db37b2` — Product decision: cut the wizard from 3 steps to 2. Removed the
   "add members" step entirely (CSV parser, roster UI, all of it) from
   `onboarding-wizard.tsx` and its args from `convex/onboarding.ts:completeOnboarding`.
   Added a first-run "Add your first members" card to `app/dashboard/page.tsx`,
   shown when active member count is 0 and plan is active/trialing (reuses the
   existing `members.getActiveCount` query — didn't add a new one).
3. `28eceef` — Gated the SMS-consent step on plan: Starter skips it entirely
   (`plan === "starter"` → wizard is effectively 1 step: gym info → straight to
   `handleFinish`); Pro/Elite keep it as a required second step. `StepHeader` now
   takes an explicit `labels` array instead of a hardcoded 2-item list so Starter's
   progress indicator doesn't show a phantom second step.
4. `227e299` — Added the Colorado Automatic Renewal Law (C.R.S. 6-1-732) disclosure,
   rendered directly above both final "Continue to payment" buttons (Starter's
   step-0 button, Pro/Elite's step-1 button — not in a modal/footer/section). Copy:
   *"14-day free trial, then $X/month, billed monthly. Cancel anytime before your
   trial ends to avoid being charged."* Created `lib/plans.ts` (`PLAN_PRICE_USD`) as
   the first-ever shared pricing constant in this codebase — `pricing-cards.tsx` had
   no shared source before this; it hardcoded `$49`/`$89`/`$149` as plain string
   literals in 5 separate spots, refactored to reference the new constant instead of
   adding a 6th hardcoded copy.

### Push status

`1525fe7`, `9db37b2`, and `28eceef` are pushed to `origin/master`. **`227e299` is
committed locally but NOT pushed** — was holding for confirmation, same as the
Convex prod deploy below. Vercel auto-deploys from `origin/master` on push, so the
disclosure fix isn't live yet either.

### Convex deployment status — THE URGENT PART

- **Dev** (`polished-peacock-100`, what `.env.local`'s `CONVEX_DEPLOYMENT` points at):
  up to date. Pushed via `npx convex dev --once` after commits 1 and 2 above (no
  Convex function changes in commits 3/4, so nothing further to push there).
- **Production** (`limitless-raven-596`, what `www.kombatdesk.com` actually talks
  to): **critically stale — missing the entire `convex/onboarding.ts` module.**
  Confirmed directly via `npx convex function-spec --prod`: there is no
  `onboarding.js:completeOnboarding` function registered on prod at all, not even
  an old/mismatched version — the module doesn't exist there. This means prod has
  never received a Convex deploy since *before* `535ca57` (the original auth-first
  commit that created `convex/onboarding.ts` in the first place) — this predates
  everything in this session.
  **Live user-facing impact, confirmed via real browser test on
  www.kombatdesk.com:** every signup on both `plan=starter` and `plan=pro` fails on
  "Continue to payment" with `[CONVEX M(onboarding:completeOnboarding)] ... Server
  Error Called by client` — the client calls a function that doesn't exist on the
  backend it's actually talking to. **The site is currently broken for all new
  signups.**
- `npx convex deploy` (run from `C:\Users\zainc\mma-saas\mma-saas`) has **never been
  run** in this session or, as far as the evidence shows, possibly ever for this
  project. Every deploy so far has only ever targeted dev via `npx convex dev --once`.

## Files actively being edited this session

- `convex/onboarding.ts`
- `convex/subscriptions.ts`
- `app/onboarding/page.tsx`
- `app/onboarding/onboarding-wizard.tsx`
- `app/dashboard/page.tsx`
- `app/components/pricing-cards.tsx`
- `lib/plans.ts` (new)

**Not mine, explicitly flagged, untouched all session:** `app/checkin/page.tsx`,
`convex/members.ts`, `lib/checkInQueue.ts`, `lib/checkInCaller.ts`,
`scripts/seed-demo-gym.js`, `convex/seedDemoGym.ts`, `package.json`/
`package-lock.json`. Also noticed `convex/_generated/api.d.ts` drifting (a
`seedDemoGym` import appearing/disappearing) — that's downstream of the
not-mine `convex/seedDemoGym.ts`, left unstaged, not committed, not investigated
further since it's outside this lane.

## Everything tried and failed (or turned out to be a dead end)

- **"Stale route manifest" theory** (from an earlier handoff, before this session):
  `/onboarding` and `/dashboard` 404'd under `curl` after adding new routes,
  originally attributed to Next's file-watcher missing new route segments. **Wrong
  diagnosis.** Root cause was Clerk's dev-instance "dev browser JWT" handshake:
  protected routes (`auth.protect()` in `middleware.ts`) get an internal middleware
  rewrite to a synthetic `/clerk_<timestamp>` path that only resolves via client-side
  JS in a real browser — `curl` can't execute JS, so it always dead-ends there
  regardless of whether the route actually works. Confirmed by driving a real
  headless Chromium via Playwright instead: both routes resolved correctly
  (200, redirected to `/sign-in`, zero console errors). No code fix was needed for
  this — it was a testing-methodology dead end, not a bug.
- **Deploying to Convex prod** — not attempted yet at all (see above), which is
  itself the finding, not a failed attempt.
- **`npx convex logs --prod`** — attempted to pull historical error logs to get the
  exact prod exception text; this command is a live tail, not a history query, and
  returned nothing on a passive check. Had to rely on `npx convex function-spec
  --prod` (a diff against what functions actually exist) instead, which turned out
  to be stronger evidence anyway — direct proof the function is missing, not an
  inference from a log line.
- **`git commit -m` with an inline multi-line here-string containing embedded
  double quotes** broke PowerShell's argument-passing to `git.exe` twice this
  session (git received the message word-split into dozens of invalid pathspec
  arguments). Workaround: write the commit message to a temp file and use
  `git commit -F <path>`. Worth remembering for future commits in this
  PowerShell/Windows environment specifically.
- **Two JSX interpolation bugs I introduced and caught before committing**: wrote
  `${price}`/`${PLAN_PRICE_USD.pro}` etc. as literal JSX text content instead of
  wrapping in a template-literal expression container (`` {`...${x}...`} ``) — this
  renders the literal string `${price}` instead of interpolating. Happened twice
  (once in `onboarding-wizard.tsx`'s `RenewalDisclosure`, once in `pricing-cards.tsx`'s
  Pro/Elite price displays and CTA labels) — caught by reading the file back before
  running tsc/eslint (neither tool catches this, since `${x}` in JSX text is
  syntactically valid, just semantically wrong).
- **Stripe post-purchase receipt sufficiency (Colorado law's separate
  written-acknowledgment requirement)** — investigated but left unresolved. Code
  review confirmed `app/api/stripe/checkout/route.ts` uses pure Stripe defaults, no
  custom `receipt_email`/messaging. Whether Stripe's default trial-subscription
  emails (which, per Stripe's documented behavior, likely only fire close to trial
  end, not at signup) satisfy the "acknowledgment at time of transaction"
  requirement could not be confirmed — that requires checking Stripe Dashboard →
  Settings → Customer emails toggles and/or watching a real test-mode signup's
  inbox, neither of which is reachable from this CLI session. Flagged to Zain,
  not resolved.

## Next step

1. **Deploy to Convex production** — the actual live-site-breaking issue. From
   `C:\Users\zainc\mma-saas\mma-saas`, run `npx convex deploy` (confirm it targets
   `limitless-raven-596` — it should show/prompt the deployment name). This is a
   manual step Zain runs himself interactively, not something to automate blindly
   into this thread.
2. **Push `227e299`** to `origin/master` so Vercel picks up the disclosure fix and
   the 2-step wizard changes (already pushed) plus the disclosure (not yet pushed).
3. **Re-run the live click-through test** on www.kombatdesk.com end-to-end — this
   has never actually been completed successfully in this whole thread. Both plan
   paths (Starter's 1-step, Pro/Elite's 2-step) need a real signup → checkout →
   dashboard pass once prod is deployed.
4. Resolve the open Stripe-receipt compliance question above — Zain to check the
   Dashboard toggles and report back what a real signup's inbox actually shows.
5. Once verified live: this unblocks first-customer outreach, same as noted in the
   earlier auth-first handoff this one supersedes for the onboarding-specific slice.
