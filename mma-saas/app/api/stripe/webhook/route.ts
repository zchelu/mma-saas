import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { fetchMutation } from "convex/nextjs";
import { api } from "@/convex/_generated/api";

export async function POST(request: NextRequest) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch {
    return NextResponse.json({ error: "Invalid webhook signature" }, { status: 400 });
  }

  const sub = event.data.object as Stripe.Subscription;
  const clerkUserId = sub.metadata?.clerkUserId;

  if (!clerkUserId) {
    return NextResponse.json({ received: true });
  }

  const proPriceId = process.env.STRIPE_PRO_PRICE_ID!;
  const elitePriceId = process.env.STRIPE_ELITE_PRICE_ID!;
  const priceId = sub.items.data[0]?.price.id;
  const plan = priceId === elitePriceId ? "elite" : priceId === proPriceId ? "pro" : "starter";
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;

  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
      await fetchMutation(api.subscriptions.upsertSubscription, {
        clerkUserId,
        stripeCustomerId: customerId,
        stripeSubscriptionId: sub.id,
        plan,
        planStatus: sub.status,
      });
      break;
    case "customer.subscription.deleted":
      await fetchMutation(api.subscriptions.upsertSubscription, {
        clerkUserId,
        stripeCustomerId: customerId,
        stripeSubscriptionId: sub.id,
        plan,
        planStatus: "canceled",
      });
      break;
  }

  return NextResponse.json({ received: true });
}
