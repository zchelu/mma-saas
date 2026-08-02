/// <reference types="vite/client" />
// Regression tests for the founding-coupon state machine.
//
// THE BUG THESE EXIST FOR (reproduced in test mode 2026-08-01): Stripe sets
// coupon.valid=false the instant a coupon is fully redeemed. The old code
// tested !valid before comparing times_redeemed to max_redemptions, so a
// sold-out coupon was classified as broken rather than exhausted, and checkout
// returned 503. /pricing meanwhile correctly dropped the founding block — so
// the page said "no discount here, buy at list price" while the buy button
// was hard-failing. The founding program selling out would have stopped every
// sale on the site, including from buyers happy to pay full price.
//
// These run against the pure policy module — no network, no Stripe client, no
// next/cache. The companion file foundingOfferStripe.test.ts exercises the
// same three states against real Stripe test-mode coupons and asserts on
// session objects read back from the API.
import { describe, expect, test } from "vitest";
import type Stripe from "stripe";
import { shouldDeliverOutageAlert } from "./alerts";
import {
  classifyCoupon,
  classifyCouponError,
  offerFromResult,
  planCheckout,
  type FoundingOfferResult,
} from "./foundingOfferPolicy";

// Minimal Stripe.Coupon good enough for classifyCoupon. Amounts stay derived
// from whatever the test passes in — nothing here hardcodes the live $50.
function coupon(over: Partial<Stripe.Coupon> = {}): Stripe.Coupon {
  return {
    id: "founding-test",
    object: "coupon",
    amount_off: 5000,
    created: 0,
    currency: "usd",
    duration: "repeating",
    duration_in_months: 25,
    livemode: false,
    max_redemptions: 5,
    metadata: {},
    name: null,
    percent_off: null,
    redeem_by: null,
    times_redeemed: 0,
    valid: true,
    ...over,
  } as Stripe.Coupon;
}

// The shape classifyCouponError produces for a revoked/rolled Stripe key —
// the case the outage alert exists for.
const UNKNOWN: FoundingOfferResult = {
  status: "unknown",
  couponId: "founding-5-gyms-50off",
  reason: "failed to retrieve Stripe coupon founding-5-gyms-50off: Invalid API Key",
  errorType: "StripeAuthenticationError",
  statusCode: 401,
};

describe("classifyCoupon", () => {
  test("a live coupon with slots left is available, with the amount read off Stripe", () => {
    const result = classifyCoupon(coupon({ amount_off: 5000, max_redemptions: 5, times_redeemed: 1 }), "c_1");
    expect(result).toEqual({
      status: "available",
      offer: { amountOffCents: 5000, slotsLeft: 4, couponId: "c_1" },
    });
  });

  test("the discount amount is never assumed — a different amount_off flows straight through", () => {
    const result = classifyCoupon(coupon({ amount_off: 7500 }), "c_1");
    expect(offerFromResult(result)?.amountOffCents).toBe(7500);
  });

  test("an unlimited coupon reports slotsLeft null rather than a number", () => {
    const result = classifyCoupon(coupon({ max_redemptions: null }), "c_1");
    expect(offerFromResult(result)?.slotsLeft).toBeNull();
  });

  // The regression. Stripe sends BOTH signals at once on a sold-out coupon.
  test("REGRESSION: fully redeemed AND valid=false is exhausted, not misconfigured", () => {
    const soldOut = coupon({ max_redemptions: 5, times_redeemed: 5, valid: false });
    expect(classifyCoupon(soldOut, "c_1")).toEqual({ status: "exhausted" });
  });

  test("REGRESSION: the exact 1/1 shape reproduced against Stripe classifies as exhausted", () => {
    const soldOut = coupon({ max_redemptions: 1, times_redeemed: 1, valid: false });
    expect(classifyCoupon(soldOut, "sim-exhausted-50off").status).toBe("exhausted");
  });

  test("over-redemption (times_redeemed past the cap) still counts as exhausted", () => {
    expect(classifyCoupon(coupon({ max_redemptions: 5, times_redeemed: 6 }), "c_1").status).toBe(
      "exhausted"
    );
  });

  test("valid=false while slots remain is misconfigured, not exhausted", () => {
    const result = classifyCoupon(coupon({ max_redemptions: 5, times_redeemed: 0, valid: false }), "c_1");
    expect(result.status).toBe("misconfigured");
  });

  test("a deleted coupon is misconfigured", () => {
    const deleted = { id: "c_1", object: "coupon", deleted: true } as Stripe.DeletedCoupon;
    const result = classifyCoupon(deleted, "c_1");
    expect(result.status).toBe("misconfigured");
    expect(result).toMatchObject({ couponId: "c_1" });
  });

  test("a percent_off coupon is misconfigured — this program renders fixed amounts only", () => {
    const result = classifyCoupon(coupon({ amount_off: null, percent_off: 25 }), "c_1");
    expect(result.status).toBe("misconfigured");
  });
});

describe("classifyCouponError", () => {
  test("a 404 resource_missing (typo'd id, deleted, wrong key mode) is misconfigured", () => {
    const err = Object.assign(new Error("No such coupon: 'founding-5-gyms-50of'"), {
      code: "resource_missing",
      statusCode: 404,
    });
    const result = classifyCouponError(err, "founding-5-gyms-50of");
    expect(result.status).toBe("misconfigured");
    expect(result).toMatchObject({ couponId: "founding-5-gyms-50of" });
  });

  // Captured off a real StripeAuthenticationError on 2026-08-01: the alert has
  // to name the class and status or a revoked key is undiagnosable from email.
  test("a revoked key carries the Stripe error class and status through to the alert", () => {
    const err = Object.assign(new Error("Invalid API Key provided: sk_live_***"), {
      type: "StripeAuthenticationError",
      statusCode: 401,
    });
    const result = classifyCouponError(err, "founding-5-gyms-50off");
    expect(result).toMatchObject({
      status: "unknown",
      couponId: "founding-5-gyms-50off",
      errorType: "StripeAuthenticationError",
      statusCode: 401,
    });
  });

  test("a bare network failure still names a class, and omits statusCode", () => {
    const result = classifyCouponError(new Error("ECONNRESET"), "c_1");
    expect(result).toMatchObject({ status: "unknown", errorType: "Error" });
    expect(result).not.toHaveProperty("statusCode");
  });

  test("a bare 404 with no code is still misconfigured", () => {
    const result = classifyCouponError(Object.assign(new Error("nope"), { statusCode: 404 }), "c_1");
    expect(result.status).toBe("misconfigured");
  });

  test("a network failure is unknown — it may resolve on retry", () => {
    expect(classifyCouponError(new Error("ECONNRESET"), "c_1").status).toBe("unknown");
  });

  test("a rate limit is unknown, NOT misconfigured", () => {
    const err = Object.assign(new Error("Too many requests"), { code: "rate_limit", statusCode: 429 });
    expect(classifyCouponError(err, "c_1").status).toBe("unknown");
  });

  test("a Stripe 500 is unknown, NOT misconfigured", () => {
    const err = Object.assign(new Error("api error"), { statusCode: 500 });
    expect(classifyCouponError(err, "c_1").status).toBe("unknown");
  });
});

describe("planCheckout", () => {
  test("available -> attach the coupon", () => {
    const result: FoundingOfferResult = {
      status: "available",
      offer: { amountOffCents: 5000, slotsLeft: 4, couponId: "c_1" },
    };
    expect(planCheckout(result)).toEqual({ proceed: true, couponId: "c_1", alert: null });
  });

  // The fix, stated as behaviour: selling out must not stop sales.
  test("REGRESSION: exhausted -> proceed at list price, no discount, no alert", () => {
    expect(planCheckout({ status: "exhausted" })).toEqual({
      proceed: true,
      couponId: null,
      alert: null,
    });
  });

  test("misconfigured -> proceed at list price AND alert", () => {
    const plan = planCheckout({ status: "misconfigured", couponId: "typo", reason: "404" });
    expect(plan.proceed).toBe(true);
    expect(plan.couponId).toBeNull();
    expect(plan.alert).toEqual({ kind: "misconfigured", couponId: "typo", reason: "404" });
  });

  test("unknown -> refuse. This guard must NOT be downgraded", () => {
    const plan = planCheckout(UNKNOWN);
    expect(plan.proceed).toBe(false);
    expect(plan.couponId).toBeNull();
  });

  // REGRESSION: the last silent failure in the design. A revoked Stripe key
  // 503s every checkout indefinitely while /pricing stays up looking healthy;
  // before this, nothing anywhere reported it until a customer complained.
  test("REGRESSION: unknown alerts AND still refuses the sale", () => {
    const plan = planCheckout(UNKNOWN);

    expect(plan.proceed).toBe(false); // still 503 — the refusal is not traded away
    expect(plan.alert).toEqual({
      kind: "outage",
      couponId: "founding-5-gyms-50off",
      reason: "failed to retrieve Stripe coupon founding-5-gyms-50off: Invalid API Key",
      errorType: "StripeAuthenticationError",
      statusCode: 401,
    });
  });

  test("the outage alert is a different kind from the misconfigured one", () => {
    expect(planCheckout(UNKNOWN).alert?.kind).toBe("outage");
    expect(
      planCheckout({ status: "misconfigured", couponId: "typo", reason: "404" }).alert?.kind
    ).toBe("misconfigured");
  });

  // The gate is a DELIVERY concern, not a policy one — planCheckout stays pure
  // and env-blind, and the route decides whether the intent becomes an email.
  // Preview has no Stripe key by design, so every preview checkout would
  // otherwise page "CHECKOUT IS DOWN" about intended behavior.
  test("REGRESSION: outage intent is env-blind; only delivery is gated", () => {
    const plan = planCheckout(UNKNOWN);

    // Unchanged in every environment: still refuses, still emits the intent.
    expect(plan.proceed).toBe(false);
    expect(plan.alert?.kind).toBe("outage");

    // Only the send is suppressed.
    expect(shouldDeliverOutageAlert("production")).toBe(true);
    expect(shouldDeliverOutageAlert("preview")).toBe(false);
    expect(shouldDeliverOutageAlert("development")).toBe(false);
    expect(shouldDeliverOutageAlert(undefined)).toBe(false);
  });

  test("an unknown with no statusCode still alerts", () => {
    const plan = planCheckout({
      status: "unknown",
      couponId: "c_1",
      reason: "ECONNRESET",
      errorType: "Error",
    });
    expect(plan.proceed).toBe(false);
    expect(plan.alert?.kind).toBe("outage");
    expect(plan.alert).not.toHaveProperty("statusCode");
  });
});

describe("INVARIANT: /pricing and checkout agree about the founding offer", () => {
  const everyState: FoundingOfferResult[] = [
    { status: "available", offer: { amountOffCents: 5000, slotsLeft: 4, couponId: "c_1" } },
    { status: "exhausted" },
    { status: "misconfigured", couponId: "typo", reason: "404 resource_missing" },
    { status: "misconfigured", couponId: null, reason: "env var not set" },
    UNKNOWN,
  ];

  // The core contract: checkout attaches a discount if and only if /pricing
  // was advertising one. Never charge list price to someone who was promised a
  // discount; never fail a sale for someone who wasn't.
  test.each(everyState)("$status: discount attached iff founding block shown", (result) => {
    const shownOnPricing = offerFromResult(result) !== null;
    const attachedAtCheckout = planCheckout(result).couponId !== null;
    expect(attachedAtCheckout).toBe(shownOnPricing);
  });

  test.each(everyState)("$status: the coupon id matches on both sides", (result) => {
    expect(planCheckout(result).couponId).toBe(offerFromResult(result)?.couponId ?? null);
  });

  // Restates the bug as a guarantee: hiding the block never breaks the sale,
  // except in the one state where we genuinely cannot tell what's being shown.
  test.each(everyState)("$status: only 'unknown' may refuse the sale", (result) => {
    if (result.status === "unknown") expect(planCheckout(result).proceed).toBe(false);
    else expect(planCheckout(result).proceed).toBe(true);
  });

  // Every state that is not a healthy offer or an intended sellout is now
  // reported. "available" and "exhausted" are the only two silent states, and
  // both are silent because they are working as designed.
  test.each(everyState)("$status: an alert fires unless the state is normal", (result) => {
    const isNormal = result.status === "available" || result.status === "exhausted";
    expect(planCheckout(result).alert !== null).toBe(!isNormal);
  });

  test.each(everyState)("$status: a refused sale is never silent", (result) => {
    const plan = planCheckout(result);
    if (!plan.proceed) expect(plan.alert).not.toBeNull();
  });
});
