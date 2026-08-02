/// <reference types="vite/client" />
// Integration half of the founding-coupon regression suite. Unlike
// foundingOfferPolicy.test.ts, this one talks to REAL Stripe test mode and
// asserts on Checkout Session objects read back from the API, not on mocks —
// because the bug it guards was a disagreement with Stripe's actual behaviour
// (Stripe flips coupon.valid to false on exhaustion), which no mock would have
// caught.
//
// SAFETY: refuses to run against anything but an sk_test_ key, so it can never
// create objects in live mode. Skips itself entirely when no test key is
// present (CI without secrets), so `npm run test:once` stays green offline.
//
// Creating a Checkout Session does NOT redeem a coupon — only a completed
// subscription does — so the sessions below are free to create and never burn
// a founding slot.
import { beforeAll, describe, expect, test } from "vitest";
import {
  classifyCoupon,
  classifyCouponError,
  offerFromResult,
  planCheckout,
} from "./foundingOfferPolicy";

const KEY = process.env.STRIPE_SECRET_KEY;
const PRICE = process.env.STRIPE_PRO_PRICE_ID;
const LIVE = !!KEY && !KEY.startsWith("sk_test_");
const RUN = !!KEY && !LIVE && !!PRICE;

const VALID_COUPON = "test-founding-valid-50off";
const EXHAUSTED_COUPON = "test-founding-exhausted";
const MISSING_COUPON = "test-founding-does-not-exist-xyz";

// Flattens nested objects/arrays into Stripe's bracket form-encoding
// (items[0][price]=...). Raw fetch rather than the SDK so this works unchanged
// under the edge-runtime test environment.
function form(obj: Record<string, unknown>, prefix = ""): string[] {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (typeof item === "object") parts.push(...form(item as Record<string, unknown>, `${key}[${i}]`));
        else parts.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`);
      });
    } else if (typeof v === "object") {
      parts.push(...form(v as Record<string, unknown>, key));
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts;
}

// Throws an error carrying `code` and `statusCode`, matching the shape the
// Stripe SDK raises — verified against a real StripeInvalidRequestError logged
// on 2026-08-01: { code: 'resource_missing', statusCode: 404 }.
async function stripeApi<T>(
  path: string,
  body?: Record<string, unknown>,
  method: "GET" | "POST" = body ? "POST" : "GET"
): Promise<T> {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    ...(body ? { body: form(body).join("&") } : {}),
  });
  const json = (await res.json()) as { error?: { message?: string; code?: string } };
  if (!res.ok) {
    throw Object.assign(new Error(json.error?.message ?? `HTTP ${res.status}`), {
      code: json.error?.code,
      statusCode: res.status,
    });
  }
  return json as T;
}

type Coupon = {
  id: string;
  amount_off: number | null;
  max_redemptions: number | null;
  times_redeemed: number;
  valid: boolean;
  deleted?: boolean;
};
type Session = {
  id: string;
  amount_total: number;
  amount_subtotal: number;
  discounts?: { coupon: string | null; promotion_code: string | null }[];
  total_details?: { amount_discount: number };
};

async function ensureCoupon(id: string, params: Record<string, unknown>): Promise<Coupon> {
  try {
    return await stripeApi<Coupon>(`coupons/${id}`);
  } catch {
    return await stripeApi<Coupon>("coupons", { id, ...params });
  }
}

// Builds only the discount-relevant part of what the route sends. Deliberately
// no trial here (the route sets one) so amount_total reflects real money and
// "sold at list price" is assertable rather than masked by a $0 trial invoice.
async function createSession(couponId: string | null): Promise<Session> {
  const created = await stripeApi<{ id: string }>("checkout/sessions", {
    mode: "subscription",
    payment_method_types: ["card"],
    line_items: [{ price: PRICE, quantity: 1 }],
    success_url: "https://example.com/ok",
    cancel_url: "https://example.com/cancel",
    ...(couponId ? { discounts: [{ coupon: couponId }] } : {}),
  });
  return await stripeApi<Session>(`checkout/sessions/${created.id}`);
}

let listAmount = 0;
let amountOff = 0;

describe.skipIf(!RUN)("founding coupon against real Stripe test mode", () => {
  beforeAll(async () => {
    // Belt and braces on top of RUN — never touch live mode.
    expect(KEY?.startsWith("sk_test_")).toBe(true);

    const price = await stripeApi<{ unit_amount: number }>(`prices/${PRICE}`);
    listAmount = price.unit_amount;

    const valid = await ensureCoupon(VALID_COUPON, {
      amount_off: 5000,
      currency: "usd",
      duration: "repeating",
      duration_in_months: 25,
      max_redemptions: 5,
      name: "TEST fixture - founding valid",
    });
    amountOff = valid.amount_off ?? 0;

    // Must be genuinely redeemed at Stripe, not faked — the whole point is to
    // observe the real valid=false-on-exhaustion behaviour.
    const exhausted = await ensureCoupon(EXHAUSTED_COUPON, {
      amount_off: 5000,
      currency: "usd",
      duration: "repeating",
      duration_in_months: 25,
      max_redemptions: 1,
      name: "TEST fixture - founding exhausted",
    });
    if (exhausted.times_redeemed < (exhausted.max_redemptions ?? Infinity)) {
      const customer = await stripeApi<{ id: string }>("customers", {
        email: "founding-fixture@example.com",
      });
      const pm = await stripeApi<{ id: string }>("payment_methods", {
        type: "card",
        card: { token: "tok_visa" },
      });
      await stripeApi(`payment_methods/${pm.id}/attach`, { customer: customer.id });
      await stripeApi(`customers/${customer.id}`, {
        invoice_settings: { default_payment_method: pm.id },
      });
      await stripeApi("subscriptions", {
        customer: customer.id,
        items: [{ price: PRICE }],
        discounts: [{ coupon: EXHAUSTED_COUPON }],
        trial_period_days: 30,
      });
    }
  }, 60_000);

  test("Stripe really does report valid=false on a fully redeemed coupon", async () => {
    const coupon = await stripeApi<Coupon>(`coupons/${EXHAUSTED_COUPON}`);
    expect(coupon.times_redeemed).toBeGreaterThanOrEqual(coupon.max_redemptions ?? 0);
    // If this ever fails, Stripe changed the behaviour that motivated the fix.
    expect(coupon.valid).toBe(false);
  });

  test("valid coupon -> session carries the coupon and promotion_code null", async () => {
    const coupon = await stripeApi<Coupon>(`coupons/${VALID_COUPON}`);
    const result = classifyCoupon(coupon as never, VALID_COUPON);
    expect(result.status).toBe("available");

    const plan = planCheckout(result);
    expect(plan.proceed).toBe(true);
    expect(plan.couponId).toBe(VALID_COUPON);

    const session = await createSession(plan.couponId);
    expect(session.discounts).toEqual([{ coupon: VALID_COUPON, promotion_code: null }]);
    expect(session.total_details?.amount_discount).toBe(amountOff);
    expect(session.amount_total).toBe(listAmount - amountOff);
  }, 30_000);

  test("REGRESSION exhausted coupon -> checkout proceeds, list price, no discount", async () => {
    const coupon = await stripeApi<Coupon>(`coupons/${EXHAUSTED_COUPON}`);
    const result = classifyCoupon(coupon as never, EXHAUSTED_COUPON);
    // The bug: this used to come back misconfigured, and checkout 503'd.
    expect(result.status).toBe("exhausted");

    const plan = planCheckout(result);
    expect(plan.proceed).toBe(true);
    expect(plan.couponId).toBeNull();
    expect(plan.alert).toBeNull();

    const session = await createSession(plan.couponId);
    expect(session.discounts ?? []).toEqual([]);
    expect(session.total_details?.amount_discount).toBe(0);
    expect(session.amount_total).toBe(listAmount);
  }, 30_000);

  test("unknown coupon id -> checkout proceeds at list price AND alerts", async () => {
    const result = await stripeApi<Coupon>(`coupons/${MISSING_COUPON}`).then(
      (c) => classifyCoupon(c as never, MISSING_COUPON),
      (err) => classifyCouponError(err, MISSING_COUPON)
    );
    expect(result.status).toBe("misconfigured");

    const plan = planCheckout(result);
    expect(plan.proceed).toBe(true);
    expect(plan.couponId).toBeNull();
    // The alert payload the route hands to alertFoundingCouponMisconfigured.
    expect(plan.alert).not.toBeNull();
    expect(plan.alert?.couponId).toBe(MISSING_COUPON);

    const session = await createSession(plan.couponId);
    expect(session.discounts ?? []).toEqual([]);
    expect(session.amount_total).toBe(listAmount);
  }, 30_000);

  test("INVARIANT holds against real Stripe state in all three cases", async () => {
    const [valid, exhausted] = await Promise.all([
      stripeApi<Coupon>(`coupons/${VALID_COUPON}`),
      stripeApi<Coupon>(`coupons/${EXHAUSTED_COUPON}`),
    ]);
    const missing = await stripeApi<Coupon>(`coupons/${MISSING_COUPON}`).then(
      (c) => classifyCoupon(c as never, MISSING_COUPON),
      (err) => classifyCouponError(err, MISSING_COUPON)
    );

    for (const result of [
      classifyCoupon(valid as never, VALID_COUPON),
      classifyCoupon(exhausted as never, EXHAUSTED_COUPON),
      missing,
    ]) {
      const shownOnPricing = offerFromResult(result) !== null;
      const session = await createSession(planCheckout(result).couponId);
      const sessionHasDiscount = (session.discounts ?? []).length > 0;
      expect(sessionHasDiscount).toBe(shownOnPricing);
    }
  }, 60_000);
});

// Guard against the suite silently never running. If a live key is configured
// this fails loudly rather than quietly skipping, because a live key here would
// mean the safety check above is the only thing standing between this file and
// creating real objects.
test("integration suite is either running in test mode or cleanly skipped", () => {
  expect(LIVE).toBe(false);
  if (!RUN) {
    console.warn(
      "foundingOfferStripe.test.ts skipped — no sk_test_ STRIPE_SECRET_KEY / STRIPE_PRO_PRICE_ID in env."
    );
  }
});
