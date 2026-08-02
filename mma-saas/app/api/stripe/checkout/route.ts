import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { currentUser } from "@clerk/nextjs/server";
import { fetchAction } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { clientIp } from "@/lib/rate-limit";
import { readJsonBody } from "@/lib/http";
import { TRIAL_DAYS, allowedPriceIds } from "@/lib/plans";
import { getFoundingOfferResult } from "@/lib/foundingOffer";
import { missingApiKeyResult, planCheckout } from "@/lib/foundingOfferPolicy";
import {
  alertCheckoutDown,
  alertFoundingCouponMisconfigured,
  sendAlertEmail,
  shouldDeliverOutageAlert,
} from "@/lib/alerts";

export async function POST(request: NextRequest) {
  // checkRateLimit is internalMutation now — this goes through the
  // checkRateLimitAction wrapper instead of fetchMutation. See
  // convex/rateLimit.ts for why.
  const allowed = await fetchAction(api.rateLimit.checkRateLimitAction, {
    bucket: "checkout",
    identifier: clientIp(request),
  });
  if (!allowed) {
    return NextResponse.json(
      { error: "Too many requests — please wait a bit and try again." },
      { status: 429 }
    );
  }

  // Read, don't construct. `new Stripe(undefined!)` throws synchronously —
  // above the try/catch and above the four-state classification below — so a
  // missing key used to produce a raw 500 with a stack trace, no 503, and no
  // alert: a silent outage, which is exactly what alertCheckoutDown exists to
  // catch. The client is constructed further down, only once the key is known
  // to be present. See missingApiKeyResult in lib/foundingOfferPolicy.ts.
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  const user = await currentUser();

  const body = await readJsonBody<{ priceId?: string }>(request);
  if (!body || typeof body.priceId !== "string") {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }
  const { priceId } = body;

  if (!allowedPriceIds().includes(priceId)) {
    return NextResponse.json(
      { error: "That plan isn't available right now. Please refresh and try again." },
      { status: 400 }
    );
  }

  const origin = new URL(request.url).origin;

  // Founding pricing is never read from client input — the coupon's own
  // redemption count (via getFoundingOfferResult) is the only thing that
  // decides whether a discount applies, same as the pricing page.
  //
  // planCheckout (lib/foundingOfferPolicy.ts) turns that state into the one
  // decision this route needs, and it is the single place the /pricing-vs-
  // checkout invariant is enforced: a discount is attached if and only if
  // /pricing was advertising one. Sold out and misconfigured both mean
  // /pricing is showing no founding block, so nobody was promised anything
  // and the sale proceeds at list price. Only "unknown" — Stripe unreachable,
  // where a retry may still resolve it and we cannot tell what other visitors
  // are being shown — refuses, because falling through there would silently
  // charge list price to someone who was just promised a discount.
  // An absent key short-circuits to the same `unknown` state a rejected key
  // reaches, so both get the identical 503 + alert treatment rather than one
  // being handled and the other crashing. getFoundingOfferResult would in fact
  // also land on `unknown` here (its Stripe construction is inside a try), but
  // it is not called at all without a key — there is nothing it could tell us,
  // and the explicit result carries far better remediation copy.
  const foundingOfferResult = stripeSecretKey
    ? await getFoundingOfferResult()
    : missingApiKeyResult(process.env.STRIPE_FOUNDING_COUPON_ID);
  const checkoutPlan = planCheckout(foundingOfferResult);

  // Awaited, not fire-and-forget, so a response can't outrun its alert and
  // leave the failure completely silent. Both kinds are sent before responding.
  if (checkoutPlan.alert?.kind === "misconfigured") {
    // Deterministic config error. The sale still goes through at list price.
    console.error(
      "Stripe checkout: founding coupon is misconfigured — selling at LIST PRICE and alerting:",
      checkoutPlan.alert.reason
    );
    await alertFoundingCouponMisconfigured(checkoutPlan.alert);
  } else if (checkoutPlan.alert?.kind === "outage") {
    // Stripe unreachable. This refuses the sale below, so it is the loud one.
    // Logged in every environment; emailed only from production. Preview has
    // no Stripe key by design (see shouldDeliverOutageAlert), so an outage
    // alert from there would be a false alarm about intended behavior.
    const deliver = shouldDeliverOutageAlert(process.env.VERCEL_ENV);
    console.error(
      `Stripe checkout: founding coupon state is unknown — REFUSING the sale${deliver ? " and alerting" : "; alert email suppressed outside production"}:`,
      checkoutPlan.alert.reason
    );
    if (deliver) {
      await alertCheckoutDown({
        source: "api/stripe/checkout",
        ...checkoutPlan.alert,
        vercelEnv: process.env.VERCEL_ENV,
        deploymentUrl: process.env.VERCEL_URL,
      });
    }
  }

  // The `!stripeSecretKey` half is redundant — an absent key always yields
  // `unknown`, which is the only state that fails to proceed — but it is what
  // narrows the type below, and it guarantees the client is never constructed
  // with an empty key no matter how this classification later changes.
  // Always the same generic body: never leak a stack trace or an env var name
  // to an anonymous caller.
  if (!checkoutPlan.proceed || !stripeSecretKey) {
    return NextResponse.json(
      { error: "Something went wrong setting up checkout. Please try again in a moment." },
      { status: 503 }
    );
  }

  const stripe = new Stripe(stripeSecretKey);

  const foundingOffer = foundingOfferResult.status === "available" ? foundingOfferResult.offer : null;

  function buildSessionParams(applyDiscount: boolean): Stripe.Checkout.SessionCreateParams {
    return {
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      ...(applyDiscount && foundingOffer
        ? { discounts: [{ coupon: foundingOffer.couponId }] }
        : {}),
      // Signed-in buyers (the auth-first onboarding flow — the gym already
      // exists via completeOnboarding/getOrCreateGym, linked by clerkUserId)
      // land straight on /dashboard; SettlingGate there already knows how to
      // wait out the async webhook rather than bounce prematurely (see the
      // awaitingCheckout handling in app/dashboard/settling-gate.tsx). Guest
      // checkouts (no signed-in user — the old pay-first fallback, kept
      // alive per claimGymBySessionId/claimGymByRecoveryToken) still land on
      // /welcome, which re-verifies the session with Stripe directly and
      // activates the plan synchronously — never send a guest straight to
      // /dashboard, since there's no account yet to link it to.
      success_url: user
        ? `${origin}/dashboard?checkout=success`
        : `${origin}/welcome?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/pricing`,
      // Mirrors subscription_data.metadata.clerkUserId below for Stripe
      // Dashboard visibility (shows next to the customer without opening the
      // subscription object) — the actual webhook resolution still reads the
      // subscription metadata, not this field, since client_reference_id
      // lives on the Checkout Session and isn't present on the
      // customer.subscription.* events the webhook processes.
      ...(user ? { client_reference_id: user.id } : {}),
      billing_address_collection: "required",
      automatic_tax: { enabled: true },
      // Same trial on all plans, guest or signed-in alike — don't
      // special-case by priceId. Length comes from lib/plans.ts so the
      // number Stripe grants and the number the UI promises stay identical.
      subscription_data: {
        trial_period_days: TRIAL_DAYS,
        // Signed-in: tag the subscription so the webhook can also link it
        // (redundant with claimGymBySessionId, harmless). Guest: leave
        // clerkUserId unset — Stripe's hosted page collects the email
        // itself, and /welcome links the account after signup via
        // claimGymBySessionId (see convex/subscriptions.ts).
        ...(user ? { metadata: { clerkUserId: user.id } } : {}),
      },
      // Signed-in: prefill email.
      ...(user ? { customer_email: user.emailAddresses[0]?.emailAddress } : {}),
    };
  }

  try {
    let session;
    try {
      session = await stripe.checkout.sessions.create(buildSessionParams(true));
    } catch (err) {
      // Only a coupon-specific rejection falls back to standard price. A
      // network blip or rate limit here must NOT silently drop the discount
      // and charge full price — those rethrow below and hit the normal
      // error response instead.
      if (foundingOffer && isCouponSpecificError(err)) {
        // The coupon can be exhausted/invalidated between getFoundingOffer()
        // resolving and this call reaching Stripe (another gym closes in the
        // gap). A gym owner mid-demo must never see an error screen because
        // of that race — retry once at standard price instead of failing —
        // but this is money silently changing, so it also has to alert a
        // human, not just log.
        console.error(
          "Stripe checkout: founding coupon rejected, retrying at standard price:",
          err
        );
        await sendAlertEmail(
          "KombatDesk: founding coupon rejected at checkout — customer charged standard price",
          [
            `Checkout proceeded at STANDARD price because Stripe rejected the founding coupon.`,
            ``,
            `Price ID: ${priceId}`,
            `Coupon ID: ${foundingOffer.couponId}`,
            ``,
            `Stripe error: ${err instanceof Error ? err.message : String(err)}`,
            ``,
            `The /pricing page may have shown this customer a founding price before they clicked through — they may expect it. Check whether the coupon is exhausted, expired, or deleted, and whether the founding block on /pricing needs to come down.`,
          ].join("\n")
        );
        session = await stripe.checkout.sessions.create(buildSessionParams(false));
      } else {
        throw err;
      }
    }

    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("Stripe checkout session creation failed:", err);
    return NextResponse.json(
      { error: "Something went wrong — please try again or contact us." },
      { status: 500 }
    );
  }
}

// Narrows the founding-coupon fallback to failures that are actually about
// the coupon — a bad/expired/exhausted/deleted coupon — as opposed to any
// other invalid-request error, and excludes non-invalid-request error classes
// entirely (StripeRateLimitError, StripeConnectionError, StripeAPIError,
// etc.), which must always rethrow rather than silently drop the discount.
function isCouponSpecificError(err: unknown): boolean {
  if (!(err instanceof Stripe.errors.StripeInvalidRequestError)) return false;

  const param = err.param?.toLowerCase() ?? "";
  if (param.includes("coupon") || param.includes("discount")) return true;

  // Some coupon failures (exhausted, deleted) surface without a `param` —
  // fall back to the message text Stripe uses for those specific cases,
  // not invalid-request errors generally.
  const message = err.message?.toLowerCase() ?? "";
  return (
    message.includes("coupon") &&
    (message.includes("expired") ||
      message.includes("invalid") ||
      message.includes("deleted") ||
      message.includes("no longer be redeemed") ||
      message.includes("redemption"))
  );
}
