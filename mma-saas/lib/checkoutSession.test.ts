// Covers the Checkout Session params, which shipped twice with no coverage:
// the session id in the signed-in success_url (9417e23) and existing-customer
// reuse (d393d1c). Both sit on the path between a failed webhook and a
// stranded paying customer, and neither could be verified by hand — that needs
// a COMPLETED checkout, and AGENTS.md §6 forbids it.
//
// lib/foundingOfferStripe.test.ts deliberately does NOT cover this: it builds
// its own discount-only params against real Stripe, with no trial, so
// amount_total reflects real money. These are pure assertions on the object.
import { describe, expect, test } from "vitest";
import { buildCheckoutSessionParams } from "./checkoutSession";
import { TRIAL_DAYS } from "./plans";

const ORIGIN = "https://kombatdesk.com";
const PRICE = "price_test_academy";
const BUYER = { clerkUserId: "user_abc", email: "owner@example.com" };

function params(over: Partial<Parameters<typeof buildCheckoutSessionParams>[0]> = {}) {
  return buildCheckoutSessionParams({
    priceId: PRICE,
    origin: ORIGIN,
    buyer: BUYER,
    existingCustomerId: null,
    couponId: null,
    ...over,
  });
}

describe("success_url carries the checkout session id", () => {
  // THE regression. Without {CHECKOUT_SESSION_ID}, /dashboard cannot claim the
  // subscription synchronously and a dropped webhook strands a paid buyer.
  test("REGRESSION signed-in success_url carries checkout=success AND session_id", () => {
    const url = params().success_url!;
    expect(url).toBe(
      `${ORIGIN}/dashboard?checkout=success&session_id={CHECKOUT_SESSION_ID}`
    );
  });

  test("REGRESSION guest success_url carries session_id and goes to /welcome", () => {
    const url = params({ buyer: null }).success_url!;
    expect(url).toBe(`${ORIGIN}/welcome?session_id={CHECKOUT_SESSION_ID}`);
  });

  test("a guest is never sent to /dashboard — there is no account to link to", () => {
    expect(params({ buyer: null }).success_url).not.toContain("/dashboard");
  });

  test("cancel_url returns to pricing", () => {
    expect(params().cancel_url).toBe(`${ORIGIN}/pricing`);
  });
});

describe("customer and customer_email are mutually exclusive", () => {
  // Stripe rejects a session carrying both outright, so this is a hard
  // either/or, not a preference.
  test("REGRESSION a known customer is reused and the email prefill is dropped", () => {
    const p = params({ existingCustomerId: "cus_known" });
    expect(p.customer).toBe("cus_known");
    expect(p.customer_email).toBeUndefined();
  });

  test("no known customer -> prefill the email, send no customer", () => {
    const p = params();
    expect(p.customer).toBeUndefined();
    expect(p.customer_email).toBe(BUYER.email);
  });

  test("a guest sends neither", () => {
    const p = params({ buyer: null });
    expect(p.customer).toBeUndefined();
    expect(p.customer_email).toBeUndefined();
  });

  test("a signed-in buyer with no email on file sends neither", () => {
    const p = params({ buyer: { clerkUserId: "user_abc" } });
    expect(p.customer).toBeUndefined();
    expect(p.customer_email).toBeUndefined();
  });
});

describe("the webhook's link back to the gym", () => {
  // upsertSubscription resolves the gym by subscription metadata, NOT by
  // client_reference_id, which does not appear on customer.subscription.*
  // events at all. Losing this metadata means a signed-in purchase the webhook
  // cannot attribute.
  test("REGRESSION signed-in subscription metadata carries clerkUserId", () => {
    expect(params().subscription_data?.metadata).toEqual({ clerkUserId: BUYER.clerkUserId });
  });

  test("client_reference_id mirrors it for dashboard visibility", () => {
    expect(params().client_reference_id).toBe(BUYER.clerkUserId);
  });

  test("a guest carries neither — /welcome links the account afterwards", () => {
    const p = params({ buyer: null });
    expect(p.subscription_data?.metadata).toBeUndefined();
    expect(p.client_reference_id).toBeUndefined();
  });
});

describe("trial and discount", () => {
  test("the granted trial is TRIAL_DAYS, never a hardcoded number", () => {
    expect(params().subscription_data?.trial_period_days).toBe(TRIAL_DAYS);
  });

  test("guests get the same trial as signed-in buyers", () => {
    expect(params({ buyer: null }).subscription_data?.trial_period_days).toBe(TRIAL_DAYS);
  });

  test("a coupon is attached only when one is passed", () => {
    expect(params({ couponId: "founding50" }).discounts).toEqual([{ coupon: "founding50" }]);
    expect(params().discounts).toBeUndefined();
  });
});

describe("invariants that must not drift", () => {
  test("subscription mode, the requested price, tax and billing address", () => {
    const p = params();
    expect(p.mode).toBe("subscription");
    expect(p.line_items).toEqual([{ price: PRICE, quantity: 1 }]);
    expect(p.automatic_tax).toEqual({ enabled: true });
    expect(p.billing_address_collection).toBe("required");
  });
});
