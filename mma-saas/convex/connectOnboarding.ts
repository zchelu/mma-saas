"use node";

// Stripe Connect member billing — the Stripe half of stage C (spec §5.1).
//
// NOTHING HERE CHARGES ANYTHING. This module creates a connected account and
// mints short-lived Account Session secrets so the browser can mount Stripe's
// embedded components. No Customer, no Price, no Subscription, no charge.
// Those are stages D–F.
//
// Split from convex/connect.ts because the Stripe SDK needs the Node runtime and
// Convex allows only actions in a "use node" module — every query and mutation
// this file calls lives there. Same split, same reason, as convex/http.ts and
// convex/stripeWebhookAction.ts.
//
// VARIANT 7, decided 2026-08-13 (spec §1a). Read that before touching the
// account config below: the shape was probed against the sandbox and every field
// diffed against what came back, because dashboard type is IMMUTABLE per account
// and a wrong value means every gym gets recreated and re-onboarded.
import Stripe from "stripe";
import { action, ActionCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { ConvexError } from "convex/values";

// Pinned explicitly, never inherited from the SDK default. Variant 7 is
// generally available; the express + Stripe-losses combination that would have
// required 2026-07-29.preview was rejected because Stripe declined in writing to
// commit that preview-era accounts will behave like post-GA ones (spec §1a).
const STRIPE_API_VERSION = "2026-06-24.dahlia";

// AGENTS.md §7: read into a variable, branch, construct after. `new
// Stripe(undefined!)` throws SYNCHRONOUSLY, so constructing above the guard puts
// the throw above every catch in the caller — the exact shape of the webhook
// outage in docs/stripe-key-gap-closed-2026-08-09.md.
//
// These are CONVEX environment variables, set in the Convex dashboard. Vercel
// having STRIPE_SECRET_KEY says nothing about whether Convex does; that is what
// made the webhook instance invisible across three handoffs.
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
// action, and the verified subject passed down explicitly — see
// convex/connect.ts:getGymForConnect for why that beats relying on auth
// propagating through ctx.runQuery.
async function requireOwnerGym(ctx: ActionCtx): Promise<Doc<"gyms">> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError("You need to be signed in to set up member billing.");
  return await ctx.runQuery(internal.connect.getGymForConnect, { clerkUserId: identity.subject });
}

// A connected account that no longer exists, as opposed to Stripe being briefly
// unreachable. The distinction is the whole point: we clear the gym's
// charge/payout flags on a definite gone signal, and a transient failure must
// NOT do that — a Stripe blip would otherwise mark every gym unable to charge.
//
// Same narrowing discipline as isCouponSpecificError in
// app/api/stripe/checkout/route.ts and the invalid_signature/retry split in
// convex/stripeWebhookAction.ts: only invalid-request errors count, never the
// connection/rate-limit/API classes, which always mean "ask again".
//
// Closure is a real path. Verified 2026-08-09 that an account carrying multiple
// v2 configurations must be closed via v2/core/accounts/close, and a closed
// account is exactly what the calls below then hit.
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

// Records that the gym can no longer charge, and returns the error to throw.
//
// Clears connectChargesEnabled/connectPayoutsEnabled. Stage D's gate is "nothing
// may create a charge until chargesEnabled is true", so a stale `true` on a
// closed account is a live hazard. Fail closed.
//
// Deliberately does NOT clear stripeConnectAccountId: it is the only link
// between this gym and its historical duesInvoices rows, and clearing it would
// make the next click silently create a SECOND connected account. Same instinct
// as archiving members rather than hard-deleting them.
//
// KNOWN GAP, deliberately open: keeping the id means there is no self-serve way
// back. A real reconnect needs a schema field marking the old account dead while
// preserving it for the audit trail. The copy points at a human rather than at a
// button that cannot work.
//
// Returns rather than throws so call sites read `throw await …` and TypeScript
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

// Creates the gym's connected account if it has none. Returns the id either way.
//
// THE CONFIG IS IMMUTABLE AND WAS PROBED BEFORE IT WAS WRITTEN. Spec §1a:
// dashboard type cannot be changed after creation, so a wrong value means every
// gym is recreated and re-onboarded, KYC included.
async function ensureConnectedAccount(
  ctx: ActionCtx,
  stripe: Stripe,
  gym: Doc<"gyms">
): Promise<string> {
  if (gym.stripeConnectAccountId) return gym.stripeConnectAccountId;

  // Accounts v2. The SDK emits a runtime warning on every v1 accounts.create
  // recommending v2, and v2 is where Stripe directs new platforms.
  const created = await stripe.v2.core.accounts.create(
    {
      contact_email: gym.email,
      display_name: gym.name,
      // VARIANT 7. "none" means no Stripe-hosted dashboard, which is precisely
      // why this stage builds embedded components instead. Immutable.
      dashboard: "none",
      identity: {
        // UPPERCASE, deliberately. "us" is accepted and silently stored as "US"
        // (ISO 3166-1 canonical casing). Country is IMMUTABLE, so send the
        // canonical form and keep any comparison case-insensitive. This was
        // previously inherited by omission, which is exactly what §1a exists to
        // stop.
        country: "US",
        entity_type: "company",
      },
      configuration: {
        merchant: {
          // 7997 — membership clubs, sports and recreation. Set by us because
          // otherwise Stripe asks the gym owner to choose their own MCC
          // mid-onboarding and they will choose wrong. It is also exactly the
          // kind of friction that disqualified the full-dashboard variant.
          //
          // configuration.merchant.mcc is the v2 location; business_profile.mcc
          // is v1 and does not exist here.
          mcc: "7997",
          // Direct charges need card_payments. Do NOT add stripe_balance here:
          // it is recipient-scoped and the endpoint rejects it under merchant
          // ("Unknown field"), yet payouts still comes back on the response at
          // merchant.capabilities.stripe_balance.payouts. Measured, not assumed.
          capabilities: { card_payments: { requested: true } },
        },
      },
      defaults: {
        currency: "usd",
        responsibilities: {
          // READS BACKWARDS — "stripe" here means the GYM pays Stripe's
          // processing fees directly, with KombatDesk never in the middle. v1
          // spelled the same decision `fees.payer: "account"`. The v2 field is
          // named for who COLLECTS, not who pays, so a mechanical port of the v1
          // value would land on "application" and route every gym's processing
          // through our own Stripe balance. Confirmed by reading one account
          // through both API versions.
          fees_collector: "stripe",
          // Stripe bears negative balances, not KombatDesk. This is the whole
          // reason variant 7 was chosen, and the reason the three embedded
          // components are mandatory. Do not change without reading §1a and §8.2.
          losses_collector: "stripe",
          // requirements_collector is NOT settable — it is derived, and passing
          // it returns "Unknown field". It comes back "stripe", meaning Stripe
          // still collects and chases KYC even with dashboard "none".
        },
      },
      include: ["configuration.merchant", "identity", "requirements"],
    },
    { apiVersion: STRIPE_API_VERSION }
  );

  const claim = await ctx.runMutation(internal.connect.claimStripeConnectAccountId, {
    gymId: gym._id,
    stripeConnectAccountId: created.id,
  });

  if (!claim.stored) {
    // Two starts raced and the other stored first. Ours is now an empty orphan
    // at Stripe. Continue with the id that actually stuck — overwriting would
    // strand the gym's real account — and log both so the orphan can be removed.
    console.error(
      `Connect onboarding: raced account creation for gym ${gym._id}. ` +
        `Orphaned connected account ${created.id} (delete it in the Stripe dashboard); ` +
        `continuing with the stored account ${claim.stripeConnectAccountId}.`
    );
  }
  return claim.stripeConnectAccountId;
}

// Mints a short-lived Account Session secret for the embedded components.
//
// REPLACES accountLinks.create. There is no redirect any more, so there is no
// return_url, no refresh_url, no ?connect=return hop, and no origin allowlist —
// with no return target there is nothing to validate, so that control deleted
// itself along with CONNECT_DEV_RETURN_ORIGIN.
//
// CALLED REPEATEDLY, NOT ONCE. client_secret expires, and connect-js takes a
// `fetchClientSecret` callback that it re-invokes whenever it needs a fresh one.
// So this is a session factory rather than a one-shot handoff, and it has to
// stay cheap and idempotent.
//
// Account Sessions are v1-only in stripe@22.3.0. Passing a v2 account id to a v1
// endpoint is documented as supported — "the response is structured as a v1
// Account, but any updates still apply to the corresponding properties of the v2
// object" — so accounts are created on v2 and sessions minted on v1.
//
// All three components are enabled because Stripe REQUIRES them wherever it
// bears losses, which is what variant 7 chose. account_management and
// notification_banner are not optional extras: with dashboard "none" the gym has
// no Stripe-hosted surface at all, so these are the only place an owner can see
// or fix anything, and notification_banner is what actually prompts remediation
// — which is why the status codes we store are captured and not branched on.
export const createConnectSession = action({
  args: {},
  handler: async (ctx): Promise<{ clientSecret: string }> => {
    const stripe = readStripeClient();
    if (!stripe) {
      throw new ConvexError(
        "Member billing setup is temporarily unavailable. Nothing has changed on your account — try again shortly."
      );
    }

    const gym = await requireOwnerGym(ctx);
    const stripeConnectAccountId = await ensureConnectedAccount(ctx, stripe, gym);

    try {
      const session = await stripe.accountSessions.create({
        account: stripeConnectAccountId,
        components: {
          account_onboarding: { enabled: true },
          account_management: { enabled: true },
          notification_banner: { enabled: true },
        },
      });
      return { clientSecret: session.client_secret };
    } catch (err) {
      if (isAccountGoneError(err)) {
        throw await goneAccountError(ctx, gym._id, stripeConnectAccountId, err);
      }
      // Transient — Stripe unreachable, rate limited, API fault. Rethrow without
      // touching stored state; clearing flags on a blip would mark a healthy gym
      // unable to charge.
      console.error(`Connect: could not mint an account session for gym ${gym._id}:`, err);
      throw new ConvexError(
        "Couldn't open member billing setup just now. Nothing has changed on your account — try again shortly."
      );
    }
  },
});

// Asks Stripe what the connected account can actually do, and records it.
//
// THERE IS NO ARRIVAL EVENT ANY MORE, and that is the important consequence of
// dropping the redirect. The old flow returned to a return_url, and that
// redirect was the signal to re-check. Embedded components never navigate: the
// component's exit callback fires when the OWNER CLOSES THE PANEL, which is not
// when Stripe finishes reviewing them. An owner can complete everything, close
// the panel while verification is still running, and be enabled minutes later
// with our UI none the wiser.
//
// So this is a best-effort poll, and STAGE D'S account.updated WEBHOOK IS
// LOAD-BEARING RATHER THAN A CONVENIENCE. It is the only thing that will ever
// observe the transition to enabled for an owner who has closed the panel. Until
// it ships, a gym can be live at Stripe and still read "Setup incomplete" here
// until somebody presses refresh.
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

    let stripeConnectAccount;
    try {
      stripeConnectAccount = await stripe.v2.core.accounts.retrieve(
        gym.stripeConnectAccountId,
        { include: ["configuration.merchant", "requirements"] },
        { apiVersion: STRIPE_API_VERSION }
      );
    } catch (err) {
      if (isAccountGoneError(err)) {
        throw await goneAccountError(ctx, gym._id, gym.stripeConnectAccountId, err);
      }
      console.error(`Connect: status refresh failed for gym ${gym._id}; leaving stored flags unchanged:`, err);
      throw new ConvexError(
        "Couldn't check your member billing status just now. Nothing has changed on your account — try again shortly."
      );
    }

    // v2 reports per-capability status rather than v1's booleans. A brand-new
    // unonboarded account reads "restricted" with a requirements_past_due code —
    // NOT "pending" — which is why both the status and its codes are stored, and
    // why the booleans alone were lossy.
    const merchant = stripeConnectAccount.configuration?.merchant;
    const cardPayments = merchant?.capabilities?.card_payments;
    const payouts = merchant?.capabilities?.stripe_balance?.payouts;

    const codesOf = (details: Array<{ code?: string }> | undefined): string[] =>
      (details ?? []).map((d) => d.code).filter((c): c is string => typeof c === "string");

    const chargesEnabled = cardPayments?.status === "active";
    const payoutsEnabled = payouts?.status === "active";

    await ctx.runMutation(internal.connect.setConnectAccountStatus, {
      gymId: gym._id,
      chargesEnabled,
      payoutsEnabled,
      chargesStatus: cardPayments?.status,
      chargesStatusCodes: codesOf(cardPayments?.status_details),
      payoutsStatus: payouts?.status,
      payoutsStatusCodes: codesOf(payouts?.status_details),
    });

    return { connected: true, chargesEnabled, payoutsEnabled };
  },
});
