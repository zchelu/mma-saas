// Single source of truth for displayed plan prices — referenced by both
// pricing-cards.tsx and the onboarding wizard's renewal disclosure so they
// can never drift apart. Actual billing amounts live in Stripe (the price
// IDs in STRIPE_STARTER_PRICE_ID/etc.); this is purely for display copy.
// Free-trial length, in days. Single source of truth: this is both the value
// handed to Stripe (subscription_data.trial_period_days in
// app/api/stripe/checkout/route.ts) and the number quoted in user-facing copy,
// so the promise and the actual grant can't drift apart. Trial *status* is
// never derived from this — planStatus === "trialing" comes from Stripe, and
// the trial end date comes from the subscription's trial_end.
export const TRIAL_DAYS = 30;

export const PLAN_PRICE_USD: Record<string, number> = {
  starter: 49,
  pro: 89,
  elite: 149,
};
