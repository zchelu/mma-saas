"use node";

// Stripe Connect member billing — the account.updated webhook (stage D, C1).
//
// THIS IS LOAD-BEARING, NOT A CONVENIENCE. Stage C replaced the hosted-redirect
// onboarding with embedded components, and embedded components never navigate.
// There is no return_url, so there is no arrival event. The component's exit
// callback fires when the OWNER CLOSES THE PANEL, which is not when Stripe
// finishes reviewing them — an owner can complete everything, close the panel
// while verification runs, and be enabled minutes later.
//
// This webhook is the ONLY thing that ever learns an account went live. Without
// it a gym sits enabled at Stripe and "Setup incomplete" in our UI until
// somebody happens to press refresh, and nothing is scheduled to correct that.
//
// SEPARATE FROM THE PLATFORM WEBHOOK, BY DECISION (spec §1). Do not fold this
// into app/api/stripe/webhook/route.ts or convex/stripeWebhookAction.ts:
// connected-account events carry an `account` field and are signed with a
// DIFFERENT secret, and the platform stream is load-bearing for provisioning a
// gym that has already paid. Two streams, two secrets, two dedupe tables, so
// either can be purged, replayed or debugged without touching the other.
import Stripe from "stripe";
import { action, ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { extractConnectStatus } from "../lib/connectStatus";

// Pinned explicitly, matching convex/connectOnboarding.ts. Never inherited: the
// account shape this reads is v2, and an SDK upgrade silently moving the default
// would change what `configuration.merchant` means underneath us.
const STRIPE_API_VERSION = "2026-06-24.dahlia";

// Event types this handler acts on. Checked BEFORE the dedupe claim so the
// events Stripe sends that we ignore do not fill the table.
//
// Only account.updated today. Stripe sends a lot on the Connect stream
// (capability.updated, person.updated, account.application.*), and every one of
// them that matters to us is also reflected in the account's own capability
// status — which we re-fetch rather than read from the payload — so subscribing
// to more would be extra deliveries reaching the same conclusion.
const HANDLED_EVENT_TYPES = new Set<string>(["account.updated"]);

type WebhookResult = { status: "ok" } | { status: "invalid_signature" } | { status: "retry" };

// Reads the account fresh and writes what Stripe currently says, ignoring the
// state embedded in the event.
//
// Stripe does not guarantee delivery order. The payload is used for exactly one
// thing — the account id — because a stale account.updated landing after a newer
// one would otherwise roll a gym's status backwards, and on this stream that
// means flipping chargesEnabled off under a gym that Stripe has just enabled.
// Re-fetching makes the write ordering-immune with no version bookkeeping: in
// whatever order events arrive, every one converges on the same current truth.
// Same reasoning, same wording, as convex/stripeWebhookAction.ts:processEvent.
async function applyAccountState(
  ctx: ActionCtx,
  stripe: Stripe,
  stripeConnectAccountId: string
): Promise<void> {
  const gym = await ctx.runQuery(internal.connect.getGymByStripeConnectAccountId, {
    stripeConnectAccountId,
  });

  // No gym for this account. Real and expected: an orphan from a raced create
  // (see connect.ts:claimStripeConnectAccountId), or a gym row removed in
  // development. Returning rather than throwing keeps Stripe's retries free for
  // events that can actually succeed — a throw here would retry forever against
  // an account we will never have a gym for, and bury real events behind it.
  if (!gym) {
    console.log(
      `Connect webhook: account.updated for ${stripeConnectAccountId}, which matches no gym — ignoring.`
    );
    return;
  }

  const account = await stripe.v2.core.accounts.retrieve(
    stripeConnectAccountId,
    { include: ["configuration.merchant", "requirements"] },
    { apiVersion: STRIPE_API_VERSION }
  );

  // Shared with connectOnboarding.ts:refreshConnectStatus through
  // lib/connectStatus.ts. Both write these six fields and the extraction lives
  // in one tested place so they cannot disagree about whether a gym can charge.
  const status = extractConnectStatus(account.configuration?.merchant);

  await ctx.runMutation(internal.connect.setConnectAccountStatus, {
    gymId: gym._id,
    ...status,
  });

  console.log(
    `Connect webhook: gym ${gym._id} account ${stripeConnectAccountId} — ` +
      `charges ${status.chargesStatus ?? "unknown"}, payouts ${status.payoutsStatus ?? "unknown"}.`
  );
}

export const verifyAndProcess = action({
  args: { signature: v.string(), payload: v.string() },
  handler: async (ctx, { signature, payload }): Promise<WebhookResult> => {
    // AGENTS.md §7: read into variables, branch, construct after. `new
    // Stripe(undefined!)` throws SYNCHRONOUSLY, above every try/catch here.
    //
    // BOTH are CONVEX environment variables, set in the Convex dashboard, and
    // STRIPE_CONNECT_WEBHOOK_SECRET is a DIFFERENT secret from
    // STRIPE_WEBHOOK_SECRET — the platform endpoint's. Reusing the platform's
    // would fail every signature check on this route and read, from the log, as
    // a hostile caller rather than a misconfiguration.
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
    const connectWebhookSecret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
    if (!stripeSecretKey || !connectWebhookSecret) {
      const missing = [
        !stripeSecretKey && "STRIPE_SECRET_KEY",
        !connectWebhookSecret && "STRIPE_CONNECT_WEBHOOK_SECRET",
      ]
        .filter(Boolean)
        .join(" and ");
      console.error(
        `Connect webhook: ${missing} missing from the CONVEX environment (set in the Convex ` +
          `dashboard — NOT Vercel). Returning retry so Stripe redelivers instead of dropping the ` +
          `event. While this persists, no gym's billing status will ever go live on its own.`
      );
      // Deliberate 500 through the route rather than an unhandled throw: Stripe
      // keeps redelivering, so events survive until the secret is set. Nothing
      // is claimed yet, so there is no claim to release.
      return { status: "retry" };
    }

    const stripe = new Stripe(stripeSecretKey);

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(payload, signature, connectWebhookSecret);
    } catch (err) {
      console.error("Connect webhook signature verification failed:", err);
      return { status: "invalid_signature" };
    }

    if (!HANDLED_EVENT_TYPES.has(event.type)) return { status: "ok" };

    // Connected-account events carry the account they concern. Its absence means
    // this arrived on the wrong endpoint — a platform event pointed at the
    // Connect URL — and processing it would be meaningless rather than harmful,
    // so say so loudly and stop.
    const stripeConnectAccountId = event.account;
    if (!stripeConnectAccountId) {
      console.error(
        `Connect webhook: ${event.type} (${event.id}) has no \`account\` field. This endpoint is ` +
          `for CONNECTED-account events only — check which events the Stripe dashboard is sending here.`
      );
      return { status: "ok" };
    }

    // Stripe retries as normal operation, so this handler WILL see the same
    // event more than once. The write below is an idempotent patch, so a
    // duplicate is harmless in itself — the claim exists to keep the log honest
    // and to match the platform stream's shape, and it is what makes the
    // release-on-failure path below meaningful.
    const claimed = await ctx.runMutation(internal.stripeConnectEvents.claimConnectEventId, {
      eventId: event.id,
    });
    if (!claimed) {
      console.log(
        `Connect webhook: event ${event.id} (${event.type}) already processed — ignoring duplicate.`
      );
      return { status: "ok" };
    }

    try {
      await applyAccountState(ctx, stripe, stripeConnectAccountId);
      return { status: "ok" };
    } catch (err) {
      // Release before asking for a retry, or the claim above would make
      // Stripe's redelivery look like a duplicate and the event would be lost.
      // On this stream that is worse than on the platform one: account.updated
      // is the only thing that ever observes a gym going live, so a swallowed
      // retry leaves the gym stuck with nothing scheduled to fix it.
      console.error(
        `Connect webhook: processing failed for event ${event.id} (${event.type}) — releasing claim:`,
        err
      );
      await ctx.runMutation(internal.stripeConnectEvents.releaseConnectEventId, {
        eventId: event.id,
      });
      return { status: "retry" };
    }
  },
});
