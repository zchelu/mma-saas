"use node";

// Stripe Connect member billing — the Stripe half of stage C (spec §5.1).
//
// NOTHING HERE CHARGES ANYTHING. This module creates a connected account and a
// hosted onboarding link, and reads back what Stripe says about the account. No
// Customer, no Price, no Subscription, no charge. Those are stages D–F.
//
// Split from convex/connect.ts because the Stripe SDK needs the Node runtime
// and Convex allows only actions in a "use node" module — every query and
// mutation this file calls lives there. Same split, same reason, as
// convex/http.ts and convex/stripeWebhookAction.ts.
import Stripe from "stripe";
import { action, ActionCtx } from "./_generated/server";
import { Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { ConvexError, v } from "convex/values";

// Where Stripe is allowed to send an owner back to.
//
// The origin arrives from the browser because Convex has no request URL to
// derive one from, and hardcoding a single base URL is how a link ends up
// pointing at the wrong environment (see app/dashboard/owner-links.tsx, which
// reads window.location.origin for exactly this reason). Caller-supplied means
// checkable, so it gets checked: an unvalidated origin would let a caller mint
// a Stripe-hosted onboarding link on our platform account that returns the
// owner to a domain of their choosing.
//
// Both apex and www are listed. kombatdesk.com 308-redirects to www, which a
// browser follows on the GET that Stripe's return does — but the redirect is
// the reason to accept both rather than assume which one the owner started on.
const ALLOWED_RETURN_ORIGINS = new Set([
  "https://www.kombatdesk.com",
  "https://kombatdesk.com",
  "http://localhost:3000",
]);

// AGENTS.md §7: read into a variable, branch, construct after. `new
// Stripe(undefined!)` throws SYNCHRONOUSLY, so constructing above the guard
// puts the throw above every catch in the caller — the exact shape of the
// webhook outage documented in docs/stripe-key-gap-closed-2026-08-09.md.
//
// These are CONVEX environment variables, set in the Convex dashboard. Vercel
// having STRIPE_SECRET_KEY says nothing about whether Convex does; that is what
// made the webhook instance invisible across three handoffs.
//
// Returns null rather than throwing so each caller decides what a missing key
// means for its own surface.
function readStripeClient(): Stripe | null {
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    console.error(
      "Connect onboarding: STRIPE_SECRET_KEY is missing from the CONVEX environment " +
        "(set it in the Convex dashboard — NOT Vercel). Member billing setup is unavailable."
    );
    return null;
  }
  return new Stripe(stripeSecretKey);
}

// Verifies the caller and resolves their gym. Identity is read here, in the
// action, and the verified subject is passed down explicitly — see
// convex/connect.ts:getGymForConnect for why that is preferred over relying on
// auth propagation through ctx.runQuery.
async function requireOwnerGym(ctx: ActionCtx): Promise<Doc<"gyms">> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError("You need to be signed in to set up member billing.");
  return await ctx.runQuery(internal.connect.getGymForConnect, { clerkUserId: identity.subject });
}

// Creates the gym's Express connected account if it has none, then returns a
// fresh Stripe-hosted onboarding link to redirect to.
//
// Safe to call repeatedly, and the UI does: account links are single-use and
// short-lived, so "resume onboarding" and "start onboarding" are the same call.
// An existing account is reused, never replaced.
export const startConnectOnboarding = action({
  args: { origin: v.string() },
  handler: async (ctx, { origin }): Promise<{ url: string }> => {
    const stripe = readStripeClient();
    if (!stripe) {
      throw new ConvexError(
        "Member billing setup is temporarily unavailable. Nothing has changed on your account — try again shortly."
      );
    }

    if (!ALLOWED_RETURN_ORIGINS.has(origin)) {
      console.error(`Connect onboarding: refused return origin "${origin}"`);
      throw new ConvexError("Member billing setup can't run from this address.");
    }

    const gym = await requireOwnerGym(ctx);

    let stripeConnectAccountId = gym.stripeConnectAccountId;

    if (!stripeConnectAccountId) {
      // `type: "express"` is DEPRECATED in stripe v22 — the typings say to use
      // `controller`, which is also the only place the spec's liability
      // decisions can actually be written down. Spelling them out beats
      // inheriting whatever the deprecated shorthand defaults to, because two
      // of these four fields decide who eats a chargeback.
      const created = await stripe.accounts.create({
        email: gym.email,
        controller: {
          // Express: Stripe hosts the connected-account dashboard. Spec §1 —
          // this is what puts KYC, disputes, payouts and 1099-K filing on
          // Stripe instead of on a solo founder.
          stripe_dashboard: { type: "express" },
          // Stripe collects and chases KYC requirements, not us. The other
          // half of the same decision.
          requirement_collection: "stripe",
          // The GYM is billed Stripe's processing fees directly. That is what
          // "pass through at cost" means in §1: we add no application fee and
          // never sit in the middle of the fee. See the note in the commit
          // message — this maps a business decision onto a Stripe axis and is
          // worth confirming against §8.5 before anyone is quoted a rate.
          fees: { payer: "account" },
          // Chargebacks and refunds land on the GYM's balance. Spec §1 reason
          // 2, verbatim: destination charges "would make us liable for a
          // closing gym's negative balance." "application" here would hand
          // KombatDesk that liability — do not change this without reading §8.2.
          losses: { payments: "stripe" },
        },
        // Direct charges need card_payments; transfers lets the account hold
        // and be paid out its own funds.
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
      });

      const claim = await ctx.runMutation(internal.connect.claimStripeConnectAccountId, {
        gymId: gym._id,
        stripeConnectAccountId: created.id,
      });

      if (!claim.stored) {
        // Two onboarding starts raced and the other one stored first. Ours is
        // now an empty orphan at Stripe. Continue with the id that actually
        // stuck — overwriting it would strand the gym's real account — and log
        // both so the orphan can be deleted by hand.
        console.error(
          `Connect onboarding: raced account creation for gym ${gym._id}. ` +
            `Orphaned connected account ${created.id} (delete it in the Stripe dashboard); ` +
            `continuing with the stored account ${claim.stripeConnectAccountId}.`
        );
      }
      stripeConnectAccountId = claim.stripeConnectAccountId;
    }

    // refresh_url is where Stripe sends the owner if the link expired before
    // they used it, which is a normal outcome — these links are short-lived.
    // The dashboard card treats it as "start again" rather than an error.
    const accountLink = await stripe.accountLinks.create({
      account: stripeConnectAccountId,
      refresh_url: `${origin}/dashboard?connect=refresh`,
      return_url: `${origin}/dashboard?connect=return`,
      type: "account_onboarding",
    });

    return { url: accountLink.url };
  },
});

// Asks Stripe what the connected account can actually do, and records it.
//
// Called when the owner comes back from onboarding. Returning from the hosted
// flow does NOT mean onboarding succeeded — Stripe returns the owner to
// return_url whenever they leave, including partway through with requirements
// outstanding. Spec §5.1: re-check on return, show real status, don't assume
// success. This is that re-check.
//
// Stage D adds the account.updated webhook, which keeps these fields current
// when Stripe enables an account later without the owner touching our UI. Until
// then this is the only writer, which is why the card calls it on return rather
// than trusting the redirect.
export const refreshConnectStatus = action({
  args: {},
  handler: async (
    ctx
  ): Promise<{ connected: boolean; chargesEnabled: boolean; payoutsEnabled: boolean }> => {
    const gym = await requireOwnerGym(ctx);

    if (!gym.stripeConnectAccountId) {
      return { connected: false, chargesEnabled: false, payoutsEnabled: false };
    }

    const stripe = readStripeClient();
    if (!stripe) {
      throw new ConvexError(
        "Couldn't check your member billing status just now. Your account is unaffected — try again shortly."
      );
    }

    const stripeConnectAccount = await stripe.accounts.retrieve(gym.stripeConnectAccountId);
    const chargesEnabled = stripeConnectAccount.charges_enabled === true;
    const payoutsEnabled = stripeConnectAccount.payouts_enabled === true;

    await ctx.runMutation(internal.connect.setConnectAccountStatus, {
      gymId: gym._id,
      chargesEnabled,
      payoutsEnabled,
    });

    return { connected: true, chargesEnabled, payoutsEnabled };
  },
});
