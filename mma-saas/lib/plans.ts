// Single source of truth for displayed plan prices — referenced by both
// pricing-cards.tsx and the onboarding wizard's renewal disclosure so they
// can never drift apart. Actual billing amounts live in Stripe (the price
// IDs in STRIPE_STARTER_PRICE_ID/etc.); this is purely for display copy.
export const PLAN_PRICE_USD: Record<string, number> = {
  starter: 49,
  pro: 89,
  elite: 149,
};
