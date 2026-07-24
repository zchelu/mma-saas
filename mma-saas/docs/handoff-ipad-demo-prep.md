# KombatDesk — Handoff: iPad Demo Prep (Colorado Springs BJJ)

**Last updated:** 2026-07-23
**Lane:** This session (terminal + Claude browser extension, working together). Two
other lanes are documented separately — `docs/handoff.md` (check-in/offline-queue/
CSV-import) and `docs/handoff-onboarding-auth-first.md` (onboarding/checkout flow,
prod deploy of `onboarding.ts`). Do not merge any of these three documents.

## The goal we're working toward

Close the first paying client: a specific gym owner in Colorado Springs. Immediate
deliverable is an in-person iPad demo of KombatDesk, run live on **production**
(kombatdesk.com / Convex deployment `limitless-raven-596`), followed by a
screen-recorded explainer video. Everything in this doc is prep toward that demo.

## Current state of the code

**Repo root (git):** `C:\Users\zainc\mma-saas` — **App root:** `C:\Users\zainc\mma-saas\mma-saas`
(nested folder, confirmed intentional, not a mistake).

### Demo gym — live and seeded on production
- Account: `kombatdeskdemo@gmail.com` (Google OAuth via Clerk — no password exists
  for this account).
- Gym `_id`: `jx7ahw5fkgmfweyb3fpe0y1ftn8b4pc6`, name "Colorado Springs BJJ",
  `plan: "elite"`, `planStatus: "active"` (set manually in the Convex dashboard —
  see "Paywall bypass" below).
- 18 members (6 white / 5 blue / 4 purple / 2 brown / 1 black), 8 classes with 36
  enrollments, 450 check-ins spread over 60 days, 3 past-due invoices, 2 at-risk
  members (check-ins stop ~12 days ago). Seeded via a real `--commit --prod` run,
  confirmed live on the actual dashboard by the user.
- **Tyler Brandt** (`_id` `jn7d1tt400vw25ee0djc22sh4d8b4hh4`): White (4 stripes,
  maxed) — the live belt-promotion demo moment. Promoted by editing the plain-text
  `beltRank` field in Members > Edit modal (`app/members/member-modal.tsx`) — there
  is no `ranks`-table editing UI yet; belt display is still the legacy free-text
  field on `members`.

### Commits made this session, on `master`, pushed to `origin/master`
- `b8e4f85` — "Add demo-gym seed script and editable Elite retention-text message":
  - `convex/seedDemoGym.ts` (new) — internal mutation, refuses to run if the target
    gym already has any members. Takes fully pre-computed `classes`/`members`
    payloads (including check-in timestamps) from the CLI script — no randomness
    inside the mutation itself.
  - `scripts/seed-demo-gym.js` (new) — CLI wrapper, dry-run by default, `--commit
    --prod` to write for real. Mirrors `scripts/seed-promotion-criteria.js`'s flag
    conventions exactly (`--gym-id=`, `--commit`, `--prod`).
  - `convex/sendRetentionTexts.ts` — `triggerRetentionTexts` (public mutation) and
    `sendManualRetentionTextsForGym` (internal action, Elite-only manual path) now
    take a required `message: string` arg (max 480 chars, enforced via
    `assertMaxLength`). `sendRetentionTextsCore` accepts an optional
    `customMessage`; when present, a `{name}` token in it is replaced with the
    recipient's first name, and " Reply STOP to opt out." is always appended
    server-side regardless of what was typed. The automated Pro/Elite cron path
    (`sendRetentionTextsForGym`) never passes `customMessage`, so its wording is
    completely unchanged.
  - `app/dashboard/retention-button.tsx` — the Elite "Send Retention Texts" button
    now opens a compose textarea (pre-filled with the old default wording as a
    starting point, editable, character counter) instead of firing a fixed
    message immediately on click.
- Both Convex deploys (`npx convex deploy`, run twice this session — once for the
  seed function, once for the retention-text change) succeeded against
  `limitless-raven-596`. Push to `origin/master` succeeded; Vercel should
  auto-deploy from it (not yet re-confirmed live on kombatdesk.com by the user as
  of this doc's last update — worth a quick check).

## Files actively being edited this session
- `convex/seedDemoGym.ts` (new)
- `scripts/seed-demo-gym.js` (new)
- `convex/sendRetentionTexts.ts`
- `app/dashboard/retention-button.tsx`

**Not mine, explicitly flagged, untouched:** everything under the other two lanes'
docs above — in particular anything in `app/checkin/`, `lib/checkInQueue.ts`,
`lib/checkInCaller.ts`, and the onboarding/checkout files listed in
`docs/handoff-onboarding-auth-first.md`.

## Everything tried and failed (or turned out to be a dead end)

- **Trusted a prior session's memory notes that `convex/seedDemoGym.ts` and
  `scripts/seed-demo-gym.js` already existed, were typechecked, and had a
  confirmed-working dry run.** This was false — neither file existed anywhere on
  disk, and there was zero git history for either. The described work was never
  actually persisted, only asserted in memory. Root-caused by directly checking
  `git log --all` and the filesystem instead of trusting the notes; rebuilt both
  files from scratch this session. Lesson generalized into a standing memory
  (`feedback-verify-stale-session-claims`): always verify a prior session's
  "already built/tested/deployed" claims against real disk/git state.
- **Assumed `/sign-up` would show a Clerk email/password form immediately.** In
  practice, `app/sign-up/[[...sign-up]]/signup-gate.tsx` gates the Clerk
  `<SignUp>` widget behind a ToS-acceptance click, and `<SignUp>` itself
  auto-redirects straight past sign-up to `/onboarding` if the browser already has
  *any* active Clerk session.
- **Tried "fresh tab" and "full browser restart" via the Claude browser extension
  to get a clean, logged-out session** — both failed silently. The extension runs
  inside the user's actual real Chrome profile, not a sandboxed/incognito
  instance, so neither action actually cleared the Clerk session cookie. Confirmed
  by reading `window.Clerk.user` directly, which kept showing the real account
  (`zainckp+kdpro0723@gmail.com`) through both attempts.
- **The fix that actually worked:** running `await window.Clerk.signOut()`
  directly in the page's JS context (the extension already had this capability,
  just hadn't used it), then re-verifying `window.Clerk.user` was null before
  proceeding. This is the reliable way to force a logged-out state through this
  extension going forward — don't rely on "new tab"/"restart" claims from it.
  Getting to a logged-out state also required the user to first manually sign out
  in their own browser once (`/dashboard` > account menu > sign out), since one
  earlier signout attempt only ended the extension's view of the session, not
  necessarily every session.
- **A stale-doc scare mid-session:** `docs/handoff-onboarding-auth-first.md`
  (written by a different session earlier the same day) claimed prod Convex was
  "critically stale, missing the entire `onboarding.ts` module" and that every
  signup was broken. Direct verification via `npx convex function-spec --prod`
  showed `onboarding.js:completeOnboarding` already registered — someone had
  deployed since that doc was written. Don't re-flag this as broken without
  re-checking function-spec first.
- **Considered a real Stripe trial checkout instead of the manual Convex-edit
  bypass for the demo account** — rejected (this was actually decided in a prior
  session, reconfirmed here): live-card risk and forgetting-to-cancel risk on a
  throwaway account aren't worth it for a demo gym.

## Next step

1. **Confirm the retention-button/seed-script push actually deployed live** — load
   kombatdesk.com's dashboard (signed in as `kombatdeskdemo@gmail.com`) and click
   "Send Retention Texts" to confirm the compose box appears (not the old
   fire-immediately behavior). This hasn't been re-confirmed live since the push.
2. **Do the actual physical iPad walkthrough** — real Safari, real cellular data
   (not just wifi), on the seeded "Colorado Springs BJJ" demo gym:
   - `/checkin` kiosk: tap target sizes, no horizontal scroll.
   - Member profile page, specifically Tyler Brandt's — confirm the belt-promotion
     edit flow (Members > Edit modal, change `beltRank` text field live) works
     smoothly on a touchscreen.
   - Dashboard At-Risk panel — confirm exactly 2 members show.
   - Invoices page — confirm the 3 past-due invoices render correctly.
3. **Once the iPad pass is clean, lock the tap-by-tap demo script** — 4 stops:
   kiosk check-in → member profile/belt promotion → dashboard at-risk → billing/
   invoices. Decide whether the new retention-text compose button gets a 5th demo
   stop or stays a talking point only.
