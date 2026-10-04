// Free-trial length, in days. Single source of truth: this is both the value
// handed to Stripe (subscription_data.trial_period_days in
// app/api/stripe/checkout/route.ts) and the number quoted in user-facing copy,
// so the promise and the actual grant can't drift apart. Trial *status* is
// never derived from this — planStatus === "trialing" comes from Stripe, and
// the trial end date comes from the subscription's trial_end.
//
// Every TSX/TS consumer imports this constant. Do not hardcode the number
// again anywhere; "day 31" phrasing is TRIAL_DAYS + 1, also computed.
// Verified consumers as of 2026-07-30:
//   lib/checkoutSession.ts            trial_period_days (the actual grant —
//                                     moved out of app/api/stripe/checkout/
//                                     route.ts 2026-08-24 so it could be tested)
//   app/pricing/page.tsx              x2 — tier footnote, guarantee block
//   app/founding/page.tsx             tier footnote (added 2026-10-03, when
//                                     the founding block left /pricing)
//   app/page.tsx                      homepage guarantee block
//   app/onboarding/onboarding-wizard.tsx  renewal disclosure
//   convex/stripeWebhookAction.ts     trial confirmation email
//
// ONE EXCEPTION that cannot import this — content/terms.html "Free Trial"
// section says "30-day free trial" as literal text. It is a Termly static
// export, so it has no build step to interpolate through AND a Termly
// re-export silently reverts manual edits. If TRIAL_DAYS ever changes, that
// clause must be updated by hand or the Terms become a false statement about
// billing. Change this constant => grep content/terms.html for "30-day".
export const TRIAL_DAYS = 30;

// Single source of truth for displayed plan prices and labels — referenced by
// the onboarding wizard's renewal disclosure, /welcome, and the Stripe trial
// confirmation email, so they can never drift apart. Actual billing amounts
// live in Stripe (the STRIPE_*_PRICE_ID env vars); this is purely display copy.
//
// One generation of slugs as of the starter/pro/elite -> academy/fightteam/
// blackbelt rename: the plan slug the Stripe webhook derives
// (convex/stripeWebhookAction.ts, convex/subscriptions.ts) now writes these
// same academy/fightteam/blackbelt values to gym rows — same three Stripe
// Prices as before (STRIPE_STARTER_PRICE_ID/etc. env var names are
// unchanged), just relabeled. CONFIRMED 2026-07-26 against the Stripe
// dashboard directly (not inferred from code comments) and Vercel Production:
// STRIPE_STARTER_PRICE_ID / STRIPE_PRO_PRICE_ID / STRIPE_ELITE_PRICE_ID point
// at the $99/$179/$299 Prices below. Convex prod env vars UNVERIFIED as of
// 2026-07-26 — has NOT been checked against the Convex dashboard. Env var
// names deliberately not renamed (renaming them means updating Vercel + the
// Convex dashboard, not just this file).
export const PLAN_PRICE_USD: Record<string, number> = {
  academy: 99,
  fightteam: 179,
  blackbelt: 299,
};

// Explicit map rather than capitalizing the slug — "fightteam" and "blackbelt"
// are single tokens that would render as "Fightteam" and "Blackbelt".
export const PLAN_LABEL: Record<string, string> = {
  academy: "Academy",
  fightteam: "Fight Team",
  blackbelt: "Black Belt",
};

// Every current tier (academy/fightteam/blackbelt) includes winback texting —
// there's no pro-vs-elite automated-vs-manual split anymore, see PRICING_TIERS
// in app/pricing/tiers.ts. "starter" is the one exclusion: gym rows written
// before the academy/fightteam/blackbelt rename (see stripeWebhookAction.ts's
// history) can still carry the legacy "starter" slug, which never included
// texting under the old pricing and shouldn't gain it retroactively just
// because the tier-based gate was replaced with a billing-status-only one.
export function planHasTexting(plan: string | undefined): boolean {
  return plan !== undefined && plan !== "starter";
}

export type PlanSlug = "academy" | "fightteam" | "blackbelt";

// The one line of the C.R.S. 6-1-732 confirmation email that explains a
// discounted charge (convex/stripeWebhookAction.ts). Pure and here, rather
// than inline in that action, so it can be unit-tested: this email is the
// written record of what the customer agreed to pay, and nothing else in that
// file is reachable from a test.
//
// TWO SHAPES, AND THE DIFFERENCE IS A LEGAL ONE. A founding gym signed up
// since 2026-10-03 holds a duration=forever coupon — its price never reverts,
// and telling it "then $99.00/month" would put a price increase in writing
// that is never going to happen. A coupon that DOES end (the retired $50-off
// program ran 25 months) must keep saying when and to what. `lockedForLife`
// is read off the coupon itself by the caller, never assumed from the plan.
//
// Returns null when nothing is discounted, so the caller prints no line.
export function discountConfirmationLine(input: {
  listUsd: number;
  chargeUsd: number;
  lockedForLife: boolean;
}): string | null {
  const { listUsd, chargeUsd, lockedForLife } = input;
  const money = (usd: number) => `$${usd.toFixed(2)}`;
  if (!(listUsd - chargeUsd > 0)) return null;
  return lockedForLife
    ? `Founding price: ${money(chargeUsd)}/month, locked for as long as you stay subscribed. The standard price is ${money(listUsd)}/month.`
    : `Founding rate applied: ${money(listUsd - chargeUsd)} off per month for at least your next 24 bills, then ${money(listUsd)}/month.`;
}

// Env var names deliberately NOT renamed to match the academy/fightteam/
// blackbelt slugs — see PLAN_PRICE_USD's comment above.
const STANDARD_PRICE_ENV: Record<PlanSlug, string> = {
  academy: "STRIPE_STARTER_PRICE_ID",
  fightteam: "STRIPE_PRO_PRICE_ID",
  blackbelt: "STRIPE_ELITE_PRICE_ID",
};

export function resolvePriceId(plan: PlanSlug): string | undefined {
  return process.env[STANDARD_PRICE_ENV[plan]];
}

// Centralizes price->plan resolution across both webhook/claim call sites.
// Returns undefined for anything not in this table — callers MUST NOT
// default an unresolved price to any plan. An unrecognized price is most
// likely during a rollout where a new env var hasn't landed in one of the
// two environments (Vercel, Convex dashboard) yet; silently mislabeling the
// tier is worse than surfacing the gap loudly.
export function resolvePlanFromPriceId(priceId: string | undefined): PlanSlug | undefined {
  if (!priceId) return undefined;
  const table: [string | undefined, PlanSlug][] = [
    [process.env[STANDARD_PRICE_ENV.academy], "academy"],
    [process.env[STANDARD_PRICE_ENV.fightteam], "fightteam"],
    [process.env[STANDARD_PRICE_ENV.blackbelt], "blackbelt"],
  ];
  return table.find(([envValue]) => envValue !== undefined && envValue === priceId)?.[1];
}

// Checkout allowlist — every standard price currently configured in this
// environment. Env vars that aren't set are simply absent from the list, not
// included as undefined.
export function allowedPriceIds(): string[] {
  return [
    process.env[STANDARD_PRICE_ENV.academy],
    process.env[STANDARD_PRICE_ENV.fightteam],
    process.env[STANDARD_PRICE_ENV.blackbelt],
  ].filter((id): id is string => id !== undefined);
}

// ---------------------------------------------------------------------------
// Founding (comped) trial
// ---------------------------------------------------------------------------
//
// TWO DIFFERENT TRIALS LIVE IN THIS CODEBASE. Do not merge them.
//
//   1. THE STRIPE TRIAL — every normal customer. Checkout collects a card,
//      subscription_data.trial_period_days (lib/checkoutSession.ts) delays the
//      first invoice by TRIAL_DAYS, planStatus "trialing" arrives from the
//      customer.subscription.created webhook, and on day TRIAL_DAYS + 1 Stripe
//      charges the card automatically. Unchanged by anything below.
//
//   2. THE FOUNDING TRIAL — the comped, no-card trial granted to the first
//      gym(s) by convex/onboarding.ts:completeOnboarding. There is NO Stripe
//      customer, NO subscription and NO card. planStatus "trialing" is written
//      straight onto the gyms row and gyms.foundingTrialEndsAt is the entire
//      expiry mechanism. Nothing can ever charge this gym, because Stripe has
//      never heard of it.
//
// The helpers below are the only place the second kind is interpreted. They are
// pure (no I/O, no Date coupling beyond an injectable `now`) because BOTH halves
// of the app need them: convex/gyms.ts enforces access with them, and
// app/dashboard + app/billing render from them. lib/plans.ts is already the
// shared module Convex is allowed to bundle — keep these here rather than in a
// file that imports Stripe or Next (see lib/foundingOffer.ts's header for what
// happens otherwise).
//
// NOTE the shape: a structural subset of Doc<"gyms">, deliberately NOT an
// import of it. lib/* must not import convex/_generated — Convex bundles this
// file, and that would be a cycle.
export type FoundingTrialFields = {
  foundingTrialEndsAt?: number;
  stripeSubscriptionId?: string;
};

// A REAL STRIPE SUBSCRIPTION ALWAYS OUTRANKS THE COMPED TRIAL, and that single
// rule is why every helper here takes the whole gym instead of just the
// timestamp. foundingTrialEndsAt is never cleared once written (it is also the
// "already had its free month" record — see hasUsedFoundingTrial), so a gym
// that converted three months ago still carries a timestamp deep in the past.
// Without this check that stale timestamp would read as an expired trial and
// revoke write access from a paying customer.
export function hasFoundingTrial(gym: FoundingTrialFields): boolean {
  return gym.foundingTrialEndsAt !== undefined && !gym.stripeSubscriptionId;
}

export function isOnFoundingTrial(gym: FoundingTrialFields, now: number = Date.now()): boolean {
  return hasFoundingTrial(gym) && gym.foundingTrialEndsAt! > now;
}

// THE EXPIRY. There is no cron and no scheduled job anywhere behind the
// founding trial: this function is evaluated inside convex/gyms.ts's
// hasWriteAccess on every gym-scoped write and inside getSubscription on every
// read, so the trial ends at the exact millisecond foundingTrialEndsAt names,
// whether or not any background process ran. A cron would have added a second
// source of truth and a window (up to a day wide) where the two disagreed.
export function foundingTrialExpired(gym: FoundingTrialFields, now: number = Date.now()): boolean {
  return hasFoundingTrial(gym) && gym.foundingTrialEndsAt! <= now;
}

// Whether this gym has EVER been granted a comped trial — converted or not,
// expired or not. Deliberately ignores stripeSubscriptionId, unlike every
// helper above: this is the record that stops app/api/stripe/checkout/route.ts
// handing a converting founding gym a SECOND free month on the Stripe side, and
// that gym is converting precisely because it is about to have a subscription.
export function hasUsedFoundingTrial(gym: { foundingTrialEndsAt?: number }): boolean {
  return gym.foundingTrialEndsAt !== undefined;
}

// Whole days remaining, rounded UP and floored at 0. Rounded up because the
// last 23 hours of a trial must read "1 day left", not "0 days left" — a
// countdown that reaches zero while access still works reads as a bug to the
// owner and as a lie to us.
export function foundingTrialDaysLeft(gym: FoundingTrialFields, now: number = Date.now()): number {
  if (!hasFoundingTrial(gym)) return 0;
  return Math.max(0, Math.ceil((gym.foundingTrialEndsAt! - now) / 86_400_000));
}

// Length of the FOUNDING trial, in days. Deliberately its own constant rather
// than a reuse of TRIAL_DAYS, which is 30 and must stay 30:
//
//   - TRIAL_DAYS is what Stripe grants every normal paying customer
//     (lib/checkoutSession.ts). Changing it changes what every future signup
//     gets, which is not what a founding-gym decision should do.
//   - content/terms.html says "30-day free trial" as literal text and cannot
//     interpolate (Termly static export — see TRIAL_DAYS' comment). Moving
//     TRIAL_DAYS without editing that file by hand makes the Terms a false
//     statement about billing.
//
// The founding trial has neither constraint: no card, no Stripe subscription,
// no auto-renewal, so nothing in the Terms' "Free Trial" clause describes it.
// It is a comped grant Zain hands out by hand, and its length is a sales
// decision, not a billing one.
//
// Every founding-facing consumer imports THIS, not TRIAL_DAYS:
//   lib/plans.ts                          foundingTrialEndFrom (the actual grant)
//   app/onboarding/onboarding-wizard.tsx  x3 — the green access line, the
//                                         disclosure, the submit button label
export const FOUNDING_TRIAL_DAYS = 60;

// The grant itself, in one place, so the length promised in the wizard and the
// length written to the row can never be two numbers.
export function foundingTrialEndFrom(startedAt: number): number {
  return startedAt + FOUNDING_TRIAL_DAYS * 86_400_000;
}
