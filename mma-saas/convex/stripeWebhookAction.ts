"use node";

import Stripe from "stripe";
import { Resend } from "resend";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { PLAN_PRICE_USD, TRIAL_DAYS } from "../lib/plans";

const MANAGE_SUBSCRIPTION_URL = "https://kombatdesk.com/billing";

// Colorado Automatic Renewal Law (C.R.S. 6-1-732) requires written
// post-purchase confirmation of price/frequency/cancellation — the
// onboarding wizard's on-screen disclosure alone doesn't satisfy that.
// Fires off customer.subscription.created only, which Stripe never re-fires
// for the same subscription, so this can't duplicate on renewals/upgrades.
// Failure is logged, not thrown, so a Resend outage doesn't fail the whole
// webhook and trigger a Stripe retry that would re-run the (idempotent)
// upsert for nothing.
async function sendTrialConfirmationEmail(
  stripe: Stripe,
  customerId: string,
  plan: string,
  trialEnd: number | null
) {
  if (!trialEnd) return;
  try {
    const customer = await stripe.customers.retrieve(customerId);
    if (customer.deleted || !customer.email) return;

    const price = PLAN_PRICE_USD[plan];
    const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1);
    const trialEndDate = new Date(trialEnd * 1000).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: "KombatDesk <billing@kombatdesk.com>",
      to: customer.email,
      subject: `Your KombatDesk ${planLabel} trial has started`,
      text: [
        `Your ${TRIAL_DAYS}-day free trial of KombatDesk ${planLabel} has started.`,
        ``,
        `Plan: KombatDesk ${planLabel} — $${price}/month`,
        `Trial: ${TRIAL_DAYS} days, ends ${trialEndDate}`,
        `Billing frequency: monthly, starting ${trialEndDate}`,
        `Total due today: $0.00`,
        ``,
        `Cancel anytime before your trial ends to avoid being charged. Manage or cancel your subscription here:`,
        MANAGE_SUBSCRIPTION_URL,
        ``,
        `Questions? Just reply to this email.`,
      ].join("\n"),
    });
  } catch (err) {
    console.error("Trial confirmation email failed to send:", err);
  }
}

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

        if (event.type === "customer.subscription.created") {
          await sendTrialConfirmationEmail(stripe, customerId, plan, sub.trial_end);
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
