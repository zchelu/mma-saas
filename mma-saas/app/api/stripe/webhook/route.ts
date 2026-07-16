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

  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const clerkUserId = sub.metadata?.clerkUserId;

      const proPriceId = process.env.STRIPE_PRO_PRICE_ID!;
      const elitePriceId = process.env.STRIPE_ELITE_PRICE_ID!;
      const priceId = sub.items.data[0]?.price.id;
      const plan = priceId === elitePriceId ? "elite" : priceId === proPriceId ? "pro" : "starter";
      const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
      const planStatus = event.type === "customer.subscription.deleted" ? "canceled" : sub.status;

      if (clerkUserId) {
        await fetchMutation(api.subscriptions.upsertSubscription, {
          clerkUserId,
          stripeCustomerId: customerId,
          stripeSubscriptionId: sub.id,
          plan,
          planStatus,
        });
      } else {
        // Guest checkout — no Clerk account yet. Persist by customer id;
        // claimGymBySessionId links clerkUserId once they sign up.
        await fetchMutation(api.subscriptions.upsertUnclaimedSubscription, {
          stripeCustomerId: customerId,
          stripeSubscriptionId: sub.id,
          plan,
          planStatus,
        });
      }
      break;
    }
    case "invoice.payment_failed":
    case "invoice.payment_succeeded": {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
      if (!customerId) break;

      await fetchMutation(api.subscriptions.updatePlanStatusByCustomer, {
        stripeCustomerId: customerId,
        planStatus: event.type === "invoice.payment_failed" ? "past_due" : "active",
      });
      break;
    }
  }

  return NextResponse.json({ received: true });
}
