import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { currentUser } from "@clerk/nextjs/server";
import { fetchAction, fetchQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { getConvexToken } from "@/lib/convex-auth";
import { clientIp } from "@/lib/rate-limit";
import { readJsonBody } from "@/lib/http";
import { allowedPriceIds, resolvePlanFromPriceId } from "@/lib/plans";
import { buildCheckoutSessionParams } from "@/lib/checkoutSession";
import { getFoundingProgramResult } from "@/lib/foundingOffer";
import {
  FOUNDING_COUPON_ENV,
  LIST_PRICE_CHECKOUT,
  missingApiKeyResult,
  offerResultForPlan,
  planCheckout,
  type FoundingOfferResult,
} from "@/lib/foundingOfferPolicy";
import {
  alertCheckoutDown,
  alertCheckoutSessionFailed,
  alertFoundingCouponMisconfigured,
  sendAlertEmail,
  shouldDeliverOutageAlert,
} from "@/lib/alerts";

export async function POST(request: NextRequest) {
  // checkRateLimit is internalMutation now — this goes through the
  // checkRateLimitAction wrapper instead of fetchMutation. See
  // convex/rateLimit.ts for why.
  const allowed = await fetchAction(api.rateLimit.checkRateLimitAction, {
    bucket: "checkout",
    identifier: clientIp(request),
  });
  if (!allowed) {
    return NextResponse.json(
      { error: "Too many requests — please wait a bit and try again." },
      { status: 429 }
    );
  }

  // Read, don't construct. `new Stripe(undefined!)` throws synchronously —
  // above the try/catch and above the four-state classification below — so a
  // missing key used to produce a raw 500 with a stack trace, no 503, and no
  // alert: a silent outage, which is exactly what alertCheckoutDown exists to
  // catch. The client is constructed further down, only once the key is known
  // to be present. See missingApiKeyResult in lib/foundingOfferPolicy.ts.
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  const user = await currentUser();

  const body = await readJsonBody<{ priceId?: string; founding?: unknown }>(request);
  if (!body || typeof body.priceId !== "string") {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }
  const { priceId } = body;
  // Strictly `true`. Set by the onboarding wizard only for a buyer who came in
  // through /founding — see the long comment below for what it can and cannot do.
  const wantsFounding = body.founding === true;

  if (!allowedPriceIds().includes(priceId)) {
    return NextResponse.json(
      { error: "That plan isn't available right now. Please refresh and try again." },
      { status: 400 }
    );
  }

  const origin = new URL(request.url).origin;

  // FOUNDING PRICING IS ASKED FOR BY THE CLIENT AND GRANTED BY STRIPE.
  //
  // `founding: true` only says "this buyer came in through /founding". It
  // carries no price and no coupon id. Whether a founding price exists, which
  // coupon it is and how many spots are left all come from the coupons' own
  // state (getFoundingProgramResult), same as /founding itself — so the most a
  // forged flag can do is claim a founding spot that is genuinely still open,
  // which is the same thing visiting /founding does.
  //
  // WHY IT IS ASKED FOR AT ALL. Until 2026-10-03 the founding coupon attached
  // to EVERY checkout while spots remained, because /pricing advertised it to
  // everyone. /pricing now shows list prices only and /founding is a link Zain
  // sends by hand, so a /pricing buyer who was quoted $99 must be charged $99
  // and must not quietly take one of the five founding spots.
  //
  // A buyer who did not ask gets LIST_PRICE_CHECKOUT: nothing is looked up, so
  // a broken or unreachable founding coupon can neither alert on nor refuse a
  // list-price sale.
  //
  // For a buyer who did ask, planCheckout (lib/foundingOfferPolicy.ts) turns
  // the coupon state into the one decision this route needs, and it is the
  // single place the /founding-vs-checkout invariant is enforced: a discount
  // is attached if and only if /founding was advertising one. Sold out and
  // misconfigured both mean /founding is hidden, so nobody is being promised
  // anything and the sale proceeds at list price. Only "unknown" — Stripe
  // unreachable, where a retry may still resolve it and we cannot tell what
  // other visitors are being shown — refuses, because falling through there
  // would silently charge list price to someone who was just promised a
  // founding price.
  //
  // An absent key short-circuits to the same `unknown` state a rejected key
  // reaches — for EVERY buyer, founding or not, since without a key no sale
  // of any kind can be created — so both get the identical 503 + alert
  // treatment rather than one being handled and the other crashing.
  const plan = resolvePlanFromPriceId(priceId);
  const foundingOfferResult: FoundingOfferResult | null = !stripeSecretKey
    ? missingApiKeyResult(plan ? process.env[FOUNDING_COUPON_ENV[plan]] : undefined)
    : wantsFounding && plan
      ? offerResultForPlan(await getFoundingProgramResult(), plan)
      : null;
  const checkoutPlan = foundingOfferResult ? planCheckout(foundingOfferResult) : LIST_PRICE_CHECKOUT;

  // Awaited, not fire-and-forget, so a response can't outrun its alert and
  // leave the failure completely silent. Both kinds are sent before responding.
  if (checkoutPlan.alert?.kind === "misconfigured") {
    // Deterministic config error. The sale still goes through at list price.
    console.error(
      "Stripe checkout: founding coupon is misconfigured — selling at LIST PRICE and alerting:",
      checkoutPlan.alert.reason
    );
    await alertFoundingCouponMisconfigured(checkoutPlan.alert);
  } else if (checkoutPlan.alert?.kind === "outage") {
    // Stripe unreachable. This refuses the sale below, so it is the loud one.
    // Logged in every environment; emailed only from production. Preview has
    // no Stripe key by design (see shouldDeliverOutageAlert), so an outage
    // alert from there would be a false alarm about intended behavior.
    const deliver = shouldDeliverOutageAlert(process.env.VERCEL_ENV);
    console.error(
      `Stripe checkout: founding coupon state is unknown — REFUSING the sale${deliver ? " and alerting" : "; alert email suppressed outside production"}:`,
      checkoutPlan.alert.reason
    );
    if (deliver) {
      await alertCheckoutDown({
        source: "api/stripe/checkout",
        ...checkoutPlan.alert,
        vercelEnv: process.env.VERCEL_ENV,
        deploymentUrl: process.env.VERCEL_URL,
      });
    }
  }

  // The `!stripeSecretKey` half is redundant — an absent key always yields
  // `unknown`, which is the only state that fails to proceed — but it is what
  // narrows the type below, and it guarantees the client is never constructed
  // with an empty key no matter how this classification later changes.
  // Always the same generic body: never leak a stack trace or an env var name
  // to an anonymous caller.
  if (!checkoutPlan.proceed || !stripeSecretKey) {
    return NextResponse.json(
      { error: "Something went wrong setting up checkout. Please try again in a moment." },
      { status: 503 }
    );
  }

  const stripe = new Stripe(stripeSecretKey);

  const foundingOffer = foundingOfferResult?.status === "available" ? foundingOfferResult.offer : null;

  // REUSE THIS BUYER'S EXISTING STRIPE CUSTOMER.
  //
  // Without this, every checkout minted a brand-new customer for the same
  // person, because customer_email prefills a form but does not identify
  // anyone. On 2026-08-19 one gym owner looping through a broken funnel
  // produced two customers and two subscriptions eight minutes apart; because
  // convex/subscriptions.ts:upsertSubscription resolves the gym row by
  // clerkUserId alone, the two then raced for the same row and cancelling the
  // stale one downgraded the live one. See
  // claude/gym-row-clobber-2026-08-20.md — the guards there contain the damage,
  // this removes the precondition.
  //
  // Signed-in only. A guest has no gym row to read a customer from, and
  // /welcome's claimGymBySessionId is what links them afterwards.
  //
  // Deliberately non-fatal: a Convex hiccup here must not take checkout down.
  // Falling through with null just restores the old behaviour for that one
  // request — a duplicate customer, which the guards now survive.
  //
  // The same read also answers "has this gym already had its free month?" —
  // see usedFoundingTrial below.
  let reusedCustomerId: string | null = null;
  // A FOUNDING GYM CONVERTING OFF THE COMPED TRIAL MUST NOT GET A SECOND ONE.
  //
  // The no-card founding trial (convex/schema.ts:foundingTrialEndsAt) already
  // gave this gym TRIAL_DAYS free. buildCheckoutSessionParams grants TRIAL_DAYS
  // unconditionally by default, so without this the gym that just finished 30
  // free days would land on a subscription that bills 30 days later still —
  // two free months, and a first-payment date neither side expected.
  //
  // Reads the flag rather than recomputing it: convex/subscriptions.ts's
  // getSubscription is the single place the trial timestamp is interpreted.
  let usedFoundingTrial = false;
  if (user) {
    try {
      const token = await getConvexToken();
      const subscription = await fetchQuery(api.subscriptions.getSubscription, {}, { token });
      reusedCustomerId = subscription.stripeCustomerId ?? null;
      usedFoundingTrial = subscription.foundingTrialUsed;
    } catch (err) {
      console.error("Stripe checkout: could not read the existing Stripe customer, using a new one:", err);
      // Deliberately non-fatal, same as reusedCustomerId above — a Convex
      // hiccup must not take checkout down. The cost of falling through here is
      // one founding gym getting a second free month, which is a discount we
      // can live with; refusing the sale is not.
    }
  }

  // Thin adapter over lib/checkoutSession.ts — the params themselves live there
  // so they can be unit-tested; a Next route module cannot export them.
  function buildSessionParams(applyDiscount: boolean): Stripe.Checkout.SessionCreateParams {
    return buildCheckoutSessionParams({
      priceId,
      origin,
      buyer: user
        ? { clerkUserId: user.id, email: user.emailAddresses[0]?.emailAddress }
        : null,
      existingCustomerId: reusedCustomerId,
      couponId: applyDiscount && foundingOffer ? foundingOffer.couponId : null,
      // undefined = the normal TRIAL_DAYS trial (the default lives in
      // lib/checkoutSession.ts). null = no Stripe trial at all, for a gym that
      // already had the comped one.
      trialDays: usedFoundingTrial ? null : undefined,
      // Back out of Stripe to the page whose prices this buyer was shown.
      cancelPath: wantsFounding ? "/founding" : "/pricing",
    });
  }

  // The founding-coupon fallback, unchanged, lifted into a function so the
  // stale-customer retry below can run the whole thing again rather than
  // duplicating it. Both fallbacks stay one level deep this way.
  async function createSessionWithCouponFallback(): Promise<Stripe.Checkout.Session> {
    try {
      return await stripe.checkout.sessions.create(buildSessionParams(true));
    } catch (err) {
      // Only a coupon-specific rejection falls back to standard price. A
      // network blip or rate limit here must NOT silently drop the discount
      // and charge full price — those rethrow below and hit the normal
      // error response instead.
      if (foundingOffer && isCouponSpecificError(err)) {
        // The coupon can be exhausted/invalidated between getFoundingProgramResult()
        // resolving and this call reaching Stripe (another gym closes in the
        // gap). A gym owner mid-demo must never see an error screen because
        // of that race — retry once at standard price instead of failing —
        // but this is money silently changing, so it also has to alert a
        // human, not just log.
        console.error(
          "Stripe checkout: founding coupon rejected, retrying at standard price:",
          err
        );
        await sendAlertEmail(
          "KombatDesk: founding coupon rejected at checkout — customer charged standard price",
          [
            `Checkout proceeded at STANDARD price because Stripe rejected the founding coupon.`,
            ``,
            `Price ID: ${priceId}`,
            `Coupon ID: ${foundingOffer.couponId}`,
            ``,
            `Stripe error: ${err instanceof Error ? err.message : String(err)}`,
            ``,
            `/founding showed this customer a founding price before they clicked through — they will expect it. Check whether the coupon is exhausted, expired, or deleted. /founding hides itself once the coupons say the program is full, so if it is still showing, the coupon state and the page disagree.`,
          ].join("\n")
        );
        return await stripe.checkout.sessions.create(buildSessionParams(false));
      }
      throw err;
    }
  }

  try {
    let session: Stripe.Checkout.Session;
    try {
      session = await createSessionWithCouponFallback();
    } catch (err) {
      // A stored customer id can go stale — deleted during test-mode
      // housekeeping, or left over from the other Stripe mode after a key
      // switch. Without this, that gym's checkout would 500 forever with no
      // way to self-heal, which is a worse failure than the duplicate customer
      // reuse exists to prevent. Retry once with a fresh customer.
      if (reusedCustomerId && isMissingCustomerError(err)) {
        console.error(
          `Stripe checkout: stored customer ${reusedCustomerId} no longer exists in Stripe — retrying with a new one:`,
          err
        );
        reusedCustomerId = null;
        session = await createSessionWithCouponFallback();
      } else {
        throw err;
      }
    }

    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("Stripe checkout session creation failed:", err);
    // Not silent any more — see alertCheckoutSessionFailed for why a list-price
    // buyer's failure here used to reach nobody. Awaited for the same reason the
    // alerts above are: a response must not outrun its own alert.
    if (shouldDeliverOutageAlert(process.env.VERCEL_ENV)) {
      const meta = (typeof err === "object" && err !== null ? err : {}) as {
        type?: unknown;
        statusCode?: unknown;
      };
      await alertCheckoutSessionFailed({
        priceId,
        founding: wantsFounding,
        errorType:
          typeof meta.type === "string"
            ? meta.type
            : err instanceof Error
              ? err.constructor.name
              : typeof err,
        ...(typeof meta.statusCode === "number" ? { statusCode: meta.statusCode } : {}),
        message: err instanceof Error ? err.message : String(err),
        vercelEnv: process.env.VERCEL_ENV,
        deploymentUrl: process.env.VERCEL_URL,
      });
    }
    return NextResponse.json(
      { error: "Something went wrong — please try again or contact us." },
      { status: 500 }
    );
  }
}

// Narrows the founding-coupon fallback to failures that are actually about
// the coupon — a bad/expired/exhausted/deleted coupon — as opposed to any
// other invalid-request error, and excludes non-invalid-request error classes
// entirely (StripeRateLimitError, StripeConnectionError, StripeAPIError,
// etc.), which must always rethrow rather than silently drop the discount.
// Narrow to "the customer id we sent does not exist", and nothing else. Any
// other invalid-request error must rethrow — retrying those without the
// customer would quietly split a returning buyer into a second customer for a
// reason that had nothing to do with the customer.
function isMissingCustomerError(err: unknown): boolean {
  if (!(err instanceof Stripe.errors.StripeInvalidRequestError)) return false;
  if (err.param?.toLowerCase() !== "customer") return false;
  const message = err.message?.toLowerCase() ?? "";
  return err.code === "resource_missing" || message.includes("no such customer");
}

function isCouponSpecificError(err: unknown): boolean {
  if (!(err instanceof Stripe.errors.StripeInvalidRequestError)) return false;

  const param = err.param?.toLowerCase() ?? "";
  if (param.includes("coupon") || param.includes("discount")) return true;

  // Some coupon failures (exhausted, deleted) surface without a `param` —
  // fall back to the message text Stripe uses for those specific cases,
  // not invalid-request errors generally.
  const message = err.message?.toLowerCase() ?? "";
  return (
    message.includes("coupon") &&
    (message.includes("expired") ||
      message.includes("invalid") ||
      message.includes("deleted") ||
      message.includes("no longer be redeemed") ||
      message.includes("redemption"))
  );
}
