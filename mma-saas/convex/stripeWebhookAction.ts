"use node";

import Stripe from "stripe";
import { Resend } from "resend";
import { action, ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { PLAN_LABEL, PLAN_PRICE_USD, TRIAL_DAYS, resolvePlanFromPriceId } from "../lib/plans";
import { alertMissingTrialConfirmation, alertUnresolvedPrice } from "../lib/alerts";

const MANAGE_SUBSCRIPTION_URL = "https://kombatdesk.com/billing";

// Every customer-facing date in this file renders in this zone, never the
// runtime default. Convex runs UTC. A subscription created after ~6pm Mountain
// falls on the NEXT UTC day, so an unqualified toLocaleDateString reported a
// trial ending "August 29" when Stripe was set to charge on Aug 28.
//
// Caught live on 2026-07-29 by diffing the sent email against the Stripe
// dashboard for sub_1Tyio4QztS1N9xLGpntyR1Pm. This is the C.R.S. 6-1-732 record,
// and a date that reads LATER than the real charge is the dangerous direction:
// the customer cancels on the morning of the date we gave them and has already
// been billed. Matching the Stripe dashboard's zone also means the email and
// the dashboard never disagree when a customer calls to argue about it.
const BUSINESS_TIME_ZONE = "America/Denver";

// Billing amounts are written with explicit cents. "$129.00/month" is what a
// payment disclosure should look like, and it matches the Stripe dashboard.
const money = (usd: number) => `$${usd.toFixed(2)}`;

// The amount the customer will ACTUALLY be billed each period: list price minus
// any fixed-amount discount on the subscription. Founding gyms pay list minus
// $50, and quoting them list price in the C.R.S. 6-1-732 confirmation states a
// charge that will never happen.
//
// Never throws, and degrades to list price on any failure — which is exactly
// what this email said before this function existed. A number that is too HIGH
// is survivable; not sending the email at all is not, because Stripe never
// re-fires customer.subscription.created and there is no second chance to
// produce the compliance record.
//
// This re-reads the subscription rather than widening retrieveSubscription's
// expand list on purpose. If "discounts" were ever rejected as an expand path
// there, the throw would take out the whole webhook and no billing state would
// be written for a customer who just paid. Here the blast radius is one wrong
// number in one email.
async function resolveMonthlyChargeUsd(
  stripe: Stripe,
  subscriptionId: string,
  listPriceUsd: number
): Promise<number> {
  try {
    const sub = await stripe.subscriptions.retrieve(subscriptionId, {
      // Nested path, and it has to be. `discounts` alone turns the array of ids
      // into Discount objects but leaves each discount's coupon as a bare id
      // string, which has no amount_off on it. Stripe expands parents
      // implicitly, so this one path covers both levels.
      expand: ["discounts.source.coupon"],
    });
    // Typed `Array<string | Discount>` and non-nullable in stripe v22. Guarded
    // anyway: this function's whole contract is that it never throws.
    const discounts: Array<string | Stripe.Discount> = Array.isArray(sub.discounts)
      ? sub.discounts
      : [];
    let amountOffCents = 0;
    for (const discount of discounts) {
      // A bare string means it came back unexpanded and there is nothing to
      // read. Skip rather than guess.
      if (typeof discount === "string") continue;
      // stripe v22 moved the coupon behind `source`; there is no
      // `discount.coupon` any more. Verified against the installed typings:
      // `source.coupon` is `string | Coupon | null`, and a string here means
      // the expand above didn't reach it.
      const coupon = discount.source?.coupon;
      if (!coupon || typeof coupon === "string") continue;
      if (typeof coupon.amount_off === "number") amountOffCents += coupon.amount_off;
    }
    if (amountOffCents <= 0) return listPriceUsd;
    const charged = listPriceUsd - amountOffCents / 100;
    // A discount exceeding list price means nothing is due, not a negative bill.
    return charged > 0 ? charged : 0;
  } catch (err) {
    console.error(
      `Could not resolve the discounted charge for subscription ${subscriptionId}; quoting list price in the confirmation email instead:`,
      err
    );
    return listPriceUsd;
  }
}

// Colorado Automatic Renewal Law (C.R.S. 6-1-732) requires written
// post-purchase confirmation of price/frequency/cancellation — the
// onboarding wizard's on-screen disclosure alone doesn't satisfy that.
// Fires off customer.subscription.created only, which Stripe never re-fires
// for the same subscription, so this can't duplicate on renewals/upgrades.
// Failure is logged, not thrown, so a Resend outage doesn't fail the whole
// webhook and trigger a Stripe retry that would re-run the (idempotent)
// upsert for nothing.
//
// Previously bailed out entirely when trialEnd was falsy (`if (!trialEnd)
// return`), on the assumption every checkout gets the trial_period_days
// trial. That's false whenever Stripe's "one trial per customer" account
// setting has already been used for that customer/price (e.g. re-testing
// checkout with the same email, or a future no-trial plan) — the
// subscription still gets created and charged immediately, but zero
// confirmation email ever goes out. That's not just a UX gap: this email is
// the only C.R.S. 6-1-732 written record, so skipping it on the no-trial
// path left real charged subscriptions with no compliance record at all.
// Now always sends, branching copy on whether a trial actually applies.
// customerRef is the subscription's `customer` field. Because every
// subscription re-fetch below expands it (see retrieveSubscription), this is
// normally the full object already and costs no additional Stripe call — the
// string branch is a fallback that keeps this correct if it's ever called
// without expansion.
async function sendTrialConfirmationEmail(
  stripe: Stripe,
  subscriptionId: string,
  customerRef: string | Stripe.Customer | Stripe.DeletedCustomer,
  plan: string | undefined,
  trialEnd: number | null,
  currentPeriodEnd: number | null
) {
  const customerId = typeof customerRef === "string" ? customerRef : customerRef.id;
  try {
    // plan is undefined when the subscription's Stripe Price didn't resolve
    // to a known tier (see lib/plans.ts:resolvePlanFromPriceId) — the gym
    // itself already kept whatever plan it had (upsertSubscription/
    // upsertUnclaimedSubscription omit the field rather than guessing), so
    // this only skips the confirmation email, not the customer's access.
    // No alert here ON PURPOSE, and do not "fix" that by adding one:
    // applySubscriptionState already calls alertUnresolvedPrice for exactly this
    // condition, immediately before it calls this function (see the !plan branch
    // below the upsert). That alert's copy already states that the C.R.S.
    // 6-1-732 confirmation must be sent by hand. A second email about the same
    // subscription seconds later is noise, and noise is how alerts stop getting
    // read. The other two bail-outs below are NOT covered anywhere, and those do
    // alert.
    if (!plan) {
      console.error(`Trial confirmation email skipped: subscription has no resolved plan (customer ${customerId})`);
      return;
    }
    const customer = typeof customerRef === "string" ? await stripe.customers.retrieve(customerId) : customerRef;
    // This used to be a bare `return` with no log at all — the quietest of the
    // three exits, on a customer who is being billed. No email address means the
    // statutory record cannot be produced for them by any route.
    if (customer.deleted || !customer.email) {
      const detail = customer.deleted
        ? "the Stripe customer was deleted"
        : "no email address on the Stripe customer";
      console.error(`Trial confirmation email skipped: ${detail} (customer ${customerId})`);
      await alertMissingTrialConfirmation({
        reason: "customer_unreachable",
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        plan,
        detail,
      });
      return;
    }

    // Explicit lookup, not slug capitalization — that rendered multi-word
    // tiers as "Fightteam"/"Blackbelt". Bail rather than send a confirmation
    // quoting "$undefined" for a slug we have no copy for; this email is the
    // C.R.S. 6-1-732 record, so a wrong one is worse than a missing one.
    const price = PLAN_PRICE_USD[plan];
    const planLabel = PLAN_LABEL[plan];
    if (price === undefined || planLabel === undefined) {
      console.error(`Trial confirmation email skipped: no price/label copy for plan "${plan}"`);
      // Deterministic config gap — a plan slug reached billing that lib/plans.ts
      // has no copy for — so it will recur for every customer on that slug until
      // someone adds it. Alerting is what makes "someone" happen.
      await alertMissingTrialConfirmation({
        reason: "missing_plan_copy",
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        plan,
      });
      return;
    }

    const formatDate = (unixSeconds: number) =>
      new Date(unixSeconds * 1000).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: BUSINESS_TIME_ZONE,
      });

    // What they will actually be charged, which is not `price` for a founding
    // gym. Falls back to `price` if the discount can't be read.
    const charge = await resolveMonthlyChargeUsd(stripe, subscriptionId, price);
    const discountPerMonth = price - charge;
    const foundingLine =
      discountPerMonth > 0
        ? `Founding rate applied: ${money(discountPerMonth)} off per month for at least your next 24 bills, then ${money(price)}/month.`
        : null;

    const resend = new Resend(process.env.RESEND_API_KEY);

    if (trialEnd) {
      const trialEndDate = formatDate(trialEnd);
      await resend.emails.send({
        from: "KombatDesk <billing@kombatdesk.com>",
        to: customer.email,
        subject: `Your KombatDesk ${planLabel} trial has started`,
        text: [
          `Your ${TRIAL_DAYS}-day free trial of KombatDesk ${planLabel} has started.`,
          ``,
          `Plan: KombatDesk ${planLabel} — ${money(charge)}/month`,
          ...(foundingLine ? [foundingLine] : []),
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
    } else {
      // No trial applied (most commonly: this customer/price already used
      // its one-time trial) — they were charged today. Next charge date
      // comes from the subscription's current_period_end, not a computed
      // guess, since Stripe's actual billing anchor is the source of truth.
      const nextChargeLine = currentPeriodEnd
        ? `Next charge: ${money(charge)} on ${formatDate(currentPeriodEnd)}`
        : `Billing frequency: monthly`;
      await resend.emails.send({
        from: "KombatDesk <billing@kombatdesk.com>",
        to: customer.email,
        subject: `Your KombatDesk ${planLabel} subscription is confirmed`,
        text: [
          `Your KombatDesk ${planLabel} subscription is now active.`,
          ``,
          `Plan: KombatDesk ${planLabel} — ${money(charge)}/month`,
          ...(foundingLine ? [foundingLine] : []),
          `Total charged today: ${money(charge)}`,
          nextChargeLine,
          ``,
          `Cancel anytime. Manage or cancel your subscription here:`,
          MANAGE_SUBSCRIPTION_URL,
          ``,
          `Questions? Just reply to this email.`,
        ].join("\n"),
      });
    }
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
// Every expected outcome is a variant so each caller can map it to its own
// status. "retry" specifically must NOT collapse into the signature-failure
// response: Stripe retries any non-2xx, so a 400 would technically work, but it
// would log a Stripe outage as a forged request.
type WebhookResult = { status: "ok" } | { status: "invalid_signature" } | { status: "retry" };

// Event types this handler acts on. Checked before the dedupe claim so the
// events Stripe sends that we ignore don't fill the table.
const HANDLED_EVENT_TYPES = new Set<Stripe.Event["type"]>([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_failed",
  "invoice.payment_succeeded",
]);

// Always expands the customer. Expansion is server-side, so this is still one
// API call — it just means the subscription.created path can email without a
// second customers.retrieve.
async function retrieveSubscription(stripe: Stripe, subscriptionId: string): Promise<Stripe.Subscription> {
  return await stripe.subscriptions.retrieve(subscriptionId, { expand: ["customer"] });
}

// Writes gym billing state from a FRESHLY RETRIEVED subscription. Callers must
// never pass the object embedded in the webhook event — see processEvent.
async function applySubscriptionState(
  ctx: ActionCtx,
  stripe: Stripe,
  sub: Stripe.Subscription,
  sendConfirmation: boolean
): Promise<void> {
  const clerkUserId = sub.metadata?.clerkUserId;

  const priceId = sub.items.data[0]?.price.id;
  const plan = resolvePlanFromPriceId(priceId);
  if (!plan) {
    // Most likely: the price env var is missing or has a different value
    // between Vercel and the Convex dashboard. Deliberately NOT defaulting to
    // "academy" — see lib/plans.ts. The gym still gets planStatus/
    // stripeCustomerId written below (upsertSubscription/
    // upsertUnclaimedSubscription omit plan when it's undefined), so a customer
    // who just paid keeps access; only the tier label and trial confirmation
    // email are affected until this is fixed.
    console.error(`Stripe webhook: unrecognized price "${priceId}" on subscription ${sub.id} — plan will not be set`);
  }
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;

  // No longer special-cased per event type. A deleted subscription reports
  // status "canceled" on retrieve, so the old
  // `event.type === "deleted" ? "canceled" : sub.status` branch is redundant —
  // and it was actively wrong under out-of-order delivery, since it forced
  // "canceled" from a stale event regardless of the subscription's real state.
  const planStatus = sub.status;

  let gymId: string;
  if (clerkUserId) {
    ({ gymId } = await ctx.runMutation(internal.subscriptions.upsertSubscription, {
      clerkUserId,
      stripeCustomerId: customerId,
      stripeSubscriptionId: sub.id,
      plan,
      planStatus,
    }));
  } else {
    // Guest checkout — no Clerk account yet. Persist by customer id;
    // claimGymBySessionId links clerkUserId once they sign up.
    ({ gymId } = await ctx.runMutation(internal.subscriptions.upsertUnclaimedSubscription, {
      stripeCustomerId: customerId,
      stripeSubscriptionId: sub.id,
      plan,
      planStatus,
    }));
  }

  // Deliberately not thrown: an unresolved price is a deterministic config
  // problem, so failing the event would just burn Stripe's retries on
  // something that can't self-heal. Billing fields were persisted above; only
  // the plan label is affected.
  if (!plan) {
    await alertUnresolvedPrice({
      source: "stripeWebhookAction.verifyAndProcess",
      priceId,
      gymId,
      stripeSubscriptionId: sub.id,
    });
  }

  if (sendConfirmation) {
    // current_period_end lives on the subscription item, not the subscription
    // itself, as of this Stripe API version.
    const currentPeriodEnd = sub.items.data[0]?.current_period_end ?? null;
    await sendTrialConfirmationEmail(stripe, sub.id, sub.customer, plan, sub.trial_end, currentPeriodEnd);
  }
}

// Throws on a transient failure so verifyAndProcess can release the dedupe
// claim and ask Stripe to retry.
async function processEvent(ctx: ActionCtx, stripe: Stripe, event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      // The event payload is used for ONE thing: the subscription id. Stripe
      // does not guarantee delivery order, so the state embedded in the event
      // may already be obsolete — a stale "updated" landing after a "deleted"
      // used to un-cancel a gym, and a stale "deleted" landing after an
      // "updated" used to lock a paying customer out mid-class. Re-fetching
      // makes the write ordering-immune with no version bookkeeping: whatever
      // order events arrive in, every one of them converges on the same
      // current truth.
      const staleId = (event.data.object as Stripe.Subscription).id;
      const sub = await retrieveSubscription(stripe, staleId);
      await applySubscriptionState(ctx, stripe, sub, event.type === "customer.subscription.created");
      break;
    }
    case "invoice.payment_failed":
    case "invoice.payment_succeeded": {
      const invoice = event.data.object as Stripe.Invoice;

      // As of this Stripe API version there is no top-level invoice.subscription
      // — it lives under parent.subscription_details, and both levels are
      // nullable for an invoice that isn't subscription-driven.
      const subRef = invoice.parent?.subscription_details?.subscription;
      const subscriptionId = typeof subRef === "string" ? subRef : subRef?.id;

      // Previously this branch flipped planStatus for ANY invoice belonging to
      // the customer, keyed on customer id alone — so a one-off manual invoice
      // could mark a gym "active" (or "past_due") with no subscription behind
      // it at all. No subscription means nothing to say about subscription
      // state, so say nothing.
      if (!subscriptionId) {
        console.log(
          `Stripe webhook: ${event.type} on invoice ${invoice.id} has no subscription — skipping, nothing to sync`
        );
        break;
      }

      // Same re-fetch rationale as above, and it also replaces the hardcoded
      // "past_due"/"active" guess with the subscription's real status — Stripe
      // may have already retried a failed payment successfully by the time this
      // event is processed.
      const sub = await retrieveSubscription(stripe, subscriptionId);
      await applySubscriptionState(ctx, stripe, sub, false);
      break;
    }
  }
}

export const verifyAndProcess = action({
  args: { signature: v.string(), payload: v.string() },
  handler: async (ctx, { signature, payload }): Promise<WebhookResult> => {
    // Read, don't construct — AGENTS.md §7. `new Stripe(undefined!)` throws
    // SYNCHRONOUSLY and this was the first line of the handler, above every
    // try/catch in it.
    //
    // THESE ARE CONVEX ENVIRONMENT VARIABLES, set in the Convex dashboard —
    // a different store from the Vercel env scoping done on 2026-08-01.
    // Vercel having STRIPE_SECRET_KEY says nothing about whether Convex does.
    // That is why this instance survived three handoffs that listed the other
    // four: every one of them was looking at Vercel-side code.
    //
    // The failure this prevents is worse than the checkout-route version that
    // got all the attention. There, a missing key means no sale and the buyer
    // sees an error. Here: the action rejects -> fetchAction in
    // app/api/stripe/webhook/route.ts throws -> raw 500 -> Stripe retries,
    // fails identically, and drops the event when its retry window closes.
    // checkout.session.completed is never processed, so a gym owner who HAS
    // ALREADY PAID is never provisioned and never receives the trial
    // confirmation email that is their C.R.S. 6-1-732 record. Silently.
    //
    // STRIPE_WEBHOOK_SECRET is checked here too. It used to be a `!` inside
    // the try below, so a missing one surfaced as "signature verification
    // failed" — which reads as a bad endpoint or a hostile caller, and sends
    // whoever is debugging it to rotate a secret that was never set.
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!stripeSecretKey || !webhookSecret) {
      const missing = [
        !stripeSecretKey && "STRIPE_SECRET_KEY",
        !webhookSecret && "STRIPE_WEBHOOK_SECRET",
      ]
        .filter(Boolean)
        .join(" and ");
      console.error(
        `Stripe webhook: ${missing} missing from the CONVEX environment (set in the Convex dashboard — NOT Vercel). ` +
          `Returning retry so Stripe redelivers instead of dropping the event. ` +
          `While this persists, paid signups are NOT being provisioned.`
      );
      // Deliberate 500 via the route, rather than an unhandled throw: Stripe
      // keeps redelivering, so events survive until the key is set. Nothing
      // is claimed in stripeEvents yet, so there is no claim to release.
      return { status: "retry" };
    }

    const stripe = new Stripe(stripeSecretKey);

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(payload, signature, webhookSecret);
    } catch (err) {
      console.error("Stripe webhook signature verification failed:", err);
      return { status: "invalid_signature" };
    }

    if (!HANDLED_EVENT_TYPES.has(event.type)) return { status: "ok" };

    // Stripe retries deliveries as normal operation, so this handler WILL see
    // the same event more than once. The DB writes below are idempotent
    // patches, but sendTrialConfirmationEmail is not — a redelivery would send
    // a paying customer a second copy of the confirmation that serves as their
    // C.R.S. 6-1-732 record.
    const claimed = await ctx.runMutation(internal.stripeEvents.claimEventId, { eventId: event.id });
    if (!claimed) {
      console.log(`Stripe webhook: event ${event.id} (${event.type}) already processed — ignoring duplicate delivery`);
      return { status: "ok" };
    }

    try {
      await processEvent(ctx, stripe, event);
      return { status: "ok" };
    } catch (err) {
      // Release before asking for a retry, or the claim above would make
      // Stripe's redelivery look like a duplicate and the event would be lost
      // for good — the failure mode the whole retry mechanism exists to avoid.
      console.error(`Stripe webhook: processing failed for event ${event.id} (${event.type}) — releasing claim:`, err);
      await ctx.runMutation(internal.stripeEvents.releaseEventId, { eventId: event.id });
      return { status: "retry" };
    }
  },
});
