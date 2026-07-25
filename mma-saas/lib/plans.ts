// Free-trial length, in days. Single source of truth: this is both the value
// handed to Stripe (subscription_data.trial_period_days in
// app/api/stripe/checkout/route.ts) and the number quoted in user-facing copy
// (the onboarding wizard's renewal disclosure, the Stripe trial confirmation
// email), so the promise and the actual grant can't drift apart. Trial
// *status* is never derived from this — planStatus === "trialing" comes from
// Stripe, and the trial end date comes from the subscription's trial_end.
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
// unchanged), just relabeled. New Stripe Prices at $99/$179/$299 have since
// been created; STRIPE_STARTER_PRICE_ID / STRIPE_PRO_PRICE_ID /
// STRIPE_ELITE_PRICE_ID hold the Academy / Fight Team / Black Belt price IDs
// respectively in Vercel Production and Convex prod, env var names
// deliberately not renamed (renaming them means updating Vercel + the Convex
// dashboard, not just this file).
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
// in app/pricing/page.tsx. "starter" is the one exclusion: gym rows written
// before the academy/fightteam/blackbelt rename (see stripeWebhookAction.ts's
// history) can still carry the legacy "starter" slug, which never included
// texting under the old pricing and shouldn't gain it retroactively just
// because the tier-based gate was replaced with a billing-status-only one.
export function planHasTexting(plan: string | undefined): boolean {
  return plan !== undefined && plan !== "starter";
}
