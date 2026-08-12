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
import { Doc, Id } from "./_generated/dataModel";
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
const PRODUCTION_RETURN_ORIGINS = ["https://www.kombatdesk.com", "https://kombatdesk.com"];

// http://localhost:3000 used to sit in the list above, which meant a localhost
// return origin was accepted by the one PRODUCTION Convex deployment — this
// module is compiled into `limitless-raven-596`, and a constant cannot tell
// which environment it is running in.
//
// It comes from the Convex environment instead. Dev and prod are SEPARATE Convex
// deployments with separate variable stores (`polished-peacock-100` vs
// `limitless-raven-596`), so setting it on dev and never on prod makes the
// permission simply absent in production rather than conditionally ignored.
// That is the same separation `docs/stripe-key-gap-closed-2026-08-09.md` is
// about: Convex has its own env, and reasoning from Vercel's tells you nothing.
//
// Unset is the safe state — no extra origin is permitted. To develop locally:
//   npx convex env set CONNECT_DEV_RETURN_ORIGIN http://localhost:3000
// Never set it with `--prod`.
function allowedReturnOrigins(): Set<string> {
  const devOrigin = process.env.CONNECT_DEV_RETURN_ORIGIN;
  return new Set(devOrigin ? [...PRODUCTION_RETURN_ORIGINS, devOrigin] : PRODUCTION_RETURN_ORIGINS);
}

// A connected account that no longer exists, as opposed to Stripe being briefly
// unreachable. The distinction is the whole point: we clear the gym's
// charge/payout flags on a definite gone signal, and a transient failure must
// NOT do that — a Stripe blip would otherwise mark every gym unable to charge.
//
// Same narrowing discipline as isCouponSpecificError in
// app/api/stripe/checkout/route.ts and the invalid_signature/retry split in
// convex/stripeWebhookAction.ts: only invalid-request errors are considered, and
// never the connection/rate-limit/API classes, which always mean "ask again".
//
// Closure is a real path, not a hypothesis — verified 2026-08-09 that a
// connected account carrying multiple v2 configurations must be closed via
// v2/core/accounts/close, and a closed account is exactly what these two calls
// then hit.
function isAccountGoneError(err: unknown): boolean {
  if (!(err instanceof Stripe.errors.StripeInvalidRequestError)) return false;
  if (err.code === "resource_missing" || err.code === "account_invalid") return true;
  const message = err.message?.toLowerCase() ?? "";
  return (
    message.includes("no such account") ||
    message.includes("account is closed") ||
    message.includes("does not exist")
  );
}

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

// Records that the gym can no longer charge, and returns the error to throw.
//
// Shared by BOTH Stripe calls that take an existing account id. Handling only
// the status refresh would have left the other half open: because we keep
// stripeConnectAccountId (below), an owner whose account is closed still sees
// "Finish setup", which calls accountLinks.create against that dead id and
// fails identically.
//
// Clears connectChargesEnabled/connectPayoutsEnabled. Stage D's gate is
// "nothing may create a charge until chargesEnabled is true", so a stale `true`
// on a closed account is a live hazard, not a cosmetic one. Fail closed.
//
// Deliberately does NOT clear stripeConnectAccountId. It is the only link
// between this gym and its historical duesInvoices rows, and clearing it would
// make the next click silently create a SECOND connected account. Same instinct
// as archiving members rather than hard-deleting them.
//
// KNOWN GAP, deliberately not closed here: keeping the id means there is no
// self-serve way back — the card offers "Finish setup" and lands here again.
// A real reconnect needs a schema field marking the old account dead while
// preserving it for the audit trail, and stage C is being rebuilt once spec §1a
// resolves. So the copy points at a human instead of at a button that cannot work.
//
// Returns rather than throws so the call sites read `throw await …` and TypeScript
// can see the path terminates.
async function goneAccountError(
  ctx: ActionCtx,
  gymId: Id<"gyms">,
  stripeConnectAccountId: string,
  err: unknown
): Promise<ConvexError<string>> {
  console.error(
    `Connect: connected account ${stripeConnectAccountId} for gym ${gymId} is gone (closed or deleted). ` +
      `Clearing charge/payout flags; keeping the account id so the duesInvoices trail survives.`,
    err
  );
  await ctx.runMutation(internal.connect.setConnectAccountStatus, {
    gymId,
    chargesEnabled: false,
    payoutsEnabled: false,
  });
  return new ConvexError(
    "Your gym's Stripe account is no longer available — it looks like it was closed. " +
      "Member billing is switched off so nothing can be charged. Email kombatdesk@outlook.com and we'll get it reconnected."
  );
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

    if (!allowedReturnOrigins().has(origin)) {
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
    //
    // Wrapped because stripeConnectAccountId may be one we stored earlier and
    // the gym has since closed at Stripe. That is reachable precisely BECAUSE
    // goneAccountError keeps the id: the card keeps offering "Finish setup".
    // An unhandled throw here is redacted to "Server Error" in production and
    // the owner hits a dead end — the failure convex/gyms.ts:assertReadAccess
    // uses ConvexError to avoid. A freshly created account cannot be gone, so
    // in practice this only fires on the reuse path.
    let accountLink: Stripe.AccountLink;
    try {
      accountLink = await stripe.accountLinks.create({
        account: stripeConnectAccountId,
        refresh_url: `${origin}/dashboard?connect=refresh`,
        return_url: `${origin}/dashboard?connect=return`,
        type: "account_onboarding",
      });
    } catch (err) {
      if (isAccountGoneError(err)) {
        throw await goneAccountError(ctx, gym._id, stripeConnectAccountId, err);
      }
      // Anything else — Stripe unreachable, rate limited, transient API fault —
      // rethrows untouched and changes no stored state. Clearing the flags on a
      // blip would mark a healthy gym unable to charge.
      throw err;
    }

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

    // A gym can close its connected account at Stripe at any time, and this
    // read is where we find out. Unhandled, the raw Stripe error is redacted to
    // a generic "Server Error" in production and the owner is left staring at a
    // card that cannot explain itself.
    let stripeConnectAccount: Stripe.Account;
    try {
      stripeConnectAccount = await stripe.accounts.retrieve(gym.stripeConnectAccountId);
    } catch (err) {
      if (isAccountGoneError(err)) {
        throw await goneAccountError(ctx, gym._id, gym.stripeConnectAccountId, err);
      }
      // Transient. Say so, and leave every stored flag exactly as it was — a
      // Stripe outage must not be recorded as "this gym cannot charge".
      console.error(`Connect: status refresh failed for gym ${gym._id}; leaving stored flags unchanged:`, err);
      throw new ConvexError(
        "Couldn't check your member billing status just now. Nothing has changed on your account — try again shortly."
      );
    }

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
