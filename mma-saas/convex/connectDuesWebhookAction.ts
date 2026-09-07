"use node";

// Stripe Connect member billing — the MEMBER DUES webhook (stage 5).
//
// Stage 4 built the dues modules and nothing called them. This is the caller.
// convex/memberBillingStripe.ts:createDuesSetupLink names this file by path in
// its own comment: setup-mode Checkout collects the card and stops, and the
// subscription is created here, when `checkout.session.completed` confirms the
// card is really attached. Until this route exists, every dues link a gym sends
// is a dead end that takes a member's card and does nothing with it.
//
// ─────────────────────────────────────────────────────────────────────────────
// A THIRD WEBHOOK. THIS CANNOT BE FOLDED INTO connectWebhookAction.ts.
//
// Not a preference, a mechanical incompatibility. That handler is built on
// `stripe.parseEventNotification` and Accounts v2 THIN NOTIFICATIONS
// (`v2.core.account.*`), registered at YOUR ACCOUNT scope. Every event below is
// a v1 event with a full object payload, delivered at CONNECTED ACCOUNTS scope.
//
//   - The parsers are mutually exclusive. constructEvent THROWS on a
//     `v2.core.event` payload (Webhooks.js:26); parseEventNotification throws a
//     plain Error on a v1 payload (stripe.core.js:529) and that handler already
//     documents the branch where it answers `invalid_signature` for exactly this
//     mistake. Pointing this stream at that route produces a 400 that reads as a
//     bad secret and sends whoever is debugging to rotate a healthy one.
//   - The secrets are different. Two endpoints, two signing secrets, always.
//   - The scopes are different, and each is wrong for the other stream.
//
// Three streams now, three secrets, three dedupe tables:
//   /stripe/webhook          platform v1     STRIPE_WEBHOOK_SECRET
//   /stripe/connect-webhook  accounts v2     STRIPE_CONNECT_WEBHOOK_SECRET
//   /stripe/dues-webhook     connected v1    STRIPE_CONNECT_DUES_WEBHOOK_SECRET  <- this file
//
// REGISTER THIS URL AT "CONNECTED ACCOUNTS" SCOPE. That is the opposite of the
// instruction on /stripe/connect-webhook, and both are correct — v1 Connect
// routing and Accounts v2 routing genuinely differ. A platform-scoped endpoint
// here receives the platform's own subscription events instead of the gyms',
// and `event.account` arrives undefined; the guard below refuses that case
// loudly rather than resolving a gym from a KombatDesk customer id.
//
// URL: <deployment>.convex.site/stripe/dues-webhook
//
// ─────────────────────────────────────────────────────────────────────────────
// EVERY STRIPE READ BELOW CARRIES A `stripeAccount` HEADER, and the account id
// comes from `event.account` — Stripe's own routing field — never from the gym
// row. The gym row is looked up FROM that id, not the other way round. Omitting
// the header does not fail: it silently reads KombatDesk's own account, where
// the object does not exist, and the handler would then write "no such
// subscription" over a member who is paying fine.
//
// Connect options go in the THIRD argument (RequestOptions), never the second
// (params). Passed as params they are silently ignored — the same trap
// memberBillingStripe.ts:changeMemberPlan documents.
import Stripe from "stripe";
import { action, ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { v } from "convex/values";

// Pinned explicitly, matching convex/memberBillingStripe.ts. Never inherited.
const STRIPE_API_VERSION = "2026-06-24.dahlia";

type WebhookResult = { status: "ok" } | { status: "invalid_signature" } | { status: "retry" };

// Our narrowed dues vocabulary. Must agree with schema.ts:members.duesStatus and
// convex/memberBilling.ts:duesStatus.
type DuesStatus = "active" | "past_due" | "canceled" | "unpaid";

// Event types this handler acts on. Checked BEFORE the dedupe claim so the
// events we ignore do not fill the table.
//
// A connected-account endpoint receives the gym's ENTIRE event stream, including
// everything its own Stripe dashboard generates. This set is the whole contract:
// anything not listed is dropped silently and on purpose.
//
// `invoice.paid`, not `invoice.payment_succeeded`. The platform stream uses the
// latter; they are near-synonyms and subscribing to both would double every
// renewal for no additional fact. `paid` also covers an invoice marked paid out
// of band, which for a gym chasing a member is a real case.
const HANDLED_EVENT_TYPES = new Set<Stripe.Event["type"]>([
  "checkout.session.completed",
  "invoice.paid",
  "invoice.payment_failed",
  "customer.subscription.updated",
  "customer.subscription.deleted",
]);

// Stripe's eight subscription states, narrowed to our four.
//
// LOSSY BY DESIGN, and the losses are the point:
//   trialing -> active     the member is in good standing; nothing is owed yet
//   incomplete -> unpaid   a card was attached but the first charge has not
//                          cleared. NOT "active" — that is the state that would
//                          let a gym believe a member is paying when no money
//                          has moved.
//   incomplete_expired,
//   canceled -> canceled
//   paused -> unpaid       v1 has no pause feature, so this can only arrive if
//                          an owner paused the subscription in their own Stripe
//                          dashboard. "unpaid" overstates it — nothing failed —
//                          but it is the only value that does not tell the gym
//                          money is arriving when none is. Revisit if a real gym
//                          uses pause; a fifth duesStatus is the honest fix.
function toDuesStatus(status: Stripe.Subscription.Status): DuesStatus {
  switch (status) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
      return "past_due";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    case "incomplete":
    case "unpaid":
    case "paused":
      return "unpaid";
    default: {
      // A status Stripe adds after this was written. Deliberately NOT an
      // exhaustiveness assertion (`const _: never = status`): that turns a
      // future SDK bump into a build failure on a file whose job is to keep
      // collecting money, and the safe runtime answer already exists. Never
      // guess "active" — the whole point is that an unrecognised state must not
      // tell a gym money is arriving.
      console.error(
        `Dues webhook: unknown subscription status ${String(status)} — treating as unpaid.`
      );
      return "unpaid";
    }
  }
}

// Reads a subscription fresh from the GYM's account.
//
// The event payload is used for the id and nothing else. Stripe does not
// guarantee delivery order, so a stale `updated` landing after a `deleted` would
// otherwise resurrect a cancelled member's dues, and a stale `deleted` landing
// after an `updated` would tell a gym a paying member stopped. Re-fetching makes
// every write ordering-immune with no version bookkeeping — the same reasoning,
// and deliberately the same wording, as stripeWebhookAction.ts:processEvent and
// connectWebhookAction.ts:applyAccountState.
async function retrieveSubscription(
  stripe: Stripe,
  stripeConnectAccountId: string,
  subscriptionId: string
): Promise<Stripe.Subscription> {
  return await stripe.subscriptions.retrieve(subscriptionId, undefined, {
    stripeAccount: stripeConnectAccountId,
    apiVersion: STRIPE_API_VERSION,
  });
}

function customerIdOf(
  ref: string | Stripe.Customer | Stripe.DeletedCustomer | null | undefined
): string | null {
  if (!ref) return null;
  return typeof ref === "string" ? ref : ref.id;
}

// Mirrors a subscription's current state onto the member.
//
// Resolves the member from the connected-account CUSTOMER id, not from
// metadata: the customer is the durable link (it survives cancellation, because
// it holds the saved card — see memberBilling.clearMemberDuesSubscription),
// while subscription metadata can be edited by the gym owner in their own Stripe
// dashboard. Returns quietly when no member matches; Stripe will send events for
// customers we no longer have a member for, and throwing would burn retries on
// something that can never succeed.
async function applySubscriptionState(
  ctx: ActionCtx,
  gymId: Id<"gyms">,
  subscription: Stripe.Subscription
): Promise<void> {
  const stripeConnectCustomerId = customerIdOf(subscription.customer);
  if (!stripeConnectCustomerId) {
    console.error(`Dues webhook: subscription ${subscription.id} has no customer — nothing to match.`);
    return;
  }

  const member = await ctx.runQuery(internal.memberBilling.getMemberByStripeConnectCustomerId, {
    gymId,
    stripeConnectCustomerId,
  });
  if (!member) {
    console.log(
      `Dues webhook: no member for connected customer ${stripeConnectCustomerId} on gym ${gymId} — ignoring ${subscription.id}.`
    );
    return;
  }

  // A cancelled subscription clears the id so the drawer stops offering to
  // manage it; the Customer and planId survive on purpose (spec §9 — a member
  // who pauses over the summer must not re-enter their card).
  if (subscription.status === "canceled" || subscription.status === "incomplete_expired") {
    await ctx.runMutation(internal.memberBilling.clearMemberDuesSubscription, {
      gymId,
      memberId: member._id,
    });
    return;
  }

  await ctx.runMutation(internal.memberBilling.setMemberDuesSubscription, {
    gymId,
    memberId: member._id,
    stripeConnectSubscriptionId: subscription.id,
    status: toDuesStatus(subscription.status),
  });
}

// The subscription an invoice belongs to.
//
// As of this API version there is NO top-level `invoice.subscription` — it lives
// under `parent.subscription_details`, and both levels are nullable for an
// invoice that is not subscription-driven. Same shape as
// stripeWebhookAction.ts:processEvent, and the same reason for the null branch:
// a gym can raise a one-off invoice by hand in its own dashboard, and that says
// nothing about anyone's dues.
function subscriptionIdOfInvoice(invoice: Stripe.Invoice): string | null {
  const ref = invoice.parent?.subscription_details?.subscription;
  if (!ref) return null;
  return typeof ref === "string" ? ref : ref.id;
}

// Mirrors an invoice into duesInvoices, then syncs the member from the
// subscription behind it.
//
// duesInvoices is the table stage 4 created and never wrote to. It mirrors
// Stripe and is never the origin of a fact, so this upserts on Stripe's invoice
// id and a redelivery converges rather than duplicating.
//
// AMOUNTS ARE INTEGER CENTS, straight off Stripe, and must stay that way.
// `invoices.amount` one table over is DOLLARS AS A FLOAT. Confusing them is a
// silent 100x. Every field written here carries the `Cents` suffix for that
// reason — see the schema comment on invoices.amount.
async function applyInvoice(
  ctx: ActionCtx,
  stripe: Stripe,
  gymId: Id<"gyms">,
  stripeConnectAccountId: string,
  invoice: Stripe.Invoice,
  failedAt: number | null
): Promise<void> {
  const subscriptionId = subscriptionIdOfInvoice(invoice);
  if (!subscriptionId) {
    console.log(`Dues webhook: invoice ${invoice.id} has no subscription — not dues, skipping.`);
    return;
  }
  const stripeConnectCustomerId = customerIdOf(invoice.customer);
  if (!stripeConnectCustomerId) {
    console.error(`Dues webhook: invoice ${invoice.id} has no customer — nothing to match.`);
    return;
  }

  const member = await ctx.runQuery(internal.memberBilling.getMemberByStripeConnectCustomerId, {
    gymId,
    stripeConnectCustomerId,
  });
  if (!member) {
    console.log(
      `Dues webhook: no member for connected customer ${stripeConnectCustomerId} on gym ${gymId} — ignoring invoice ${invoice.id}.`
    );
    return;
  }

  // `status` is nullable on the type. A dues invoice reaching paid/payment_failed
  // always has one; skipping the row is better than inventing a state for a
  // table whose whole contract is that it mirrors Stripe.
  if (invoice.id && invoice.status) {
    await ctx.runMutation(internal.memberBilling.upsertDuesInvoice, {
      gymId,
      memberId: member._id,
      stripeConnectInvoiceId: invoice.id,
      amountDueCents: invoice.amount_due,
      amountPaidCents: invoice.amount_paid,
      status: invoice.status,
      hostedInvoiceUrl: invoice.hosted_invoice_url ?? undefined,
      paidAt: invoice.status_transitions?.paid_at
        ? invoice.status_transitions.paid_at * 1000
        : undefined,
    });
  }

  // Re-fetched, not read off the invoice: Stripe may have already retried a
  // failed payment successfully by the time this event is processed, and the
  // subscription is the only thing that knows.
  const subscription = await retrieveSubscription(stripe, stripeConnectAccountId, subscriptionId);

  if (failedAt !== null) {
    // THE RETENTION SIGNAL (spec §6). duesFailedAt and duesFailureCount are
    // ranking inputs for the at-risk list — a member who missed class AND
    // bounced a payment ranks above either alone. This is the differentiated
    // half of the whole pitch: every competitor holds payment data and spends it
    // on dunning; KombatDesk holds the attendance data too.
    //
    // Deliberately NOT part of lib/memberEligibility.ts:isTextEligibleMember,
    // which answers "may we lawfully text this person". Eligibility and priority
    // must not become the same predicate.
    await ctx.runMutation(internal.memberBilling.recordDuesFailure, {
      gymId,
      memberId: member._id,
      failedAt,
      status: toDuesStatus(subscription.status),
    });
    return;
  }

  await applySubscriptionState(ctx, gymId, subscription);
}

// Creates the subscription once Checkout confirms a card is attached.
//
// The card was collected on Stripe's own page in `setup` mode, so nothing has
// been charged yet and this is the first money-moving step in the whole flow.
async function applyCheckoutCompleted(
  ctx: ActionCtx,
  stripe: Stripe,
  gymId: Id<"gyms">,
  stripeConnectAccountId: string,
  sessionId: string
): Promise<void> {
  // Re-fetched with the SetupIntent expanded. Two reasons, and the second is the
  // one that matters: the embedded payload can be stale, and it does not carry
  // the payment method — which the subscription needs, see below.
  const session = await stripe.checkout.sessions.retrieve(
    sessionId,
    { expand: ["setup_intent"] },
    { stripeAccount: stripeConnectAccountId, apiVersion: STRIPE_API_VERSION }
  );

  if (session.mode !== "setup") {
    // A gym owner can create Payment Links and Checkout Sessions in their own
    // dashboard for anything at all — merch, seminars, a drop-in fee. Those
    // complete on this same stream and are none of our business.
    console.log(`Dues webhook: checkout session ${sessionId} is mode "${session.mode}", not dues — skipping.`);
    return;
  }
  if (session.status !== "complete") {
    console.log(`Dues webhook: checkout session ${sessionId} status "${session.status}" — not acting.`);
    return;
  }

  // Written by memberBillingStripe.createDuesSetupLink. Metadata rather than a
  // query parameter on success_url, because a query parameter is written by the
  // member's browser and this decides what gets charged.
  const gymIdFromMetadata = session.metadata?.kombatdesk_gym_id;
  const memberIdFromMetadata = session.metadata?.kombatdesk_member_id;
  const planIdFromMetadata = session.metadata?.kombatdesk_plan_id;
  if (!gymIdFromMetadata || !memberIdFromMetadata || !planIdFromMetadata) {
    // A setup-mode session on this account that we did not create — the owner
    // saving a card by hand, most likely. Not an error.
    console.log(`Dues webhook: setup session ${sessionId} carries no KombatDesk metadata — skipping.`);
    return;
  }

  // THE CROSS-CHECK. `event.account` is Stripe's routing, `gymId` is the row we
  // resolved from it, and the metadata is what we wrote when the link was made.
  // They must agree. A disagreement means a session created for one gym arrived
  // on another's stream, and the only safe move is to charge nobody.
  if (gymIdFromMetadata !== gymId) {
    console.error(
      `Dues webhook: session ${sessionId} on account ${stripeConnectAccountId} (gym ${gymId}) ` +
        `carries gym ${gymIdFromMetadata} in metadata. Refusing to create a subscription.`
    );
    return;
  }

  // Cast, not parsed: these strings were written by our own action minutes
  // earlier and the gym id above has already been proven to match a real row.
  // A malformed id from here is rejected by the v.id validator at the runQuery
  // boundary, which fails the event and asks Stripe to retry — correct, since a
  // malformed id means something is wrong that a human needs to look at.
  const memberId = memberIdFromMetadata as Id<"members">;
  const planId = planIdFromMetadata as Id<"gymPlans">;

  const member = await ctx.runQuery(internal.memberBilling.getMemberForBilling, { gymId, memberId });
  if (!member) {
    console.error(`Dues webhook: session ${sessionId} names member ${memberId}, which is not a member of gym ${gymId}.`);
    return;
  }
  if (member.stripeConnectSubscriptionId) {
    // Already subscribed — a redelivery, or the owner sent two links. Stripe's
    // idempotency key in createSubscriptionForMember covers the first case; this
    // covers the second, where the session ids differ and the key would not.
    console.log(`Dues webhook: member ${memberId} already has a dues subscription — ignoring session ${sessionId}.`);
    return;
  }

  // RE-READ, NOT TRUSTED FROM METADATA. The link may have sat in the member's
  // inbox for days, and the owner may have archived or re-priced the plan since.
  // getPlanForGym returns null for another gym's plan or an archived one; either
  // way we must not create a subscription against it. This is the seam that
  // setup mode exists to preserve — subscription mode would have charged the
  // stale price the moment the member clicked.
  const plan = await ctx.runQuery(internal.gymPlans.getPlanForGym, { gymId, planId });
  if (!plan || !plan.active || !plan.stripeConnectPriceId) {
    console.error(
      `Dues webhook: plan ${planId} for member ${memberId} is missing, archived, or has no Stripe Price. ` +
        `Card is saved on customer ${member.stripeConnectCustomerId ?? "(none)"}; no subscription created. ` +
        `The owner must re-send a link once the plan is fixed.`
    );
    return;
  }

  const stripeConnectCustomerId =
    customerIdOf(session.customer) ?? member.stripeConnectCustomerId ?? null;
  if (!stripeConnectCustomerId) {
    console.error(`Dues webhook: session ${sessionId} has no customer and member ${memberId} has none stored.`);
    return;
  }

  // THE PAYMENT METHOD MUST BE NAMED EXPLICITLY.
  //
  // Setup-mode Checkout ATTACHES the payment method to the Customer but does not
  // reliably set `invoice_settings.default_payment_method`. A subscription
  // created against a customer with an attached card and no default lands in
  // `incomplete` and never collects — which surfaces to the gym as a member who
  // "signed up" and to us as duesStatus "unpaid" with no failure to explain it.
  // Reading it off the SetupIntent and passing it through is deterministic and
  // does not depend on Checkout's implicit behaviour.
  const setupIntent = session.setup_intent;
  const paymentMethodRef = typeof setupIntent === "string" ? null : setupIntent?.payment_method;
  const defaultPaymentMethodId =
    typeof paymentMethodRef === "string" ? paymentMethodRef : (paymentMethodRef?.id ?? undefined);
  if (!defaultPaymentMethodId) {
    console.error(
      `Dues webhook: session ${sessionId} completed with no payment method on its SetupIntent. ` +
        `Not creating a subscription that could never collect.`
    );
    return;
  }

  await ctx.runAction(internal.memberBillingStripe.createSubscriptionForMember, {
    gymId,
    memberId,
    stripeConnectAccountId,
    stripeConnectCustomerId,
    stripeConnectPriceId: plan.stripeConnectPriceId,
    checkoutSessionId: session.id,
    defaultPaymentMethodId,
  });
}

// Throws on a transient failure so verifyAndProcess can release the dedupe claim
// and ask Stripe to retry. Returns normally for anything permanent — a retry
// cannot fix a session we did not create or a member who no longer exists, and
// failing those would bury the real events behind them.
async function processEvent(
  ctx: ActionCtx,
  stripe: Stripe,
  gymId: Id<"gyms">,
  stripeConnectAccountId: string,
  event: Stripe.Event
): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      await applyCheckoutCompleted(ctx, stripe, gymId, stripeConnectAccountId, session.id);
      break;
    }
    case "invoice.paid": {
      const invoice = event.data.object as Stripe.Invoice;
      await applyInvoice(ctx, stripe, gymId, stripeConnectAccountId, invoice, null);
      break;
    }
    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      // Stripe's own timestamp for the event, in ms. Not Date.now(): a
      // redelivery days later must not move a member's failure date forward and
      // make a stale failure look fresh on the at-risk list.
      await applyInvoice(ctx, stripe, gymId, stripeConnectAccountId, invoice, event.created * 1000);
      break;
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const staleId = (event.data.object as Stripe.Subscription).id;
      const subscription = await retrieveSubscription(stripe, stripeConnectAccountId, staleId);
      await applySubscriptionState(ctx, gymId, subscription);
      break;
    }
  }
}

export const verifyAndProcess = action({
  args: { signature: v.string(), payload: v.string() },
  handler: async (ctx, { signature, payload }): Promise<WebhookResult> => {
    // AGENTS.md §7: read into variables, branch, construct after. `new
    // Stripe(undefined!)` throws SYNCHRONOUSLY, above every try/catch here.
    //
    // BOTH are CONVEX environment variables, set in the Convex dashboard — NOT
    // Vercel. STRIPE_CONNECT_DUES_WEBHOOK_SECRET is a THIRD secret, distinct
    // from STRIPE_WEBHOOK_SECRET and STRIPE_CONNECT_WEBHOOK_SECRET. Reusing
    // either would fail every signature check here and read, from the log, as a
    // hostile caller rather than a misconfiguration.
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
    const duesWebhookSecret = process.env.STRIPE_CONNECT_DUES_WEBHOOK_SECRET;
    if (!stripeSecretKey || !duesWebhookSecret) {
      const missing = [
        !stripeSecretKey && "STRIPE_SECRET_KEY",
        !duesWebhookSecret && "STRIPE_CONNECT_DUES_WEBHOOK_SECRET",
      ]
        .filter(Boolean)
        .join(" and ");
      console.error(
        `Dues webhook: ${missing} missing from the CONVEX environment (set in the Convex dashboard ` +
          `— NOT Vercel). Returning retry so Stripe redelivers instead of dropping the event. ` +
          `While this persists, members are entering cards that never become subscriptions.`
      );
      // Deliberate 500 through the route rather than an unhandled throw: Stripe
      // keeps redelivering, so events survive until the secret is set. Nothing
      // is claimed yet, so there is no claim to release.
      return { status: "retry" };
    }

    const stripe = new Stripe(stripeSecretKey);

    // v1 signature scheme. Sync is correct: this module is "use node", so the
    // default Node crypto provider is available.
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(payload, signature, duesWebhookSecret);
    } catch (err) {
      // A v2 notification posted here throws too. Worth naming in the log,
      // because the fix is a dashboard scope change and not a secret rotation —
      // the mirror image of the branch in connectWebhookAction.ts.
      console.error(
        "Dues webhook: signature verification failed. If the payload was a v2.core.event, this " +
          "endpoint is registered at the wrong scope — it must be CONNECTED ACCOUNTS, v1 events:",
        err
      );
      return { status: "invalid_signature" };
    }

    if (!HANDLED_EVENT_TYPES.has(event.type)) return { status: "ok" };

    // THE CONNECTED ACCOUNT, from Stripe's own routing field. Present on every
    // event delivered to a Connect-scoped endpoint and absent on the platform's
    // own — so this is also the check that catches an endpoint registered at the
    // wrong scope.
    //
    // `ok`, not `retry`: a scope misconfiguration is deterministic, and retrying
    // would burn Stripe's window on something that cannot self-heal while
    // hiding the real cause behind delivery failures.
    const stripeConnectAccountId = event.account;
    if (!stripeConnectAccountId) {
      console.error(
        `Dues webhook: event ${event.id} (${event.type}) arrived with no \`account\` — this endpoint ` +
          `is registered at PLATFORM scope. It must be registered under "Connected accounts". ` +
          `Ignoring, because acting on it would treat a KombatDesk customer as a gym member.`
      );
      return { status: "ok" };
    }

    // The webhook is unauthenticated by nature, so there is no identity to
    // derive a gym from — the account id is the only handle. Null rather than a
    // throw for an unknown account: Stripe delivers events for accounts we have
    // no gym for (a disconnected gym, the orphaned sandbox account), and failing
    // those would burn retries on something that can never succeed.
    const gym = await ctx.runQuery(internal.connect.getGymByStripeConnectAccountId, {
      stripeConnectAccountId,
    });
    if (!gym) {
      console.log(
        `Dues webhook: no gym for connected account ${stripeConnectAccountId} (event ${event.id}) — ignoring.`
      );
      return { status: "ok" };
    }

    // Stripe retries as normal operation, so this handler WILL see the same
    // event more than once. Most writes below are idempotent patches, but
    // createSubscriptionForMember and recordDuesFailure are NOT: the first would
    // start a second subscription against the same card, and the second
    // increments the consecutive-failure count that ranks the at-risk list.
    const claimed = await ctx.runMutation(internal.stripeDuesEvents.claimDuesEventId, {
      eventId: event.id,
    });
    if (!claimed) {
      console.log(`Dues webhook: event ${event.id} (${event.type}) already processed — ignoring duplicate delivery.`);
      return { status: "ok" };
    }

    try {
      await processEvent(ctx, stripe, gym._id, stripeConnectAccountId, event);
      return { status: "ok" };
    } catch (err) {
      // Release before asking for a retry, or the claim above would make
      // Stripe's redelivery look like a duplicate and the event would be lost
      // for good — the failure mode the whole retry mechanism exists to avoid.
      console.error(
        `Dues webhook: processing failed for event ${event.id} (${event.type}) on account ` +
          `${stripeConnectAccountId} — releasing claim:`,
        err
      );
      await ctx.runMutation(internal.stripeDuesEvents.releaseDuesEventId, { eventId: event.id });
      return { status: "retry" };
    }
  },
});
