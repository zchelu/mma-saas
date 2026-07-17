"use node";

import Stripe from "stripe";
import { internalAction } from "./_generated/server";
import { api } from "./_generated/api"; // Phase 2: import { internal } from "./_generated/api";
import { v } from "convex/values";

// Only callable via ctx.runAction from convex/http.ts's httpAction — this
// file must stay Node-runtime-only for the stripe SDK's constructEvent, but
// httpAction handlers can't live in a "use node" file, so the HTTP entry
// point and the verification/processing logic are split across two files.
export const verifyAndProcess = internalAction({
  args: { signature: v.string(), payload: v.string() },
  handler: async (ctx, { signature, payload }): Promise<{ success: boolean }> => {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(payload, signature, process.env.STRIPE_WEBHOOK_SECRET!);
    } catch (err) {
      console.error("Stripe webhook signature verification failed:", err);
      return { success: false };
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
          await ctx.runMutation(api.subscriptions.upsertSubscription, {
            clerkUserId,
            stripeCustomerId: customerId,
            stripeSubscriptionId: sub.id,
            plan,
            planStatus,
          });
        } else {
          // Guest checkout — no Clerk account yet. Persist by customer id;
          // claimGymBySessionId links clerkUserId once they sign up.
          await ctx.runMutation(api.subscriptions.upsertUnclaimedSubscription, {
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
        if (customerId) {
          await ctx.runMutation(api.subscriptions.updatePlanStatusByCustomer, {
            stripeCustomerId: customerId,
            planStatus: event.type === "invoice.payment_failed" ? "past_due" : "active",
          });
        }
        break;
      }
    }

    return { success: true };
  },
});
