import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { currentUser } from "@clerk/nextjs/server";
import { fetchAction, fetchQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { getConvexToken } from "@/lib/convex-auth";
import { sendAlertEmail, shouldDeliverOutageAlert } from "@/lib/alerts";

export async function POST(request: NextRequest) {
  // Read, don't construct. `new Stripe(undefined!)` throws SYNCHRONOUSLY, and
  // this used to sit on the first line of the handler — so a missing key
  // produced a raw 500 with a stack trace, no alert, and an existing paying
  // customer simply couldn't reach the billing portal with nobody knowing.
  // Same fix and same reasoning as app/api/stripe/checkout/route.ts:39; that
  // one was fixed and this one was missed. The client is constructed below,
  // once the key is known to be present.
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  // checkRateLimit is internalMutation now — this goes through the
  // checkRateLimitAction wrapper instead of fetchMutation. See
  // convex/rateLimit.ts for why.
  const allowed = await fetchAction(api.rateLimit.checkRateLimitAction, {
    bucket: "portal",
    identifier: `user:${user.id}`,
  });
  if (!allowed) {
    return NextResponse.json(
      { error: "Too many requests — please wait a bit and try again." },
      { status: 429 }
    );
  }

  const token = await getConvexToken();
  const subscription = await fetchQuery(api.subscriptions.getSubscription, {}, { token });
  if (!subscription.stripeCustomerId) {
    return NextResponse.json({ error: "No billing account found" }, { status: 400 });
  }

  if (!stripeSecretKey) {
    // Gated exactly like the checkout route's outage alert: Preview has no
    // Stripe key BY DESIGN after the 2026-08-01 env scoping, so alerting from
    // there would be a permanent false alarm about intended behaviour.
    const deliver = shouldDeliverOutageAlert(process.env.VERCEL_ENV);
    console.error(
      `Stripe portal: STRIPE_SECRET_KEY is missing — a paying customer cannot manage their subscription${
        deliver ? " (alerting)" : "; alert suppressed outside production"
      }`
    );
    if (deliver) {
      await sendAlertEmail(
        "KombatDesk: billing portal is DOWN — STRIPE_SECRET_KEY missing",
        [
          "A signed-in customer tried to open the Stripe billing portal and STRIPE_SECRET_KEY was not set.",
          "",
          "They cannot update a card, view invoices, or cancel — and FAQ #4 on /pricing promises they can cancel from their dashboard.",
          "",
          `Vercel env: ${process.env.VERCEL_ENV ?? "unknown"}`,
          `Deployment: ${process.env.VERCEL_URL ?? "unknown"}`,
          "",
          "Set STRIPE_SECRET_KEY on the Production environment in Vercel and redeploy. Do NOT add it to Preview — previews are deliberately keyless so a preview checkout can never charge a real card.",
        ].join("\n")
      );
    }
    // Never leak the env var name to the caller.
    return NextResponse.json(
      { error: "Billing is temporarily unavailable. Please try again in a moment." },
      { status: 503 }
    );
  }

  const stripe = new Stripe(stripeSecretKey);
  const origin = new URL(request.url).origin;

  const session = await stripe.billingPortal.sessions.create({
    customer: subscription.stripeCustomerId,
    return_url: `${origin}/billing`,
  });

  return NextResponse.json({ url: session.url });
}
