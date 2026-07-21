"use node";

import { randomBytes } from "crypto";
import Stripe from "stripe";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

const TOKEN_TTL_MS = 30 * 60 * 1000;

// Public action — the trust boundary for "recover my purchase" token
// issuance, mirroring stripeWebhookAction.ts's pattern. Previously
// app/api/recover/route.ts did this Stripe ownership verification itself
// and then called subscriptions.createRecoveryToken directly as a public
// mutation — meaning that mutation trusted whatever stripeCustomerId it was
// handed, with nothing Convex-side stopping a direct call from minting a
// token for ANY customer id, including a real paying customer's (enabling
// account/subscription takeover via claimGymByRecoveryToken).
// createRecoveryToken is internalMutation now; this action is the only path
// to it, and performs the same Stripe API ownership verification the route
// used to do, just moved here so Convex — not the Next.js route — is the
// trust boundary. Must stay Node-runtime for the Stripe SDK, same reason as
// stripeWebhookAction.ts.
export const requestRecovery = action({
  args: { email: v.string() },
  handler: async (ctx, { email }): Promise<{ token: string | null }> => {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

    // A single email can map to more than one Stripe customer (e.g. a guest
    // checkout retried after an earlier attempt never got claimed). Stripe
    // returns newest-first, so without checking claim status we'd always
    // resolve to the most recent customer and could never recover an older,
    // still-unclaimed purchase sitting behind a newer already-claimed one.
    const customers = await stripe.customers.list({ email, limit: 10 });

    let targetCustomerId: string | null = null;
    for (const customer of customers.data) {
      const subscriptions = await stripe.subscriptions.list({ customer: customer.id, limit: 1 });
      if (subscriptions.data.length === 0) continue;

      const alreadyClaimed = await ctx.runQuery(internal.subscriptions.isCustomerClaimed, {
        stripeCustomerId: customer.id,
      });
      if (!alreadyClaimed) {
        targetCustomerId = customer.id;
        break;
      }
    }

    if (!targetCustomerId) return { token: null };

    const token = randomBytes(32).toString("hex");
    await ctx.runMutation(internal.subscriptions.createRecoveryToken, {
      token,
      stripeCustomerId: targetCustomerId,
      expiresAt: Date.now() + TOKEN_TTL_MS,
    });

    return { token };
  },
});
