KOMBATDESK — MASTER STATUS BRIEFING (paste into any session to sync)

PROJECT
Gym-management SaaS for MMA/BJJ gym owners. Next.js + Convex + Clerk +
Stripe. Repo: zchelu/mma-saas on GitHub, branch master. Local path:
C:\Users\zainc\mma-saas\mma-saas — NOTE: the actual git repo root is
one level up, at C:\Users\zainc\mma-saas. The Next.js app lives in the
mma-saas subdirectory. Matters for any deployment/path config.

MULTIPLE CLAUDE SESSIONS ARE ACTIVE ON THIS PROJECT RIGHT NOW — at
least this terminal session, a browser extension session, and
"business Claude." At least two have local filesystem/git write
access to the same repo simultaneously. Before taking any action that
touches deployment, domains, or pushes to master: check with Zain
whether another session already owns that lane. Two sessions already
independently found and nearly duplicate-fixed the same bug today
(Twilio build break) — one beat the other to it. Don't assume a
"status unknown" note means work hasn't happened; check git log first.

====================================================================
DONE — verified, not hypothetical
====================================================================

1. MULTI-TENANCY / DATA ISOLATION — commit c041150 (pushed to
   origin/master). The members table had zero gym-scoping — any gym
   owner could see every gym's members, and the "is this gym Pro"
   check queried whether ANY gym anywhere was Pro, not the specific
   calling gym. Fixed: gymId field + by_gym index on members, every
   query/mutation in members.ts scoped via a requireGym() auth
   helper, ownership re-checked on update/remove/checkIn (not just
   filtered on list), and the Pro-check replaced with per-gym
   isProPlan/getGymById/listProGyms. Verified LIVE, not just
   type-checked: two real separate test gyms confirmed zero data
   leakage in either direction, a direct ID-guessing attack on
   update/checkIn was confirmed blocked, and a Starter-plan gym was
   confirmed excluded from Pro features even with other real Pro gyms
   in the same database (the exact original bug, proven fixed).

   Also fixed in this same commit: middleware.ts was silently
   redirecting every unauthenticated /checkin (the kiosk check-in
   page) visitor to /sign-in — real gym members could not check in at
   all. Unrelated bug, found while testing, fixed alongside.

2. AUTO-PROVISIONING — commit c69ae56 (pushed). New gym owners no
   longer need a manual backfill step. subscriptions.getOrCreateGym
   runs on first authenticated dashboard load, creates a
   plan:"starter"/planStatus:"inactive" gyms row if one doesn't
   exist. Verified LIVE with a real second Clerk signup + a real
   Stripe test-mode Pro purchase: confirmed the auto-created row and
   the Stripe webhook activation patch the SAME document (matching
   _id/_creationTime), no duplicate.

3. TWILIO BUILD-BREAK FIX — commit 93166f6 (pushed, authored by
   another session, verified correct by this one). lib/twilio.ts
   validated env vars at module load time, crashing the entire Vercel
   build during page-data collection. The route that imported it
   (/api/test-sms) was also a standalone production risk — an
   unauthenticated GET endpoint that sent a real SMS to a hardcoded
   number, callable by anyone. Both files deleted, twilio npm
   dependency removed (confirmed unused elsewhere — the real
   retention-text feature calls Twilio's REST API directly via fetch,
   not through this package).

4. STRIPE BILLING — built and tested end-to-end in sandbox previously
   (checkout, webhook handling for subscription lifecycle + invoice
   events, /billing page, Customer Portal). Live-mode Stripe account
   now active: business verified, 3 live Products/Prices created,
   live Customer Portal configured.

5. GYM-SCOPING EXPANDED TO EVERY TABLE + IDOR FIX + RETENTION-TIER
   REWORK — uncommitted as of this update, ready to push. Extends the
   #1 fix to classes.ts/invoices.ts/attendance.ts/enrollments.ts (the
   "dormant" gap #1 originally flagged) via a shared requireOwnClass/
   requireOwnMember helper in convex/gyms.ts. Fixed
   subscriptions.getSubscription's IDOR (previously trusted a
   client-supplied clerkUserId arg; now derives identity from
   ctx.auth, with Clerk "convex"-template JWT tokens forwarded through
   the three Next.js server call sites via a new lib/convex-auth.ts
   helper). Retention texting now matches the final plan decision:
   Starter gets no texting at all, Pro gets automatic weekly only,
   Elite gets automatic + a manual send button — enforced both in the
   UI and as a hard reject in the triggerRetentionTexts mutation
   itself (isElitePlan/isProPlan helpers in subscriptions.ts), plus a
   MAX_TEXTS_PER_RUN=200 cap.

   Went through a full 8-angle automated code review before commit.
   Real bugs it caught and got fixed: (a) classes.getById gracefully
   returns null on a missing/foreign class but the newly-scoped
   sibling queries used on the same page (enrollments.getByClass,
   attendance.getByClassAndDate/getSessionDates) originally threw
   instead — would have crashed app/classes/[id]/page.tsx for any
   legacy or cross-gym class id, since Convex hooks fire unconditionally
   and there's no error boundary; now all four degrade gracefully
   together. (b) enrollments.unenroll never validated memberId
   ownership (asymmetric vs enroll); fixed. (c) The classes/invoices
   backfill migration (migrations.ts:backfillFirstGym) had a genuine
   cross-tenant data-misattribution bug — blindly assigned every
   orphaned row to whichever gymId was passed in, with no check for a
   second gym existing; now refuses to run unless the target gym is
   the only gym in the system. Caught by testing the guard live, not
   just by review — the first version of the fix still had a gap
   (didn't account for the call creating a brand-new second gym
   mid-call); corrected and reverified. (d) handleEnroll/handleUnenroll
   in the classes detail page had no try/catch unlike its sibling
   handleLogAttendance; fixed. Also fixed as cleanup: an N+1 query loop
   in enrollments.getEnrollmentCounts, several sequential-await loops
   parallelized via Promise.all, and the duplicated ownership-check
   helpers/migration loops/token-extraction snippets consolidated per
   multiple independent review angles converging on the same finding.

====================================================================
INFRASTRUCTURE STATUS
====================================================================

- Clerk: Development instance (pk_test_..., local dev only, don't
  touch) and Production instance (pk_live_..., domain
  clerk.kombatdesk.com, DNS/SSL verified). Production instance
  currently has ZERO signed-up users — expected, nobody has used the
  live site yet.
- Convex: dev deployment polished-peacock-100 (local dev, all
  verification above ran here). Production deployment
  limitless-raven-596 — schema + functions now pushed,
  CLERK_JWT_ISSUER_DOMAIN=https://clerk.kombatdesk.com set. GOTCHA
  already hit once: Convex deployment env vars are separate from
  .env.local and can silently drift — verify with
  `npx convex env get <VAR> --prod` / `--dev`, don't assume.
- Vercel: project mma-saas-xyr1 (team "SaaS MMA"), connected to the
  GitHub repo, Root Directory correctly set to mma-saas, all env vars
  entered directly by Zain (never through an AI tool — secrets should
  never be typed by an agent).
- DNS/domain: STALE NOTE CORRECTED (July 2026, terminal session) —
  kombatdesk.com IS now pointed at Vercel and serving the live app.
  Verified directly: `curl -IL https://kombatdesk.com/` returns a 308
  from the apex to https://www.kombatdesk.com/, which returns 200 with
  Server: Vercel / X-Vercel-Id headers. This was previously the
  biggest open item and is done — don't re-flag it as missing.
  (This apex→www redirect is almost certainly what broke live Stripe
  webhook delivery earlier — Stripe was hitting the apex URL and not
  following the 308 on POST. Endpoint/URL should be double-checked
  against www.kombatdesk.com if webhook issues recur.)

====================================================================
DECISIONS / KNOWN HISTORY
====================================================================

- STRIPE WEBHOOK HANDLING LIVES IN THE NEXT.JS ROUTE ON VERCEL, BY
  DECISION (July 2026) — app/api/stripe/webhook/route.ts is the one
  real handler, registered as the live endpoint in Stripe at
  https://kombatdesk.com/api/stripe/webhook. It reads STRIPE_SECRET_KEY
  and STRIPE_WEBHOOK_SECRET from Vercel's env, not Convex's.

  A FIRST attempt to move webhook handling into Convex itself mixed
  "use node" with httpAction (which Convex disallows outright) and was
  removed as broken/abandoned, never committed.

  UPDATE (commit 1e5dc4e, 2026-07-16, supersedes the paragraph above):
  a SECOND, correctly-scoped attempt is now committed and pushed to
  master — convex/http.ts (default runtime, delegates via
  ctx.runAction) + convex/stripeWebhookAction.ts ("use node", does the
  actual Stripe signature verification). This is Phase 1 of a
  deliberate two-phase cutover: the new endpoint
  (<deployment>.convex.site/stripe/webhook) runs ALONGSIDE the
  existing Next.js route, unchanged, receiving no real traffic yet —
  Stripe's dashboard endpoint has NOT been repointed.

  UPDATE (verified 2026-07-27, terminal session, via
  `npx convex function-spec --prod` against limitless-raven-596):

  ✅ All three mutations converted to internalMutation — verified in
     prod function spec — upsertSubscription, upsertUnclaimedSubscription,
     updatePlanStatusByCustomer are all "internal", not callable by a
     signed-in browser.
  ✅ Convex httpAction POST /stripe/webhook registered and live at
     limitless-raven-596.convex.site/stripe/webhook.
  ❌ Remaining step: repoint the Stripe Dashboard webhook endpoint from
     https://www.kombatdesk.com/api/stripe/webhook to the Convex URL.
     Deliberately deferred until after the first live purchase test and
     first revenue — do not cut over before then. Two payment paths,
     one verified; debug them separately.

  Note: the Convex endpoint is registered but idle — it has never
  processed a real Stripe event, so its STRIPE_WEBHOOK_SECRET is
  unverified and may predate the key rotation.

  Do not re-remove convex/http.ts or convex/stripeWebhookAction.ts as
  if they were the abandoned first attempt — they're live, intentional
  Phase 1 work, and the internalMutation conversion above is already
  done. The only open item is the dashboard repoint itself, deliberately
  held until after first revenue.

====================================================================
KNOWN ISSUES, NOT YET FIXED (decisions needed, not urgent)
====================================================================

- Stripe Tax registration deliberately ON HOLD — Colorado Springs
  home-rule-city SaaS tax question unresolved, and premature
  registration creates filing obligations for a pre-revenue business
  nowhere near nexus thresholds. Revisit later, not urgent.
- Custom Stripe Checkout domain (checkout.kombatdesk.com, $10/mo)
  deliberately skipped as unnecessary polish pre-revenue.
- Pricing page copy for the Starter tier still needs the manual-
  texting promise removed (Starter now gets no texting at all, code
  side is fixed — copy edit proposed but not yet applied pending
  wording approval), and Elite's copy still doesn't mention its
  manual-send capability at all. Both proposed, waiting on Zain.
- gymId is still v.optional on members/classes/invoices (staged
  migration choice, not tightened to required yet) — nothing at the
  type level stops a future insert from skipping it. The
  backfillFirstGym migration now at least refuses to run unsafely once
  more than one gym exists, but doesn't prevent this class of bug
  elsewhere. Revisit once confident no more schema changes are coming.
- enrollments/attendance tables still have no gymId of their own —
  scoped transitively via their classId/memberId reference instead.
  Works today; would need its own gymId+index if either table's
  gym-scoped queries ever become a real hot path at scale.

====================================================================
REMAINING GO-LIVE STEPS, IN ORDER
====================================================================

1. Add kombatdesk.com as a custom domain in the Vercel project → get
   the DNS record Vercel wants → add it in Namecheap Advanced DNS.
   (Vercel/domain lane — business Claude / extension, not terminal.)
2. Once domain resolves and SSL issues, register a live webhook
   endpoint in Stripe Dashboard (live mode) pointing at
   https://kombatdesk.com/api/stripe/webhook, covering
   customer.subscription.created/updated/deleted and
   invoice.payment_succeeded/payment_failed. Set the signing secret
   in Vercel env vars, redeploy.
3. Sign up fresh on the live production site (new account) for a real
   end-to-end smoke test. The multi-tenancy/auto-provisioning
   backend logic is already proven correct in dev (#1/#2 above) —
   this step confirms it behaves identically once actually live.
   Terminal session can verify the Convex-side portion (gym isolation,
   correct record creation) against limitless-raven-596 once the URL
   is confirmed reachable.
4. Whenever ready: Stripe Tax registration decision, apply the
   proposed Starter/Elite pricing copy edits (waiting on Zain's
   wording approval — see KNOWN ISSUES).

====================================================================
LANE OWNERSHIP (as of this briefing)
====================================================================
- Vercel / domains / deploy triggers: business Claude
- Convex backend logic / local verification: terminal session
- Browser-based dashboard checks (Clerk, Stripe, Vercel UI): extension
Confirm current ownership before acting outside your lane — it may
have shifted since this was written.
