import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { currentUser } from "@clerk/nextjs/server";
import { fetchAction } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { clientIp } from "@/lib/rate-limit";
import { readJsonBody } from "@/lib/http";
import { TRIAL_DAYS, allowedPriceIds } from "@/lib/plans";
import { getFoundingOffer } from "@/lib/foundingOffer";
import { sendAlertEmail } from "@/lib/alerts";

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

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
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
  // redemption count (via getFoundingOffer) is the only thing that decides
  // whether a discount applies, same as the pricing page.
  const foundingOffer = await getFoundingOffer();

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
