"use node";

import Stripe from "stripe";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

// Phase 2 complete: upsertSubscription/upsertUnclaimedSubscription/
// updatePlanStatusByCustomer are now internalMutation — unreachable by any
// client except via ctx.runMutation from a trusted Convex function. This
// action is deliberately public (not internalAction) so BOTH callers can
// reach it: convex/http.ts's httpAction (ctx.runAction, for the Convex-
// native shadow endpoint) and app/api/stripe/webhook/route.ts (fetchAction,
// for the live Vercel-registered endpoint) — Stripe's signature check right
// below is the real trust boundary either way, not the public/internal
// distinction. This file must also stay Node-runtime-only for the stripe
// SDK's constructEvent, but httpAction handlers can't live in a "use node"
// file, so the HTTP entry point and this verification/processing logic stay
// split across two files.
export const verifyAndProcess = action({
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
          await ctx.runMutation(internal.subscriptions.upsertSubscription, {
            clerkUserId,
            stripeCustomerId: customerId,
            stripeSubscriptionId: sub.id,
            plan,
            planStatus,
          });
        } else {
          // Guest checkout — no Clerk account yet. Persist by customer id;
          // claimGymBySessionId links clerkUserId once they sign up.
          await ctx.runMutation(internal.subscriptions.upsertUnclaimedSubscription, {
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
          await ctx.runMutation(internal.subscriptions.updatePlanStatusByCustomer, {
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
