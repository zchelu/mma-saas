import type Stripe from "stripe";

// Pure classification + decision logic for the founding coupon, split out of
// lib/foundingOffer.ts so it can be unit-tested without pulling in next/cache
// or constructing a Stripe client. Nothing in this file does I/O or reads
// process.env; `import type Stripe` is erased at compile time, so this module
// has no runtime imports at all.
//
// THE INVARIANT THIS FILE ENCODES:
// /pricing and checkout must agree about whether a founding offer exists.
// Any state where /pricing hides the founding block is a state where nobody is
// being promised a discount — so checkout proceeds at LIST PRICE. The only
// state that may refuse the sale is one where we genuinely cannot tell what
// /pricing is showing, because a retry might resolve it.
//
// offerFromResult() and planCheckout() are the two sides of that agreement,
// and lib/foundingOfferPolicy.test.ts asserts they never disagree.

// slotsLeft: null means the coupon has no max_redemptions (unlimited) — not
// Infinity, which doesn't survive the cache serialization in lib/foundingOffer.
export type FoundingOffer = { amountOffCents: number; slotsLeft: number | null; couponId: string };

// Four states, and the distinction between the last two is the whole point:
//
//   available     — offer is live. /pricing advertises it, checkout attaches it.
//   exhausted     — genuinely sold out. Normal end-of-program state, not an
//                   error. /pricing hides the block, checkout sells at list.
//   misconfigured — deterministically broken in a way a retry will not fix
//                   (bad/deleted coupon id, test/live key mismatch, unset env
//                   var, percent_off coupon). /pricing hides the block, so
//                   nobody was promised anything: checkout sells at list price
//                   rather than taking revenue to zero — but it also shouts,
//                   because this is never a state we meant to be in.
//   unknown       — we could not reach Stripe, or Stripe failed in a way that
//                   may resolve on retry. We cannot tell what /pricing is
//                   showing other visitors right now, so this is the one state
//                   that refuses the sale (503) instead of guessing.
//
// Previously "exhausted" and every failure mode collapsed into a single
// "unavailable" status that checkout treated as 503. Because Stripe flips
// coupon.valid to false the instant a coupon is fully redeemed, a normal
// sell-out was indistinguishable from a misconfiguration, and selling out took
// checkout down for everyone — including buyers happy to pay list price.
export type FoundingOfferResult =
  | { status: "available"; offer: FoundingOffer }
  | { status: "exhausted" }
  | { status: "misconfigured"; couponId: string | null; reason: string }
  | { status: "unknown"; reason: string };

export function classifyCoupon(
  coupon: Stripe.Coupon | Stripe.DeletedCoupon,
  couponId: string
): FoundingOfferResult {
  if ("deleted" in coupon && coupon.deleted) {
    return {
      status: "misconfigured",
      couponId,
      reason: `coupon ${couponId} is deleted in Stripe`,
    };
  }

  const live = coupon as Stripe.Coupon;

  // THIS CHECK MUST STAY ABOVE THE !valid CHECK BELOW. Stripe sets
  // valid=false the moment times_redeemed reaches max_redemptions, so if
  // !valid is tested first, a sold-out coupon is misread as broken and the
  // "exhausted" branch becomes unreachable through the normal sell-out path.
  // That was the bug: reproduced 2026-08-01 in test mode against a 1/1
  // coupon — /pricing correctly dropped the founding block while checkout
  // returned 503, so the program selling out would have stopped every sale.
  if (live.max_redemptions != null && live.times_redeemed >= live.max_redemptions) {
    return { status: "exhausted" };
  }

  // Reached only for a coupon Stripe considers unusable for some reason OTHER
  // than exhaustion — most plausibly an expired redeem_by. No redeem_by is set
  // on the founding coupon today, so arriving here means the coupon is not in
  // the shape this program assumes: sell at list price, and say so out loud.
  if (!live.valid) {
    return {
      status: "misconfigured",
      couponId,
      reason: `coupon ${couponId} reports valid=false and is not exhausted (${live.times_redeemed}/${live.max_redemptions ?? "unlimited"} redemptions) — most likely expired via redeem_by`,
    };
  }

  // This page and the checkout math render a fixed-amount discount only; a
  // percent_off coupon would render "$undefined off". Config error, not a
  // sellout.
  if (live.amount_off == null) {
    return {
      status: "misconfigured",
      couponId,
      reason: `coupon ${couponId} has no amount_off (percent_off=${live.percent_off}) — this program renders fixed-amount coupons only`,
    };
  }

  const slotsLeft =
    live.max_redemptions != null ? live.max_redemptions - live.times_redeemed : null;

  return {
    status: "available",
    offer: { amountOffCents: live.amount_off, slotsLeft, couponId },
  };
}

// Splits a Stripe failure into "the coupon definitively isn't there" (a
// deterministic config error — a typo'd id, a deleted coupon, or a test/live
// key mismatch, all of which surface as 404 resource_missing) versus anything
// else (network, rate limit, 5xx, auth), which may resolve on retry.
export function classifyCouponError(err: unknown, couponId: string): FoundingOfferResult {
  if (isMissingResourceError(err)) {
    return {
      status: "misconfigured",
      couponId,
      reason: `Stripe has no coupon "${couponId}" (404 resource_missing) — either the id is wrong or STRIPE_SECRET_KEY is in the other mode from the coupon`,
    };
  }
  return {
    status: "unknown",
    reason: `failed to retrieve Stripe coupon ${couponId}: ${err instanceof Error ? err.message : String(err)}`,
  };
}

// Duck-typed rather than `instanceof Stripe.errors.StripeInvalidRequestError`
// so this module keeps its zero runtime imports. Both fields are present on
// Stripe SDK errors; checking either keeps this working if one is ever absent.
function isMissingResourceError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; statusCode?: unknown };
  return e.code === "resource_missing" || e.statusCode === 404;
}

// What /pricing sees. Any non-available state hides the founding block.
export function offerFromResult(result: FoundingOfferResult): FoundingOffer | null {
  return result.status === "available" ? result.offer : null;
}

export type CheckoutPlan = {
  // false => refuse the sale (503). Only ever set for status "unknown".
  proceed: boolean;
  // The coupon to attach, or null to sell at list price.
  couponId: string | null;
  // Non-null => fire the misconfiguration alert before proceeding.
  alert: { couponId: string | null; reason: string } | null;
};

// The checkout side of the invariant. Note that `couponId` is non-null in
// exactly the states where offerFromResult() is non-null — i.e. checkout
// attaches a discount if and only if /pricing was advertising one.
//
// The refusal for "unknown" is deliberate and must stay: it stops us silently
// charging list price to someone /pricing may have just promised a discount.
// The bug was never that the guard existed, only that it could not tell "sold
// out" from "misconfigured" and applied the strict behaviour to both.
export function planCheckout(result: FoundingOfferResult): CheckoutPlan {
  switch (result.status) {
    case "available":
      return { proceed: true, couponId: result.offer.couponId, alert: null };
    case "exhausted":
      return { proceed: true, couponId: null, alert: null };
    case "misconfigured":
      return {
        proceed: true,
        couponId: null,
        alert: { couponId: result.couponId, reason: result.reason },
      };
    case "unknown":
      return { proceed: false, couponId: null, alert: null };
  }
}
