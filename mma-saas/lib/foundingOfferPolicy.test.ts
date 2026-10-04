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
  classifyFoundingProgram,
  FOUNDING_COUPON_ENV,
  FOUNDING_PLANS,
  FOUNDING_PRICE_USD,
  FOUNDING_SPOTS,
  LIST_PRICE_CHECKOUT,
  missingApiKeyResult,
  MISSING_API_KEY,
  offerFromResult,
  offerResultForPlan,
  planCheckout,
  programFromResult,
  type FoundingCouponLookup,
  type FoundingOfferResult,
  type FoundingProgramResult,
} from "./foundingOfferPolicy";
import { PLAN_PRICE_USD, type PlanSlug } from "./plans";
import { PRICING_TIERS } from "../app/pricing/tiers";

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

  // REGRESSION: new Stripe(undefined!) threw synchronously above the route's
  // try/catch, so an absent STRIPE_SECRET_KEY produced a raw 500 with a stack
  // trace, no 503, and no alert — a silent outage. Live-verified 2026-08-01
  // against a stripped env before the fix.
  describe("REGRESSION: absent STRIPE_SECRET_KEY", () => {
    test("routes through unknown -> 503 + outage alert intent", () => {
      const result = missingApiKeyResult("founding-5-gyms-50off");
      expect(result.status).toBe("unknown");

      const plan = planCheckout(result);
      expect(plan.proceed).toBe(false); // 503, not a thrown 500
      expect(plan.alert?.kind).toBe("outage"); // and it is not silent
    });

    test("carries the missing-key status, distinct from a rejected key", () => {
      const absent = missingApiKeyResult("c_1");
      const rejected = classifyCouponError(
        Object.assign(new Error("Invalid API Key provided"), {
          type: "StripeAuthenticationError",
          statusCode: 401,
        }),
        "c_1"
      );

      expect(absent).toMatchObject({ errorType: MISSING_API_KEY });
      // No HTTP status: no key means no request was ever made to have one.
      expect(absent).not.toHaveProperty("statusCode");

      // Both are "unknown", but an operator must be able to tell them apart —
      // rotate a rejected key vs. set an absent one.
      expect(rejected.status).toBe(absent.status);
      expect((rejected as { errorType: string }).errorType).not.toBe(MISSING_API_KEY);
      expect(rejected).toMatchObject({ statusCode: 401 });
    });

    test("no stack trace or raw error text reaches the alert payload", () => {
      const alert = planCheckout(missingApiKeyResult("c_1")).alert;
      const serialized = JSON.stringify(alert);
      expect(serialized).not.toMatch(/\bat\s+\w+\s*\(/); // no "at fn (file:line)"
      expect(serialized).not.toMatch(/node_modules|\.ts:\d+/);
      // Names the variable to fix, without echoing its value anywhere.
      expect(serialized).toContain("STRIPE_SECRET_KEY is not set");
    });

    test("still produces a usable alert when the coupon id is unset too", () => {
      const plan = planCheckout(missingApiKeyResult(undefined));
      expect(plan.proceed).toBe(false);
      expect(plan.alert?.kind).toBe("outage");
      expect(plan.alert?.couponId).toContain("not set");
    });
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

// ---------------------------------------------------------------------------
// THE FOUNDING PROGRAM (2026-10-03): flat founding prices, locked for life.
//
// One coupon per tier instead of one coupon for everything, because
// $50 / $130 / $200 against $99 / $179 / $299 is not one uniform discount.
// What these pin down is the promise /founding prints: the price on the card
// is the price Stripe charges, it never expires, and there are five spots in
// total no matter how they are split across tiers.
// ---------------------------------------------------------------------------

// A coupon that keeps the promise: fixed amount, usd, forever, room for all
// five. Tests override one field at a time to break exactly one rule.
function lifeCoupon(amountOff: number, over: Partial<Stripe.Coupon> = {}): Stripe.Coupon {
  return coupon({
    amount_off: amountOff,
    duration: "forever",
    duration_in_months: null,
    max_redemptions: FOUNDING_SPOTS,
    ...over,
  });
}

// The recommended live setup: Academy and Fight Team share the $49 coupon,
// Black Belt has its own $99 one.
function lookups(
  over: Partial<Record<PlanSlug, FoundingCouponLookup>> = {}
): Record<PlanSlug, FoundingCouponLookup> {
  return {
    academy: { couponId: "life-49", coupon: lifeCoupon(4900) },
    fightteam: { couponId: "life-49", coupon: lifeCoupon(4900) },
    blackbelt: { couponId: "life-99", coupon: lifeCoupon(9900) },
    ...over,
  };
}

describe("classifyFoundingProgram", () => {
  test("the live setup is available, and every tier lands on its founding price", () => {
    const program = programFromResult(classifyFoundingProgram(lookups()));
    expect(program).not.toBeNull();
    expect(program!.slotsLeft).toBe(FOUNDING_SPOTS);
    for (const plan of FOUNDING_PLANS) {
      const charged = PLAN_PRICE_USD[plan] - program!.offers[plan].amountOffCents / 100;
      expect(charged).toBe(FOUNDING_PRICE_USD[plan]);
    }
    expect(FOUNDING_PRICE_USD).toEqual({ academy: 50, fightteam: 130, blackbelt: 200 });
  });

  test("each tier attaches its OWN coupon", () => {
    const program = programFromResult(classifyFoundingProgram(lookups()))!;
    expect(program.offers.academy.couponId).toBe("life-49");
    expect(program.offers.fightteam.couponId).toBe("life-49");
    expect(program.offers.blackbelt.couponId).toBe("life-99");
  });

  test("spots are counted across coupons, and a shared coupon is counted once", () => {
    const shared = lifeCoupon(4900, { times_redeemed: 2 });
    const result = classifyFoundingProgram(
      lookups({
        academy: { couponId: "life-49", coupon: shared },
        fightteam: { couponId: "life-49", coupon: shared },
        blackbelt: { couponId: "life-99", coupon: lifeCoupon(9900, { times_redeemed: 1 }) },
      })
    );
    // 2 + 1, not 2 + 2 + 1.
    expect(programFromResult(result)?.slotsLeft).toBe(2);
    // Every tier reports the PROGRAM's remaining spots, not its coupon's.
    expect(programFromResult(result)?.offers.blackbelt.slotsLeft).toBe(2);
  });

  test("five gyms split across tiers is sold out, though no single coupon is full", () => {
    const result = classifyFoundingProgram(
      lookups({
        academy: { couponId: "life-49", coupon: lifeCoupon(4900, { times_redeemed: 3 }) },
        fightteam: { couponId: "life-49", coupon: lifeCoupon(4900, { times_redeemed: 3 }) },
        blackbelt: { couponId: "life-99", coupon: lifeCoupon(9900, { times_redeemed: 2 }) },
      })
    );
    expect(result).toEqual({ status: "exhausted" });
  });

  // The same Stripe behaviour the original regression was about: a full coupon
  // arrives with valid=false, and that must read as sold out, not broken.
  test("REGRESSION: a full coupon with valid=false is exhausted, not misconfigured", () => {
    const full = lifeCoupon(4900, { times_redeemed: 5, valid: false });
    const result = classifyFoundingProgram(
      lookups({
        academy: { couponId: "life-49", coupon: full },
        fightteam: { couponId: "life-49", coupon: full },
      })
    );
    expect(result).toEqual({ status: "exhausted" });
  });

  // "Locked for life" is the headline of /founding. The retired program's
  // coupon ran 25 months; pointing a var at it must not print "for life".
  test("a coupon that ends is misconfigured — 'locked for life' needs duration=forever", () => {
    const result = classifyFoundingProgram(
      lookups({
        blackbelt: {
          couponId: "ends",
          coupon: lifeCoupon(9900, { duration: "repeating", duration_in_months: 25 }),
        },
      })
    );
    expect(result.status).toBe("misconfigured");
    expect(result).toMatchObject({ couponId: "ends" });
    expect((result as { reason: string }).reason).toContain("forever");
  });

  test("a coupon whose amount misses the founding price is misconfigured", () => {
    // The OLD founding coupon amount: $50 off Academy would be $49, not $50.
    const result = classifyFoundingProgram(
      lookups({ academy: { couponId: "old-50", coupon: lifeCoupon(5000) } })
    );
    expect(result.status).toBe("misconfigured");
    expect((result as { reason: string }).reason).toContain("$50/mo");
  });

  test("a coupon too small to hold every spot is misconfigured", () => {
    const result = classifyFoundingProgram(
      lookups({ blackbelt: { couponId: "small", coupon: lifeCoupon(9900, { max_redemptions: 2 }) } })
    );
    expect(result.status).toBe("misconfigured");
  });

  test("one tier's env var unset hides the WHOLE program and names the variable", () => {
    const result = classifyFoundingProgram(lookups({ fightteam: { couponId: null } }));
    expect(result).toMatchObject({ status: "misconfigured", couponId: null });
    expect((result as { reason: string }).reason).toContain(FOUNDING_COUPON_ENV.fightteam);
  });

  // The state the code ships in: no coupons created yet. /founding must not
  // exist and nothing may be attached.
  test("nothing configured -> misconfigured, so /founding is hidden", () => {
    const none = { couponId: null } as const;
    const result = classifyFoundingProgram({ academy: none, fightteam: none, blackbelt: none });
    expect(result.status).toBe("misconfigured");
    expect(programFromResult(result)).toBeNull();
  });

  test("a deleted or percent-off coupon is misconfigured", () => {
    const deleted = { id: "gone", object: "coupon", deleted: true } as Stripe.DeletedCoupon;
    expect(
      classifyFoundingProgram(lookups({ academy: { couponId: "gone", coupon: deleted } })).status
    ).toBe("misconfigured");
    expect(
      classifyFoundingProgram(
        lookups({
          academy: { couponId: "pct", coupon: lifeCoupon(4900, { amount_off: null, percent_off: 50 }) },
        })
      ).status
    ).toBe("misconfigured");
  });

  test("a typo'd coupon id (404) is misconfigured; an unreachable Stripe is unknown", () => {
    const notFound = Object.assign(new Error("No such coupon"), {
      code: "resource_missing",
      statusCode: 404,
    });
    expect(
      classifyFoundingProgram(lookups({ academy: { couponId: "typo", error: notFound } })).status
    ).toBe("misconfigured");
    expect(
      classifyFoundingProgram(lookups({ academy: { couponId: "life-49", error: new Error("ECONNRESET") } }))
        .status
    ).toBe("unknown");
  });

  // With one tier deterministically broken the program cannot be shown whatever
  // the unreachable coupon turns out to be — so we DO know what /founding is
  // showing, and that is the state that keeps selling at list price.
  test("a deterministic break outranks an unreachable coupon", () => {
    const result = classifyFoundingProgram(
      lookups({
        academy: { couponId: "life-49", error: new Error("ECONNRESET") },
        blackbelt: { couponId: null },
      })
    );
    expect(result.status).toBe("misconfigured");
  });
});

describe("INVARIANT: /founding and checkout agree, tier by tier", () => {
  const notFound = Object.assign(new Error("No such coupon"), { code: "resource_missing", statusCode: 404 });
  const everyProgramState: [string, FoundingProgramResult][] = [
    ["available", classifyFoundingProgram(lookups())],
    [
      "exhausted",
      classifyFoundingProgram(
        lookups({ blackbelt: { couponId: "life-99", coupon: lifeCoupon(9900, { times_redeemed: 5 }) } })
      ),
    ],
    ["misconfigured (unset)", classifyFoundingProgram(lookups({ academy: { couponId: null } }))],
    ["misconfigured (404)", classifyFoundingProgram(lookups({ academy: { couponId: "typo", error: notFound } }))],
    ["unknown", classifyFoundingProgram(lookups({ academy: { couponId: "life-49", error: new Error("ECONNRESET") } }))],
  ];

  test("the fixture really covers all four states", () => {
    expect(new Set(everyProgramState.map(([, r]) => r.status))).toEqual(
      new Set(["available", "exhausted", "misconfigured", "unknown"])
    );
  });

  describe.each(everyProgramState)("%s", (_label, result) => {
    test.each([...FOUNDING_PLANS])("%s: coupon attached iff /founding is showing", (plan) => {
      const shownOnFounding = programFromResult(result) !== null;
      const checkout = planCheckout(offerResultForPlan(result, plan));
      expect(checkout.couponId !== null).toBe(shownOnFounding);
      expect(checkout.couponId).toBe(programFromResult(result)?.offers[plan].couponId ?? null);
    });

    test.each([...FOUNDING_PLANS])("%s: only 'unknown' may refuse the sale", (plan) => {
      const checkout = planCheckout(offerResultForPlan(result, plan));
      expect(checkout.proceed).toBe(result.status !== "unknown");
      if (!checkout.proceed) expect(checkout.alert).not.toBeNull();
    });
  });

  // A buyer who came in through /pricing never asked for a founding price.
  // Nothing is looked up for them, so no coupon state can discount, refuse or
  // alert on their sale.
  test("a list-price buyer proceeds with no coupon and no alert, whatever the coupons are doing", () => {
    expect(LIST_PRICE_CHECKOUT).toEqual({ proceed: true, couponId: null, alert: null });
  });
});

// app/pricing/tiers.ts (what /pricing and /founding print) and
// lib/plans.ts:PLAN_PRICE_USD (what the wizard discloses and the founding
// price is computed from) are two separate price tables. The wizard's own
// comment admits they are "kept in step by nothing but attention". /founding
// now strikes one through next to a price derived from the other, so a
// mismatch would put two different list prices on one card.
describe("the two list-price tables agree", () => {
  test.each(PRICING_TIERS.map((t) => [t.slug, t.price] as const))(
    "%s: tiers.ts price matches PLAN_PRICE_USD",
    (slug, price) => {
      expect(PLAN_PRICE_USD[slug]).toBe(price);
    }
  );

  test("every founding plan has a card, and every card has a founding price", () => {
    expect(PRICING_TIERS.map((t) => t.slug).sort()).toEqual([...FOUNDING_PLANS].sort());
  });
});
