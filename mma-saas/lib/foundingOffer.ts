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
