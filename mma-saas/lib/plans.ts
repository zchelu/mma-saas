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
//   app/api/stripe/checkout/route.ts  trial_period_days (the actual grant)
//   app/pricing/page.tsx              x3 — tier footnote, guarantee block,
//                                     founding block
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
// in app/pricing/page.tsx. "starter" is the one exclusion: gym rows written
// before the academy/fightteam/blackbelt rename (see stripeWebhookAction.ts's
// history) can still carry the legacy "starter" slug, which never included
// texting under the old pricing and shouldn't gain it retroactively just
// because the tier-based gate was replaced with a billing-status-only one.
export function planHasTexting(plan: string | undefined): boolean {
  return plan !== undefined && plan !== "starter";
}

export type PlanSlug = "academy" | "fightteam" | "blackbelt";

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
