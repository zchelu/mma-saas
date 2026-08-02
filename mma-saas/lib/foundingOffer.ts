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
// file keeps the parts that touch the network and the cache. Re-exported here
// so existing importers of these types don't have to change.
import {
  classifyCoupon,
  classifyCouponError,
  offerFromResult,
  type FoundingOffer,
  type FoundingOfferResult,
} from "./foundingOfferPolicy";

export type { FoundingOffer, FoundingOfferResult };

// getFoundingOffer() collapses every non-available state into null for callers
// that don't need the distinction (the pricing page just hides the block
// either way); callers that charge money (checkout) must use
// getFoundingOfferResult() and route it through planCheckout(), which is the
// only thing that knows a sellout from a misconfiguration from an outage.

// Cached separately from the validation logic in getFoundingOffer below: only
// the raw Stripe round-trip is memoized, so a transient Stripe error never
// gets cached as a false "no offer" — it just falls through to the try/catch
// in getFoundingOffer and retries fresh on the next request. Plain
// unstable_cache rather than "use cache" (Next 16's replacement): "use cache"
// requires opting the whole app into Cache Components via cacheComponents in
// next.config.ts, which isn't enabled here and is a much bigger change than
// this task — unstable_cache needs no config change and is still shipped
// (deprecated, not removed) in this Next version.
const getCachedCoupon = unstable_cache(
  async (couponId: string): Promise<Stripe.Coupon | Stripe.DeletedCoupon> => {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
    return await stripe.coupons.retrieve(couponId);
  },
  ["founding-coupon"],
  { revalidate: 60 }
);

// The founding rate is a single Stripe coupon, not a second set of Prices —
// its own redemption count is the one source of truth for whether the offer
// is still live, so both the pricing page and checkout call this instead of
// trusting anything client-supplied. Must never throw: any failure here
// (missing env var, deleted/invalid coupon, Stripe API error) degrades to
// standard pricing, never a broken page or a blocked checkout.
//
// DELIBERATE MISMATCH — do not "fix".
// Stripe coupon: duration_in_months = 25. UI copy says 24. Both correct.
//
// The discount clock starts at SUBSCRIPTION CREATION, not first invoice.
// The 30-day trial does not consume or add a coupon month — it only
// shifts the billing anchor. Verified 2026-07-27 on a live test sub:
// created Jul 27 2026, discount.end Aug 27 2028, first invoice Aug 26
// 2026, last discounted invoice Aug 26 2028 = 25 discounted bills.
//
// So why does UI copy say 24? Because the count varies by signup date.
// A 31-day month lands the anchor one day inside the coupon boundary
// (25 bills). A late-February signup pushes it past (24 bills). There is
// no single true number. 24 is the FLOOR — promise the floor, deliver 24
// or 25, nobody is ever shortchanged.
//
// Never print an ordinal month number in customer-facing copy.
// Count bills, not months, or don't count at all.
async function resolveFoundingOffer(): Promise<FoundingOfferResult> {
  const couponId = process.env.STRIPE_FOUNDING_COUPON_ID;
  if (!couponId) {
    const result: FoundingOfferResult = {
      status: "misconfigured",
      couponId: null,
      reason: "STRIPE_FOUNDING_COUPON_ID is not set in this environment",
    };
    logResult(result);
    return result;
  }

  let result: FoundingOfferResult;
  try {
    result = classifyCoupon(await getCachedCoupon(couponId), couponId);
  } catch (err) {
    result = classifyCouponError(err, couponId);
    // The raw error only matters for the retryable case — a 404 is fully
    // described by the reason string, and logging a stack for a typo'd env var
    // buries the one line that actually tells you what to fix.
    if (result.status === "unknown") console.error("getFoundingOffer: Stripe call failed:", err);
  }
  logResult(result);
  return result;
}

// One place to say what each state means operationally, so the log line and
// the behaviour can't drift apart.
function logResult(result: FoundingOfferResult): void {
  switch (result.status) {
    case "available":
      return;
    case "exhausted":
      console.warn(
        "getFoundingOffer: founding coupon is fully redeemed — founding block hidden and checkout will sell at list price. SOLD OUT, working as intended."
      );
      return;
    case "misconfigured":
      console.error(
        `getFoundingOffer: founding coupon is MISCONFIGURED — founding block hidden and checkout will sell at LIST PRICE (an alert is sent from the checkout route). This does not fix itself: ${result.reason}`
      );
      return;
    case "unknown":
      console.error(
        `getFoundingOffer: could not determine founding coupon state — founding block hidden and checkout will REFUSE the sale until this clears. Not sold out, may resolve on retry: ${result.reason}`
      );
      return;
  }
}

export async function getFoundingOffer(): Promise<FoundingOffer | null> {
  return offerFromResult(await resolveFoundingOffer());
}

// For callers where treating "couldn't tell" the same as "sold out" would be
// a bug (i.e. checkout — see app/api/stripe/checkout/route.ts). Pricing-page
// display doesn't need the distinction and should keep using getFoundingOffer.
export async function getFoundingOfferResult(): Promise<FoundingOfferResult> {
  return resolveFoundingOffer();
}
