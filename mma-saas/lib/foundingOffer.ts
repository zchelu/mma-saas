import Stripe from "stripe";
import { unstable_cache } from "next/cache";

// Split out of lib/plans.ts: convex/subscriptions.ts, convex/sendRetentionTexts.ts,
// and convex/stripeWebhookAction.ts import from lib/plans.ts, and Convex bundles
// by static import analysis — the stripe/next/cache imports and the
// unstable_cache(...) module-scope call below would otherwise get pulled into
// the Convex bundle on deploy even though no Convex function uses them.
// lib/plans.ts must stay free of Next/Stripe imports; this file is imported
// only from app/* (Next.js runtime), never from convex/*.

// slotsLeft: null means the coupon has no max_redemptions (unlimited) — not
// Infinity, which doesn't survive the cache serialization below.
export type FoundingOffer = { amountOffCents: number; slotsLeft: number | null; couponId: string };

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
// DELIBERATE MISMATCH — do not "fix": the coupon behind
// STRIPE_FOUNDING_COUPON_ID is configured with duration_in_months=25, not 24.
// A coupon's duration clock starts when it attaches to the subscription (at
// Checkout Session creation, i.e. when the 30-day trial starts), not at first
// charge — so the trial consumes the first coupon-month. 25 coupon-months
// therefore delivers exactly 24 months of actually-discounted billing. 25 is
// a backend implementation detail only; every customer-facing surface (the
// /pricing founding block, any future copy) must say 24 months. Never
// surface 25 in UI copy.
export async function getFoundingOffer(): Promise<FoundingOffer | null> {
  const couponId = process.env.STRIPE_FOUNDING_COUPON_ID;
  if (!couponId) return null;

  try {
    const coupon = await getCachedCoupon(couponId);

    if ("deleted" in coupon) return null;
    if (!coupon.valid) return null;
    if (coupon.max_redemptions != null && coupon.times_redeemed >= coupon.max_redemptions) {
      return null;
    }
    if (coupon.amount_off == null) return null;

    const slotsLeft =
      coupon.max_redemptions != null ? coupon.max_redemptions - coupon.times_redeemed : null;

    return { amountOffCents: coupon.amount_off, slotsLeft, couponId };
  } catch (err) {
    console.error("getFoundingOffer: failed to retrieve Stripe coupon:", err);
    return null;
  }
}
