"use node";

// Stripe Connect member billing — the connected-account webhook (stage C1).
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
// into app/api/stripe/webhook/route.ts or convex/stripeWebhookAction.ts: this
// stream is v2 event notifications signed with a DIFFERENT secret, and the
// platform stream is load-bearing for provisioning a gym that has already paid.
// Two streams, two secrets, two dedupe tables, so either can be purged,
// replayed or debugged without touching the other.
//
// ─────────────────────────────────────────────────────────────────────────────
// ACCOUNTS V2 EVENTS ARE NOT CONNECT EVENTS. READ THIS BEFORE EDITING.
//
// The v1 mental model — register under "Connected accounts", verify with
// `stripe.webhooks.constructEvent`, read `event.account` — is wrong here, in
// all three parts. Read verbatim from the Stripe dashboard 2026-08-18:
//
//   "Accounts v2 events route differently than v1. Events for v2 accounts that
//    belong directly to your platform are delivered to Your account
//    destinations, not Connected accounts as in v1."
//
// So:
//   1. THE ENDPOINT IS REGISTERED AT "YOUR ACCOUNT" SCOPE, not "Connected
//      accounts". An endpoint at Connect scope receives nothing at all.
//   2. THE PARSER IS `stripe.parseEventNotification`, an instance method on the
//      client — NOT `stripe.webhooks.constructEvent`, and NOT the older
//      `parseThinEvent`, which no longer exists in stripe@22.3.0.
//      Verified in node_modules/stripe/esm/stripe.core.d.ts:330 and
//      node_modules/stripe/esm/Webhooks.js:26, where constructEvent now THROWS
//      on a `v2.core.event` payload rather than returning something usable.
//   3. THERE IS NO `event.account`. `EventBase`
//      (node_modules/stripe/esm/resources/V2/Core/Events.d.ts:25-58) has no
//      such field. The account id arrives as `related_object.id`.
//
// ─────────────────────────────────────────────────────────────────────────────
// DO NOT CALL `fetchRelatedObject()`. THIS ONE WOULD DISABLE BILLING SILENTLY.
//
// The notification carries `fetchRelatedObject()`, and it looks exactly like the
// re-fetch this handler wants. It is not. Read
// node_modules/stripe/esm/stripe.core.js:544-554: it raw-GETs
// `related_object.url` with NO query parameters, so it cannot pass
// `include: ["configuration.merchant"]`. Merchant configuration is an OPT-IN
// include on Accounts v2, so the Account it returns has
// `configuration.merchant` UNDEFINED.
//
// Feed that to extractConnectStatus and every field comes back false/undefined,
// because lib/connectStatus.ts fails closed by design. We would then write
// chargesEnabled: false onto a gym Stripe has just ENABLED — the exact
// backwards-status failure the re-fetch exists to prevent, arriving through the
// convenience helper. Use `related_object.id` for the id, and retrieve the
// account explicitly with the include list, as connectOnboarding.ts does.
import Stripe from "stripe";
import { action, ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { extractConnectStatus } from "../lib/connectStatus";

// Pinned explicitly, matching convex/connectOnboarding.ts. Never inherited: the
// account shape this reads is v2, and an SDK upgrade silently moving the default
// would change what `configuration.merchant` means underneath us.
const STRIPE_API_VERSION = "2026-06-24.dahlia";

// The account is closed. Handled separately below because it is the one event
// where re-fetching is guaranteed to fail.
const ACCOUNT_CLOSED = "v2.core.account.closed";

// Event types this handler acts on. Checked BEFORE the dedupe claim so the
// events we ignore do not fill the table.
//
// WHY THREE AND NOT ONE. Capability status lives two levels down, at
// `configuration.merchant.capabilities.card_payments.status`, and the v2
// catalogue models `v2.core.account[configuration.merchant].capability_status_updated`
// as its own event alongside the parent `v2.core.account.updated`.
//
// RECORDED AS INFERENCE, NOT AS DOCUMENTED FACT (the distinction §1a exists to
// protect): the dashboard's event descriptions do not state coverage, so we are
// reasoning from catalogue structure — Stripe would not model a separate
// capability event if the parent already fired for capability changes. The
// handler is idempotent and re-fetches regardless of which one arrives, so
// subscribing to both costs a duplicate delivery, while guessing wrong costs a
// gym that silently never goes live. Redundancy is the cheap side of that trade.
//
// These strings must match the Stripe dashboard subscription exactly, brackets
// included. They are the SDK's own literals — see
// node_modules/stripe/esm/resources/V2/Core/Events.d.ts:381-490.
//
// TYPED, NOT JUST LISTED. A typo in the bracketed name — a missing bracket, a
// dot where Stripe uses none — would make this handler ignore that event
// FOREVER, and nothing at runtime would ever say so: Stripe would report 200,
// the dashboard would look green, and the gym would never go live. Checking the
// list against the SDK's own literal union turns that typo into a build error.
//
// `satisfies` rather than a type annotation, deliberately: an annotation widens
// the array to the whole union and throws away the literal tuple, which is what
// the narrowing below is built from.
const HANDLED_EVENT_TYPE_LIST = [
  "v2.core.account.updated",
  "v2.core.account[configuration.merchant].capability_status_updated",
  ACCOUNT_CLOSED,
] as const satisfies ReadonlyArray<Stripe.V2.Core.EventNotification["type"]>;

const HANDLED_EVENT_TYPES: ReadonlySet<string> = new Set(HANDLED_EVENT_TYPE_LIST);

// NOT EVERY NOTIFICATION HAS A RELATED OBJECT, and this is why the runtime
// filter has to be a type guard rather than a bare `Set.has`.
//
// `Stripe.V2.Core.EventNotification` is a union across the whole v2 catalogue,
// and some members carry no `related_object` field at all — see
// `V1BillingMeterNoMeterFoundEventNotification`
// (node_modules/stripe/esm/resources/V2/Core/Events.d.ts:244-247), which has
// only `type` and `fetchEvent`. So `notification.related_object` is not readable
// until the union has been narrowed to the three we subscribe to, all of which
// do carry it. `Set.has(string)` filters at runtime but narrows nothing, which
// is exactly the build error this replaced.
type HandledEventType = (typeof HANDLED_EVENT_TYPE_LIST)[number];

type HandledNotification = Extract<
  Stripe.V2.Core.EventNotification,
  { type: HandledEventType }
>;

function isHandledNotification(
  notification: Stripe.V2.Core.EventNotification
): notification is HandledNotification {
  return HANDLED_EVENT_TYPES.has(notification.type);
}

type WebhookResult = { status: "ok" } | { status: "invalid_signature" } | { status: "retry" };

// Reads the account fresh and writes what Stripe currently says, ignoring the
// state embedded in the notification.
//
// Stripe does not guarantee delivery order. The notification is used for exactly
// one thing — the account id — because a stale update landing after a newer one
// would otherwise roll a gym's status backwards, and on this stream that means
// flipping chargesEnabled off under a gym Stripe has just enabled. Re-fetching
// makes the write ordering-immune with no version bookkeeping: in whatever order
// notifications arrive, every one converges on the same current truth. Same
// reasoning, same wording, as convex/stripeWebhookAction.ts:processEvent.
//
// v2 notifications are thin by construction — they carry no object state at all
// — so this design is now structurally forced rather than merely chosen.
async function applyAccountState(
  ctx: ActionCtx,
  stripe: Stripe,
  stripeConnectAccountId: string,
  eventType: string
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
      `Connect webhook: ${eventType} for ${stripeConnectAccountId}, which matches no gym — ignoring.`
    );
    return;
  }

  // Closure is terminal, and the retrieve below would 404 on it. Clear the
  // capability flags directly instead.
  //
  // DELIBERATELY NOT connectOnboarding.ts:goneAccountError. That helper returns
  // a ConvexError carrying owner-facing copy ("Email kombatdesk@outlook.com and
  // we'll get it reconnected") for a modal that does not exist on this path —
  // there is nobody on the other end of a webhook. Same state change, no UI copy.
  //
  // stripeConnectAccountId is left in place on purpose, same as there: it is the
  // only link between this gym and its historical duesInvoices rows, and
  // clearing it would make the next click silently create a SECOND account.
  if (eventType === ACCOUNT_CLOSED) {
    console.error(
      `Connect webhook: account ${stripeConnectAccountId} for gym ${gym._id} was CLOSED at Stripe. ` +
        `Clearing charge/payout flags; keeping the account id so the dues trail survives.`
    );
    await ctx.runMutation(internal.connect.setConnectAccountStatus, {
      gymId: gym._id,
      chargesEnabled: false,
      payoutsEnabled: false,
    });
    return;
  }

  // The include list is what makes this different from fetchRelatedObject().
  // See the header comment — without it, configuration.merchant is absent and
  // the write below would disable a live gym.
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
    `Connect webhook: gym ${gym._id} account ${stripeConnectAccountId} (${eventType}) — ` +
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

    // Verifies the signature and returns the thin notification. Sync is correct
    // here: this module is "use node", so the default Node crypto provider is
    // available. (parseEventNotificationAsync exists for edge/Web-Crypto
    // runtimes — Convex's default runtime, not this one.)
    let notification: Stripe.V2.Core.EventNotification;
    try {
      notification = stripe.parseEventNotification(payload, signature, connectWebhookSecret);
    } catch (err) {
      // Two different failures land here and they must not be logged as one.
      //
      // A v1 webhook payload posted to this route makes parseEventNotification
      // throw a plain Error (stripe.core.js:529) — that is a misconfigured
      // endpoint, not a bad secret, and answering 400 "invalid signature" sends
      // whoever is debugging to rotate a perfectly healthy secret.
      if (err instanceof Stripe.errors.StripeSignatureVerificationError) {
        console.error("Connect webhook: signature verification failed:", err);
        return { status: "invalid_signature" };
      }
      console.error(
        "Connect webhook: payload was not a v2 event notification. This endpoint must be " +
          "registered at YOUR ACCOUNT scope for Accounts v2 events — a v1 webhook pointed here " +
          "will land in exactly this branch:",
        err
      );
      return { status: "invalid_signature" };
    }

    if (!isHandledNotification(notification)) return { status: "ok" };

    // The account id, and the only thing read out of the notification. v2
    // notifications are thin: `related_object` is a pointer, not state.
    //
    // Typed non-null on all three handled variants, but guarded anyway. The SDK
    // types a notification it does not recognise as
    // `related_object: RelatedObject | null`, and `EventNotification` is a closed
    // union that does NOT include `UnknownEventNotification` — so TypeScript's
    // view of this stream is narrower than what Stripe can actually send, and a
    // future event type reaching this line would arrive as a shape the narrowing
    // above believes is impossible.
    const stripeConnectAccountId = notification.related_object?.id;
    if (!stripeConnectAccountId) {
      console.error(
        `Connect webhook: ${notification.type} (${notification.id}) arrived with no ` +
          `related_object. Nothing to act on — check what the dashboard is sending here.`
      );
      return { status: "ok" };
    }

    // Stripe retries as normal operation, so this handler WILL see the same
    // event more than once — and now deliberately more than that, since two
    // subscribed event types can describe one capability change. The write is an
    // idempotent re-fetch, so a duplicate is harmless in itself; the claim keeps
    // the log honest and is what makes the release-on-failure path meaningful.
    const claimed = await ctx.runMutation(internal.stripeConnectEvents.claimConnectEventId, {
      eventId: notification.id,
    });
    if (!claimed) {
      console.log(
        `Connect webhook: event ${notification.id} (${notification.type}) already processed — ignoring duplicate.`
      );
      return { status: "ok" };
    }

    try {
      await applyAccountState(ctx, stripe, stripeConnectAccountId, notification.type);
      return { status: "ok" };
    } catch (err) {
      // An invalid-request error means Stripe rejected the call itself — the
      // account is gone, or our include list is wrong. Neither improves on
      // retry, so stop rather than burning redeliveries forever.
      //
      // NOTHING IS WRITTEN ON THIS PATH, deliberately. It is tempting to clear
      // the capability flags on "no such account", but this branch cannot tell
      // a closed account from a malformed request, and clearing flags from an
      // ambiguous error would disable billing for a healthy gym on a deploy
      // typo. Real closure has its own event — ACCOUNT_CLOSED above — and the
      // owner-initiated path still narrows properly in
      // connectOnboarding.ts:isAccountGoneError.
      if (err instanceof Stripe.errors.StripeInvalidRequestError) {
        console.error(
          `Connect webhook: Stripe rejected the re-fetch for ${stripeConnectAccountId} ` +
            `(event ${notification.id}, ${notification.type}). Not retrying, not changing stored ` +
            `state. If this repeats for every event, the include list or API version is wrong:`,
          err
        );
        return { status: "ok" };
      }

      // Release before asking for a retry, or the claim above would make
      // Stripe's redelivery look like a duplicate and the event would be lost.
      // On this stream that is worse than on the platform one: this is the only
      // thing that ever observes a gym going live, so a swallowed retry leaves
      // the gym stuck with nothing scheduled to fix it.
      console.error(
        `Connect webhook: processing failed for event ${notification.id} (${notification.type}) — releasing claim:`,
        err
      );
      await ctx.runMutation(internal.stripeConnectEvents.releaseConnectEventId, {
        eventId: notification.id,
      });
      return { status: "retry" };
    }
  },
});
