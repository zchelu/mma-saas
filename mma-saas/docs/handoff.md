# Handoff — pointer

**Durable context lives in the claude.ai project, not here.** Per AGENTS.md, the
project copy is canonical and a committed mirror drifts — this file did exactly
that, and by 2026-08-24 it was telling readers that fixed bugs were still broken
and describing a recovery procedure that does not work.

Start with the newest `claude/handoff-*.md` in the project. As of 2026-08-24:

- `claude/handoff-funnel-2026-08-20.md` — the signup funnel: stranded-payment
  fix, wizard prefill, disabled-button contrast, what is verified vs unrun.
- `claude/gym-row-clobber-2026-08-20.md` — how cancelling a duplicate Stripe
  subscription downgraded a live gym, the three failures that stacked to allow
  it, and the guards now preventing it.
- `claude/lane-coordination-2026-08-19.md` — lane boundaries; two sessions share
  this tree.

## Corrections to what this file used to say

Recorded here because anyone who read the old version may be carrying them.

- **"To recover a stranded paid customer, resend `customer.subscription.created`"
  — WRONG.** `convex/stripeEvents.ts:claimEventId` records every successfully
  processed event id for 30 days, so resending an event that already returned
  200 is discarded before any handler sees it. Stripe still reports
  `pending_webhooks: 1`, which means delivered, not processed. Call
  `stripeEvents:releaseEventId` first, or mint a genuinely new event.
- **The `/onboarding` blank page was never a code bug.** A zombie `next dev`
  held port 3000 and served older code. Check the startup banner for
  `Port 3000 is in use by process NNNN` before believing any dev-server symptom.
- **The silent stranded-payment loop is fixed** (`9417e23`) and the fix was
  watched working. The wizard prefill and the disabled-button contrast are
  verified on screen too.
- **`npx convex dev` without `--once` is a watcher** that re-pushes the working
  directory on every save — with two lanes in this tree it will ship the other
  lane's half-finished work.

## Run it

```
npm run dev
npx tsc --noEmit && npm run lint && npm run check:convex && npm run test:once
npx convex dev --once   # DEV  polished-peacock-100
npx convex deploy       # PROD limitless-raven-596 — interactive, Zain runs it
```

`.env.local`: `STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`,
`STRIPE_FOUNDING_COUPON_ID`, three `STRIPE_*_PRICE_ID`, Clerk + Convex URLs.
Convex env is a **separate store**: `STRIPE_WEBHOOK_SECRET`,
`STRIPE_CONNECT_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY`.
