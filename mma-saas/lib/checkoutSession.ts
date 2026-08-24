import type Stripe from "stripe";
import { TRIAL_DAYS } from "./plans";

// Extracted from app/api/stripe/checkout/route.ts so it can be unit-tested.
// A Next route module may only export its handlers and a fixed set of config
// symbols, so nothing inside one can be imported by a test — which is why two
// separate fixes to these params (the session id in success_url, and customer
// reuse) both shipped with zero coverage. Verifying them by hand needs a
// COMPLETED Stripe checkout, and AGENTS.md §6 forbids that: creating a session
// is free, completing one burns a founding slot permanently.
//
// Deliberately pure — no Stripe client, no Clerk types, no env reads. Everything
// it needs arrives as an argument, so a test can assert the exact object.

export type CheckoutBuyer = {
  clerkUserId: string;
  /** Prefills the hosted page. Ignored when an existing customer is reused. */
  email?: string;
} | null;

export function buildCheckoutSessionParams(input: {
  priceId: string;
  origin: string;
  /** null = guest checkout (the old pay-first fallback). */
  buyer: CheckoutBuyer;
  /** The gym's known Stripe customer, when it has one. */
  existingCustomerId: string | null;
  /** null = sell at list price. */
  couponId: string | null;
}): Stripe.Checkout.SessionCreateParams {
  const { priceId, origin, buyer, existingCustomerId, couponId } = input;

  return {
    mode: "subscription",
    payment_method_types: ["card"],
    line_items: [{ price: priceId, quantity: 1 }],
    ...(couponId ? { discounts: [{ coupon: couponId }] } : {}),

    // BOTH paths carry {CHECKOUT_SESSION_ID}, and the session id is the whole
    // point: it is the only thing that lets the destination page re-verify the
    // purchase against Stripe itself instead of waiting on a webhook that may
    // never arrive.
    //
    // Signed-in buyers (the auth-first onboarding flow — the gym already exists
    // via completeOnboarding/getOrCreateGym, linked by clerkUserId) land on
    // /dashboard, which claims the session synchronously via claimGymBySessionId
    // before it decides anything (app/dashboard/page.tsx). It used to land there
    // with `checkout=success` alone and nothing but SettlingGate waiting out the
    // async webhook — so when a delivery failed signature verification on
    // 2026-08-19, a gym owner who HAD PAID was bounced to /pricing after 8
    // seconds and re-entered the wizard, forever, with no error anywhere.
    // NEVER remove the session id from this URL.
    //
    // Guests still land on /welcome, which does the same re-verification — never
    // send a guest straight to /dashboard, since there is no account yet to link
    // it to.
    success_url: buyer
      ? `${origin}/dashboard?checkout=success&session_id={CHECKOUT_SESSION_ID}`
      : `${origin}/welcome?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/pricing`,

    // Reusing the buyer's existing customer is what stops a retried checkout
    // minting a second Stripe customer for the same person — see
    // claude/gym-row-clobber-2026-08-20.md for what two customers under one
    // Clerk user did to a live gym row.
    ...(existingCustomerId ? { customer: existingCustomerId } : {}),

    // Mirrors subscription_data.metadata.clerkUserId below for Stripe Dashboard
    // visibility (shows next to the customer without opening the subscription
    // object) — the actual webhook resolution still reads the subscription
    // metadata, not this field, since client_reference_id lives on the Checkout
    // Session and is not present on the customer.subscription.* events the
    // webhook processes.
    ...(buyer ? { client_reference_id: buyer.clerkUserId } : {}),

    billing_address_collection: "required",
    automatic_tax: { enabled: true },

    // Same trial on all plans, guest or signed-in alike — don't special-case by
    // priceId. Length comes from lib/plans.ts so the number Stripe grants and
    // the number the UI promises stay identical.
    subscription_data: {
      trial_period_days: TRIAL_DAYS,
      // Signed-in: tag the subscription so the webhook can also link it
      // (redundant with claimGymBySessionId, harmless). Guest: leave
      // clerkUserId unset — Stripe's hosted page collects the email itself, and
      // /welcome links the account after signup via claimGymBySessionId.
      ...(buyer ? { metadata: { clerkUserId: buyer.clerkUserId } } : {}),
    },

    // Mutually exclusive with `customer` in Stripe: sending both is rejected
    // outright. When the customer is known its email is already on file, so
    // prefilling is redundant as well as illegal.
    ...(buyer && !existingCustomerId && buyer.email
      ? { customer_email: buyer.email }
      : {}),
  };
}
