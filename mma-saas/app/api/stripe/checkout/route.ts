import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { currentUser } from "@clerk/nextjs/server";
import { fetchAction } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { clientIp } from "@/lib/rate-limit";
import { readJsonBody } from "@/lib/http";

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

  const allowedPriceIds = [
    process.env.STRIPE_STARTER_PRICE_ID,
    process.env.STRIPE_PRO_PRICE_ID,
    process.env.STRIPE_ELITE_PRICE_ID,
  ];
  if (!allowedPriceIds.includes(priceId)) {
    return NextResponse.json(
      { error: "That plan isn't available right now. Please refresh and try again." },
      { status: 400 }
    );
  }

  const origin = new URL(request.url).origin;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      // Both signed-in and guest buyers land on /welcome. It re-verifies the
      // session with Stripe directly and activates the plan synchronously —
      // never send a paying customer straight to /dashboard, since that
      // trusts the async webhook to have already landed, which caused
      // real customers to get bounced back to /pricing right after paying.
      success_url: `${origin}/welcome?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/pricing`,
      billing_address_collection: "required",
      automatic_tax: { enabled: true },
      // 14-day trial on all plans, guest or signed-in alike — don't
      // special-case by priceId.
      subscription_data: {
        trial_period_days: 14,
        // Signed-in: tag the subscription so the webhook can also link it
        // (redundant with claimGymBySessionId, harmless). Guest: leave
        // clerkUserId unset — Stripe's hosted page collects the email
        // itself, and /welcome links the account after signup via
        // claimGymBySessionId (see convex/subscriptions.ts).
        ...(user ? { metadata: { clerkUserId: user.id } } : {}),
      },
      // Signed-in: prefill email.
      ...(user ? { customer_email: user.emailAddresses[0]?.emailAddress } : {}),
    });

    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("Stripe checkout session creation failed:", err);
    return NextResponse.json(
      { error: "Something went wrong — please try again or contact us." },
      { status: 500 }
    );
  }
}
