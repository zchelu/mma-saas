// Single source of truth for displayed plan prices and labels — referenced by
// the onboarding wizard's renewal disclosure, /welcome, and the Stripe trial
// confirmation email, so they can never drift apart. Actual billing amounts
// live in Stripe (the STRIPE_*_PRICE_ID env vars); this is purely display copy.
//
// Two generations of slugs live here on purpose:
//
//   academy / fightteam / blackbelt — the pricing-v2 tiers. These only ever
//   reach the app through the ?plan= query param on a /pricing CTA, because no
//   Stripe Price exists for them yet.
//
//   starter / pro / elite — the legacy tiers. These are NOT dead keys. They are
//   still the only slugs the billing path can produce: the plan slug is derived
//   from the Stripe Price ID in convex/stripeWebhookAction.ts and
//   convex/subscriptions.ts, so every gym row and every trial email is keyed off
//   them until the new Prices are created and that derivation is renamed.
//   Dropping them renders "$undefined" into the Colorado ARL trial email.
export const PLAN_PRICE_USD: Record<string, number> = {
  // pricing-v2 tiers
  academy: 99,
  fightteam: 179,
  blackbelt: 299,
  // legacy tiers — still live on the Stripe webhook path
  starter: 49,
  pro: 89,
  elite: 149,
};

// Explicit map rather than capitalizing the slug — "fightteam" and "blackbelt"
// are single tokens that would render as "Fightteam" and "Blackbelt".
export const PLAN_LABEL: Record<string, string> = {
  // pricing-v2 tiers
  academy: "Academy",
  fightteam: "Fight Team",
  blackbelt: "Black Belt",
  // legacy tiers
  starter: "Starter",
  pro: "Pro",
  elite: "Elite",
};
