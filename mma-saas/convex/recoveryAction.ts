"use node";

import { randomBytes } from "crypto";
import Stripe from "stripe";
import { Resend } from "resend";
import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

const TOKEN_TTL_MS = 30 * 60 * 1000;

// NEVER a caller-supplied argument. An attacker-controlled origin would send a
// real, valid token to the real owner's inbox pointing at a domain the attacker
// controls — turning a takeover bug into a phishing primitive. Set APP_BASE_URL
// on the Convex deployment so dev doesn't email production links; the fallback
// is www, not the apex, because the apex 308-redirects and not every mail
// client follows a redirect on click.
const APP_BASE_URL = process.env.APP_BASE_URL ?? "https://www.kombatdesk.com";

// Bounded fan-out: this was 10 customers x 1 subscriptions.list each, i.e. up
// to 11 Stripe round-trips per unauthenticated call. More than a handful of
// Stripe customers sharing one email is already pathological.
const MAX_CUSTOMERS_SCANNED = 5;

// Everything expensive lives here, behind the scheduler: the Stripe lookups,
// the token mint, and the Resend send. requestRecovery below fires this with
// runAfter(0) and returns without awaiting any of it, so a caller cannot time
// the response to learn whether an email matched a paying customer. That's the
// half of the enumeration oracle a constant return value alone doesn't fix.
//
// internalAction: unreachable from any client. The email address reaching it
// has always passed the rate limits in requestRecovery.
export const deliverRecoveryEmail = internalAction({
  args: { email: v.string() },
  handler: async (ctx, { email }): Promise<void> => {
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

      // A single email can map to more than one Stripe customer (e.g. a guest
      // checkout retried after an earlier attempt never got claimed). Stripe
      // returns newest-first, so without checking claim status we'd always
      // resolve to the most recent customer and could never recover an older,
      // still-unclaimed purchase sitting behind a newer already-claimed one.
      const customers = await stripe.customers.list({ email, limit: MAX_CUSTOMERS_SCANNED });

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

      if (!targetCustomerId) return;

      const token = randomBytes(32).toString("hex");
      await ctx.runMutation(internal.subscriptions.createRecoveryToken, {
        token,
        stripeCustomerId: targetCustomerId,
        expiresAt: Date.now() + TOKEN_TTL_MS,
      });

      const resend = new Resend(process.env.RESEND_API_KEY);
      const { error } = await resend.emails.send({
        from: "KombatDesk <billing@kombatdesk.com>",
        to: email,
        subject: "Finish setting up your KombatDesk account",
        text: [
          `We found a payment on file for this email but no account linked to it yet.`,
          ``,
          `Finish setting up your account here (link expires in 30 minutes):`,
          `${APP_BASE_URL}/welcome?token=${token}`,
          ``,
          `If you didn't request this, you can ignore this email.`,
        ].join("\n"),
      });

      // The Resend SDK resolves rather than throws on an API-level rejection
      // (unverified sender domain, bad key), so the catch below would never
      // see it — same trap lib/alerts.ts:20 documents for the raw fetch path.
      // Checked explicitly because the failure mode is silent and expensive: a
      // real paying customer gets no email and no way to reach their account,
      // and a valid token sits in the table unused. If this line ever fires,
      // check that billing@kombatdesk.com is a verified sender on the Resend
      // domain the CONVEX deployment's RESEND_API_KEY belongs to.
      if (error) {
        console.error("deliverRecoveryEmail: Resend rejected the send:", error);
      }
    } catch (err) {
      // Nothing to surface to — the caller is long gone by design. This log is
      // the only signal that a legitimate recovery silently failed.
      console.error("deliverRecoveryEmail failed:", err);
    }
  },
});

// Public entry point for app/api/recover/route.ts.
//
// Previously returned the minted token in its response body. Because Convex
// action exports are internet endpoints and the deployment URL ships to every
// browser in NEXT_PUBLIC_CONVEX_URL, that handed an account-claim credential to
// any anonymous caller: request a token for a stranger's email, then redeem it
// via claimGymByRecoveryToken to link their paid subscription to your own Clerk
// account. It was also an enumeration oracle — the response differed depending
// on whether the email had an unclaimed paying customer behind it.
//
// Both are closed by returning the same constant on every path and doing no
// observable work before returning. The rate limits are enforced HERE rather
// than only in the Next.js route, because that route is not the only way in.
export const requestRecovery = action({
  args: { email: v.string() },
  handler: async (ctx, { email }): Promise<{ ok: true }> => {
    const normalized = email.trim().toLowerCase();

    // Per-email first: a legitimate user who trips their own limit shouldn't
    // also consume the shared platform ceiling below.
    const emailOk = await ctx.runMutation(internal.rateLimit.checkRateLimit, {
      bucket: "recoverEmail",
      identifier: normalized,
    });
    if (!emailOk) return { ok: true };

    // The email key above is caller-supplied, so it bounds nothing against an
    // attacker rotating addresses — this does, at the cost of being coarse.
    const globalOk = await ctx.runMutation(internal.rateLimit.checkRateLimit, {
      bucket: "recoverGlobal",
      identifier: "global",
    });
    if (!globalOk) return { ok: true };

    await ctx.scheduler.runAfter(0, internal.recoveryAction.deliverRecoveryEmail, {
      email: normalized,
    });

    return { ok: true };
  },
});
