import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { currentUser } from "@clerk/nextjs/server";
import { fetchAction, fetchQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { getConvexToken } from "@/lib/convex-auth";

export async function POST(request: NextRequest) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
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

  const origin = new URL(request.url).origin;

  const session = await stripe.billingPortal.sessions.create({
    customer: subscription.stripeCustomerId,
    return_url: `${origin}/billing`,
  });

  return NextResponse.json({ url: session.url });
}
