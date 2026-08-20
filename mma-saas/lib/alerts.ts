import { MISSING_API_KEY } from "./foundingOfferPolicy";

const ALERT_TO = "kombatdesk@outlook.com";
const ALERT_FROM = "KombatDesk <billing@kombatdesk.com>";
const PRICE_ENV_VAR_NAMES =
  "STRIPE_STARTER_PRICE_ID, STRIPE_PRO_PRICE_ID, STRIPE_ELITE_PRICE_ID";
const ALERT_SEND_TIMEOUT_MS = 5000;

// Raw fetch to Resend's REST API, not the SDK — so this same function works
// unmodified from a Convex action (either runtime) and from Next server code,
// with no "use node" requirement anywhere.
export async function sendAlertEmail(subject: string, text: string): Promise<void> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: ALERT_FROM, to: ALERT_TO, subject, text }),
      // Callers await this before responding — deliberately, since a
      // fire-and-forget send can be killed when a serverless response returns,
      // and delivery matters more than latency on an already-failing request.
      // The bound is only so a hung Resend can't hold that response open
      // indefinitely; a timeout lands in the catch below and is logged.
      signal: AbortSignal.timeout(ALERT_SEND_TIMEOUT_MS),
    });
    // fetch only rejects on network failure — a 4xx/5xx from Resend (bad key,
    // unverified from-address) resolves normally and would otherwise vanish
    // silently. Log status + body so a broken alert path is at least visible
    // in Convex/Vercel logs instead of just not showing up in an inbox.
    if (!res.ok) {
      const body = await res.text().catch(() => "(could not read response body)");
      console.error(`Alert email failed to send (${subject}): ${res.status} ${res.statusText} — ${body}`);
    }
  } catch (err) {
    console.error(`Alert email failed to send (${subject}):`, err);
  }
}

// Fires from app/api/stripe/checkout when the founding coupon is
// deterministically broken rather than sold out — a wrong/deleted coupon id, a
// test/live key mismatch, an unset env var, or a coupon that isn't a
// fixed-amount discount. Checkout keeps selling at list price through all of
// those (a typo must not take revenue to zero), so without this email the
// failure is completely silent: /pricing simply stops showing the founding
// block and every founding buyer quietly pays full price.
//
// Deliberately NOT fired for a fully-redeemed coupon — that's the program
// working as designed, not something to page about.
export async function alertFoundingCouponMisconfigured(params: {
  couponId: string | null;
  reason: string;
}): Promise<void> {
  const { couponId, reason } = params;
  await sendAlertEmail(
    "KombatDesk: founding coupon is misconfigured — checkout is selling at LIST PRICE",
    [
      `The founding coupon could not be resolved, and the failure is deterministic — a retry will NOT fix it.`,
      ``,
      `Reason: ${reason}`,
      `Coupon ID read from STRIPE_FOUNDING_COUPON_ID: ${couponId ?? "(env var not set)"}`,
      ``,
      `Current behaviour: /pricing has dropped the founding block entirely, and checkout is completing at LIST PRICE with no discount attached. Sales are still going through — this is not an outage — but nobody can get the founding rate until it's fixed, and anyone buying right now is paying full price.`,
      ``,
      `Most likely causes, in order:`,
      `  1. STRIPE_FOUNDING_COUPON_ID has a typo, or points at a coupon that was deleted.`,
      `  2. STRIPE_FOUNDING_COUPON_ID names a live-mode coupon while STRIPE_SECRET_KEY is a test key, or vice versa. Stripe reports both as a 404.`,
      `  3. The var is missing from Vercel Production. It is scoped to Production ONLY by design — do NOT add it to Preview.`,
      ``,
      `Stripe coupons are immutable except for name/metadata/currency_options — max_redemptions cannot be edited. If the coupon needs different terms, create a NEW coupon and repoint STRIPE_FOUNDING_COUPON_ID at it in Vercel PRODUCTION ONLY, then redeploy. Never set any Stripe var on Preview: a preview deploy with a live key can charge a real card and permanently burn a founding slot.`,
    ].join("\n")
  );
}

// Whether an outage alert should actually be DELIVERED, as opposed to merely
// intended. Pure and env-injected so it can be tested without touching
// process.env; the route supplies process.env.VERCEL_ENV.
//
// The six server-side Stripe vars are scoped to Vercel Production only —
// Preview deliberately has no Stripe key, so that a preview deploy can never
// charge a real card or burn a live founding slot. The consequence is that on
// Preview the founding coupon is permanently unresolvable, which is CORRECT
// behavior, not an incident. Without this gate every preview checkout would
// email "CHECKOUT IS DOWN" about a system working exactly as designed, and the
// alert that matters would get filtered as noise.
//
// Deliberately gates delivery ONLY. The 503, the console.error, and
// planCheckout's alert intent are unchanged in every environment — preview
// still fails loudly in logs, it just doesn't page anyone.
export function shouldDeliverOutageAlert(vercelEnv: string | undefined): boolean {
  return vercelEnv === "production";
}

// The companion to alertFoundingCouponMisconfigured, for the state where the
// coupon's condition can't be read at all rather than read and found wrong.
// Named for the impact, not the cause: this one means NO SALES ARE COMPLETING,
// which is a different order of urgency from "the founding rate isn't applying"
// and must not read like another coupon nag in an inbox.
//
// Deliberately NOT throttled or deduplicated — one email per blocked checkout,
// matching alertUnresolvedPrice above. At current traffic that's a handful of
// messages, and the volume is itself the signal.
export async function alertCheckoutDown(params: {
  source: "api/stripe/checkout";
  couponId: string;
  reason: string;
  errorType: string;
  statusCode?: number;
  vercelEnv?: string;
  deploymentUrl?: string;
}): Promise<void> {
  const { source, couponId, reason, errorType, statusCode, vercelEnv, deploymentUrl } = params;
  await sendAlertEmail(
    "KombatDesk: CHECKOUT IS DOWN — every sale is being refused",
    [
      `Checkout is returning 503 to EVERY visitor right now, including buyers who would have paid full price. No one can complete a purchase until this clears.`,
      ``,
      errorType === MISSING_API_KEY
        ? `KombatDesk could not determine the founding coupon's state because there is no Stripe key to ask with. This will NOT resolve on its own and no retry will help — it stays broken until the env var is set and the app redeployed.`
        : `KombatDesk could not determine the founding coupon's state, and the failure is the kind that may resolve on retry.`,
      `It is NOT a wrong or deleted coupon id — that case is handled separately and keeps selling at list price. Because the state is genuinely unknown here, checkout refuses rather than risk charging list price to someone /pricing may have just promised a discount. That guard is correct. The outage behind it is not.`,
      ``,
      `Fired from: ${source}`,
      // Delivery is gated to production (see shouldDeliverOutageAlert), so this
      // should always read "production" — if it ever doesn't, the gate leaked
      // and that is itself the bug to chase.
      `Environment: ${vercelEnv ?? "(VERCEL_ENV not set — local dev)"}`,
      `Deployment: ${deploymentUrl ?? "(VERCEL_URL not set)"}`,
      `Coupon ID read from STRIPE_FOUNDING_COUPON_ID: ${couponId}`,
      `Stripe error class: ${errorType}`,
      `Stripe HTTP status: ${
        statusCode ??
        (errorType === MISSING_API_KEY
          ? "(no request was made — there was no API key to make it with)"
          : "(no response — request never completed)")
      }`,
      `Detail: ${reason}`,
      ``,
      `WHAT TO DO, by status:`,
      `  ${MISSING_API_KEY}`,
      `       STRIPE_SECRET_KEY is not set at all for this environment — no key`,
      `       was sent, so this is NOT a rotation problem. Most likely it was`,
      `       wiped or mis-pasted during a hand edit of the Vercel env vars. Set`,
      `       it in Vercel PRODUCTION ONLY and redeploy. Nothing recovers until`,
      `       you do; there is no retry that can fix an absent key.`,
      `  401  STRIPE_SECRET_KEY is invalid, revoked, or was rolled. This will NOT`,
      `       recover on its own. Set a working key in Vercel PRODUCTION ONLY,`,
      `       then redeploy. Do NOT add a Stripe key to Preview — previews are`,
      `       meant to fail here; a Preview key would let a preview deploy charge`,
      `       a real card and permanently consume a founding slot.`,
      `  429  Stripe rate limit. Usually clears within minutes on its own.`,
      `  5xx  Stripe-side outage. Check https://status.stripe.com — self-resolving.`,
      `  none No response at all: network/DNS failure reaching Stripe from Vercel.`,
      ``,
      `/pricing is still up and has already hidden the founding block, so nobody is being shown an offer they can't buy. The damage is confined to checkout.`,
    ].join("\n")
  );
}

// Fires only from Convex (stripeWebhookAction.ts / subscriptions.ts) — that's
// the only side that ever resolves a Stripe priceId back to a plan slug.
export async function alertUnresolvedPrice(params: {
  source: "stripeWebhookAction.verifyAndProcess" | "subscriptions.claimGymBySessionId";
  priceId: string | undefined;
  gymId?: string;
  stripeSubscriptionId?: string;
}): Promise<void> {
  const { source, priceId, gymId, stripeSubscriptionId } = params;
  await sendAlertEmail(
    "KombatDesk: unresolved Stripe price on a subscription",
    [
      `A Stripe subscription references a price ID that doesn't match any known plan.`,
      ``,
      `Detected in: convex/${source}. This always fires from Convex — if the price WAS accepted at checkout (Vercel's allowedPriceIds), check whether the Convex dashboard's env is missing this price ID or has a different value than Vercel's. The two stores can drift.`,
      ``,
      `Price ID: ${priceId ?? "(none on subscription)"}`,
      `Gym ID: ${gymId ?? "(unresolved)"}`,
      `Stripe subscription ID: ${stripeSubscriptionId ?? "(none)"}`,
      ``,
      `gym.plan was NOT changed — left as whatever it was before (or left unset, for a brand-new gym). Billing fields (planStatus/stripeCustomerId/stripeSubscriptionId) WERE still saved — this gym is genuinely paying.`,
      ``,
      `Consequence: planHasTexting() returns false for an unresolved plan — winback texting is OFF for this gym until you fix the plan by hand. The clock is running.`,
      ``,
      `ACTION REQUIRED, and it does not fix itself: sendTrialConfirmationEmail only fires on the customer.subscription.created event, which Stripe never re-fires for this subscription. That email is the ONLY C.R.S. 6-1-732 written record of price/frequency/cancellation terms. Fixing gym.plan by hand after the fact will NOT retroactively send it — you must manually send this customer their price/frequency/cancellation confirmation yourself once you've identified the correct plan, or that compliance record is permanently missing for them.`,
      ``,
      `All three price env vars, must match in both Vercel and the Convex dashboard:`,
      PRICE_ENV_VAR_NAMES,
    ].join("\n")
  );
}

// Fires when convex/stripeWebhookAction.ts:sendTrialConfirmationEmail bails out
// and therefore never sends the customer their trial/subscription confirmation.
//
// That email is the ONLY written C.R.S. 6-1-732 record of price, frequency and
// cancellation terms, and it fires off customer.subscription.created, which
// Stripe never re-fires. A skipped send is therefore permanent: nothing retries
// it, and the customer has already been trialed or charged.
//
// Until now these paths only console.error'd, and one of them did not even do
// that. A compliance artifact failing quietly, traceable only through a log line
// nobody reads, is the same failure shape as the missing-Convex-key webhook bug
// in docs/stripe-key-gap-closed-2026-08-09.md — which is exactly how that one
// survived three handoffs.
//
// NOT raised for an unresolved plan: alertUnresolvedPrice above already covers
// that case and runs immediately before this function's caller
// (convex/stripeWebhookAction.ts:309), with copy that already spells out the
// manual send. A second email about the same subscription seconds later would
// be noise, and noise is how alerts stop being read.
export async function alertMissingTrialConfirmation(params: {
  reason: "missing_plan_copy" | "customer_unreachable";
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  plan?: string;
  detail?: string;
}): Promise<void> {
  const { reason, stripeCustomerId, stripeSubscriptionId, plan, detail } = params;

  const explanation =
    reason === "missing_plan_copy"
      ? `The subscription resolved to plan "${plan}", but PLAN_PRICE_USD and/or PLAN_LABEL in lib/plans.ts has no copy for that slug. The email was skipped rather than sent quoting "$undefined" — a wrong statutory record is worse than a missing one, but this one is now missing.`
      : `The Stripe customer has no usable email address (${detail ?? "deleted, or no email on file"}), so there is nowhere to send the confirmation.`;

  const fix =
    reason === "missing_plan_copy"
      ? `Add "${plan}" to PLAN_PRICE_USD and PLAN_LABEL in lib/plans.ts, or correct the price ID mapping so the subscription resolves to a tier that has copy.`
      : `Find this customer's real email address in the Stripe dashboard and confirm whether they were charged.`;

  await sendAlertEmail(
    "KombatDesk: a C.R.S. 6-1-732 confirmation email was NOT sent",
    [
      `A customer's trial/subscription confirmation email was skipped. That email is their only written record of price, frequency and cancellation terms.`,
      ``,
      `Condition: ${reason}`,
      `Stripe customer ID: ${stripeCustomerId}`,
      `Stripe subscription ID: ${stripeSubscriptionId}`,
      `Resolved plan: ${plan ?? "(none)"}`,
      ``,
      explanation,
      ``,
      `ACTION REQUIRED, and it does not fix itself: this email only fires on customer.subscription.created, which Stripe never re-fires for this subscription. Fixing the cause afterwards will NOT retroactively send it — you must send this customer their price/frequency/cancellation confirmation by hand, or that compliance record is permanently missing for them.`,
      ``,
      `To stop it recurring: ${fix}`,
    ].join("\n")
  );
}

// Fires from app/dashboard/page.tsx when the auth-first flow could not claim a
// just-completed Checkout Session. The customer is signed in, Stripe took the
// card, and Convex still has no plan for them — so they are looking at
// SettlingGate's stranded screen right now.
//
// This is the alert that did not exist on 2026-08-19, which is why a failed
// webhook signature turned into a paying gym owner silently re-entering the
// setup wizard until they gave up. Nothing else in the system notices: the
// webhook path logs to Convex, this path logs to Vercel, and neither is read
// unless someone already suspects a problem. An email is the only channel that
// reaches Zain without him going looking.
//
// Deliberately NOT fired for a rate-limit rejection — that is the same person
// refreshing, not a new failure, and one stranded customer must not be able to
// generate an inbox full of duplicates. The caller filters those out.
export async function alertStrandedCheckout(params: {
  clerkUserId: string;
  sessionId: string;
  detail: string;
}): Promise<void> {
  const { clerkUserId, sessionId, detail } = params;

  await sendAlertEmail(
    "KombatDesk: a PAID signup could not be provisioned",
    [
      `A signed-in buyer completed Stripe Checkout and the synchronous claim failed. They have been charged (or started a trial against a saved card) and their gym has no active plan.`,
      ``,
      `Clerk user ID: ${clerkUserId}`,
      `Checkout session ID: ${sessionId}`,
      `Failure: ${detail}`,
      ``,
      `WHAT THEY SEE: the "we couldn't finish setting up your account" screen on /dashboard, with the recovery link. They are not looping back into the wizard any more, but they also cannot use the product until this is resolved.`,
      ``,
      `TO RECOVER THEM BY HAND: open the checkout session above in the Stripe dashboard, find the subscription it created, and resend its customer.subscription.created event — NOT customer.subscription.updated. Only "created" triggers the C.R.S. 6-1-732 trial confirmation email, which is this customer's only written record of price, frequency and cancellation terms.`,
      ``,
      `THEN FIND THE CAUSE: if the platform webhook is also failing, the two share it. Check the delivery response code on the event destination before assuming this is a code bug — a 400 there means the signing secret in the CONVEX environment does not match that destination, which is a config problem, not a bug in the claim path.`,
    ].join("\n")
  );
}
