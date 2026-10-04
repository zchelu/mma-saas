import Stripe from "stripe";
import { unstable_cache } from "next/cache";

// Split out of lib/plans.ts: convex/subscriptions.ts, convex/sendRetentionTexts.ts,
// and convex/stripeWebhookAction.ts import from lib/plans.ts, and Convex bundles
// by static import analysis — the stripe/next/cache imports and the
// unstable_cache(...) module-scope call below would otherwise get pulled into
// the Convex bundle on deploy even though no Convex function uses them.
// lib/plans.ts must stay free of Next/Stripe imports; this file is imported
// only from app/* (Next.js runtime), never from convex/*.

// Classification and the checkout decision live in lib/foundingOfferPolicy.ts
// — pure, no I/O, no next/cache — so they can be unit-tested directly. This
// file keeps the parts that touch the network and the cache.
import {
  classifyFoundingProgram,
  FOUNDING_COUPON_ENV,
  FOUNDING_PLANS,
  programFromResult,
  type FoundingCouponLookup,
  type FoundingProgram,
  type FoundingProgramResult,
} from "./foundingOfferPolicy";
import type { PlanSlug } from "./plans";

export type { FoundingProgram, FoundingProgramResult };

// getFoundingProgram() collapses every non-available state into null for
// callers that don't need the distinction (/founding just hides itself either
// way); callers that charge money (checkout) must use
// getFoundingProgramResult() and route it through offerResultForPlan() and
// planCheckout(), which is the only thing that knows a sellout from a
// misconfiguration from an outage.

// Cached separately from the validation logic in resolveFoundingProgram below:
// only the raw Stripe round-trip is memoized, so a transient Stripe error never
// gets cached as a false "no offer" — it just falls through to the try/catch
// in resolveFoundingProgram and retries fresh on the next request. The coupon
// id is part of the cache key, so two tiers naming the same coupon share one
// round-trip. Plain
// unstable_cache rather than "use cache" (Next 16's replacement): "use cache"
// requires opting the whole app into Cache Components via cacheComponents in
// next.config.ts, which isn't enabled here and is a much bigger change than
// this task — unstable_cache needs no config change and is still shipped
// (deprecated, not removed) in this Next version.
//
// The `new Stripe(process.env.STRIPE_SECRET_KEY!)` below LOOKS like an
// AGENTS.md §7 violation and has been re-opened as one across three separate
// handoffs. It is not one. Verified 2026-08-09 — leave it:
//
//   - Its only caller is resolveFoundingProgram, which awaits it INSIDE a
//     try/catch (see below). A synchronous throw in an async function is a
//     rejected promise, so a missing key is caught, classified by
//     classifyCouponError as `unknown`, and checkout refuses the sale and
//     alerts — the correct outcome, not a silent 500.
//   - app/api/stripe/checkout/route.ts never calls this without a key
//     anyway; it short-circuits to missingApiKeyResult, which carries better
//     remediation copy. That route's comment at :70-75 already says so.
//
// If you ever move this call out of that try/catch, apply §7 properly first.
const getCachedCoupon = unstable_cache(
  async (couponId: string): Promise<Stripe.Coupon | Stripe.DeletedCoupon> => {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
    return await stripe.coupons.retrieve(couponId);
  },
  ["founding-coupon"],
  { revalidate: 60 }
);

// The founding prices are Stripe coupons — one per tier, named by the
// FOUNDING_COUPON_ENV vars — not a second set of Prices. Their own redemption
// counts are the one source of truth for whether the program is still open, so
// /founding, the onboarding wizard and checkout all call this instead of
// trusting anything client-supplied. Must never throw: any failure here
// (missing env var, deleted/invalid coupon, Stripe API error) degrades to
// standard pricing, never a broken page or a blocked checkout.
//
// The rules a coupon has to meet (duration=forever, amount lands exactly on
// the founding price, room for all FOUNDING_SPOTS) live in
// classifyFoundingProgram — read that before creating or repointing a coupon.
async function resolveFoundingProgram(): Promise<FoundingProgramResult> {
  const lookups = {} as Record<PlanSlug, FoundingCouponLookup>;
  await Promise.all(
    FOUNDING_PLANS.map(async (plan) => {
      const couponId = process.env[FOUNDING_COUPON_ENV[plan]];
      if (!couponId) {
        lookups[plan] = { couponId: null };
        return;
      }
      try {
        lookups[plan] = { couponId, coupon: await getCachedCoupon(couponId) };
      } catch (error) {
        lookups[plan] = { couponId, error };
      }
    })
  );

  const result = classifyFoundingProgram(lookups);
  // The raw error only matters for the retryable case — a 404 is fully
  // described by the reason string, and logging a stack for a typo'd env var
  // buries the one line that actually tells you what to fix.
  if (result.status === "unknown") {
    for (const plan of FOUNDING_PLANS) {
      const lookup = lookups[plan];
      if ("error" in lookup) console.error("getFoundingProgram: Stripe call failed:", lookup.error);
    }
  }
  logResult(result);
  return result;
}

// One place to say what each state means operationally, so the log line and
// the behaviour can't drift apart.
function logResult(result: FoundingProgramResult): void {
  switch (result.status) {
    case "available":
      return;
    case "exhausted":
      console.warn(
        "getFoundingProgram: every founding spot is redeemed — /founding is hidden and checkout sells at list price. SOLD OUT, working as intended."
      );
      return;
    case "misconfigured":
      console.error(
        `getFoundingProgram: the founding coupons are MISCONFIGURED — /founding is hidden and checkout sells at LIST PRICE (an alert is sent from the checkout route if a founding buyer reaches it). This does not fix itself: ${result.reason}`
      );
      return;
    case "unknown":
      console.error(
        `getFoundingProgram: could not determine founding coupon state — /founding is hidden and a founding checkout will be REFUSED until this clears. Not sold out, may resolve on retry: ${result.reason}`
      );
      return;
  }
}

export async function getFoundingProgram(): Promise<FoundingProgram | null> {
  return programFromResult(await resolveFoundingProgram());
}

// For callers where treating "couldn't tell" the same as "sold out" would be
// a bug (i.e. checkout — see app/api/stripe/checkout/route.ts). Page display
// doesn't need the distinction and should keep using getFoundingProgram.
export async function getFoundingProgramResult(): Promise<FoundingProgramResult> {
  return resolveFoundingProgram();
}
