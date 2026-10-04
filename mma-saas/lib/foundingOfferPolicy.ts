import type Stripe from "stripe";
import { PLAN_PRICE_USD, type PlanSlug } from "./plans";

// Pure classification + decision logic for the founding coupons, split out of
// lib/foundingOffer.ts so it can be unit-tested without pulling in next/cache
// or constructing a Stripe client. Nothing in this file does I/O or reads
// process.env; `import type Stripe` is erased at compile time, and the only
// runtime import is lib/plans.ts, which is itself pure (and already bundled by
// Convex, which also reaches this file through lib/alerts.ts).
//
// THE INVARIANT THIS FILE ENCODES:
// /founding and checkout must agree about whether a founding offer exists.
// Any state where /founding is hidden is a state where nobody is being
// promised a founding price — so checkout proceeds at LIST PRICE. The only
// state that may refuse the sale is one where we genuinely cannot tell what
// /founding is showing, because a retry might resolve it.
//
// (Until 2026-10-03 the offer was a block on /pricing and a single coupon that
// attached to every checkout. It is now its own page, /founding, with one
// coupon per tier — see "THE FOUNDING PROGRAM" at the bottom of this file.
// Comments below that say "/pricing hides the block" describe the same
// agreement; read them as /founding.)
//
// offerFromResult() and planCheckout() are the two sides of that agreement,
// and lib/foundingOfferPolicy.test.ts asserts they never disagree.

// slotsLeft: null means the coupon has no max_redemptions (unlimited) — not
// Infinity, which doesn't survive the cache serialization in lib/foundingOffer.
export type FoundingOffer = { amountOffCents: number; slotsLeft: number | null; couponId: string };

// Four states, and the distinction between the last two is the whole point:
//
//   available     — offer is live. /pricing advertises it, checkout attaches it.
//   exhausted     — genuinely sold out. Normal end-of-program state, not an
//                   error. /pricing hides the block, checkout sells at list.
//   misconfigured — deterministically broken in a way a retry will not fix
//                   (bad/deleted coupon id, test/live key mismatch, unset env
//                   var, percent_off coupon). /pricing hides the block, so
//                   nobody was promised anything: checkout sells at list price
//                   rather than taking revenue to zero — but it also shouts,
//                   because this is never a state we meant to be in.
//   unknown       — we could not reach Stripe, or Stripe failed in a way that
//                   may resolve on retry. We cannot tell what /pricing is
//                   showing other visitors right now, so this is the one state
//                   that refuses the sale (503) instead of guessing.
//
// Previously "exhausted" and every failure mode collapsed into a single
// "unavailable" status that checkout treated as 503. Because Stripe flips
// coupon.valid to false the instant a coupon is fully redeemed, a normal
// sell-out was indistinguishable from a misconfiguration, and selling out took
// checkout down for everyone — including buyers happy to pay list price.
export type FoundingOfferResult =
  | { status: "available"; offer: FoundingOffer }
  | { status: "exhausted" }
  | { status: "misconfigured"; couponId: string | null; reason: string }
  // errorType/statusCode are carried so the outage alert can be diagnosed from
  // the email alone — a 401 (revoked key, never self-heals) and a 503 (Stripe
  // outage, self-heals) both land here and want opposite responses.
  | { status: "unknown"; couponId: string; reason: string; errorType: string; statusCode?: number };

export function classifyCoupon(
  coupon: Stripe.Coupon | Stripe.DeletedCoupon,
  couponId: string
): FoundingOfferResult {
  if ("deleted" in coupon && coupon.deleted) {
    return {
      status: "misconfigured",
      couponId,
      reason: `coupon ${couponId} is deleted in Stripe`,
    };
  }

  const live = coupon as Stripe.Coupon;

  // THIS CHECK MUST STAY ABOVE THE !valid CHECK BELOW. Stripe sets
  // valid=false the moment times_redeemed reaches max_redemptions, so if
  // !valid is tested first, a sold-out coupon is misread as broken and the
  // "exhausted" branch becomes unreachable through the normal sell-out path.
  // That was the bug: reproduced 2026-08-01 in test mode against a 1/1
  // coupon — /pricing correctly dropped the founding block while checkout
  // returned 503, so the program selling out would have stopped every sale.
  if (live.max_redemptions != null && live.times_redeemed >= live.max_redemptions) {
    return { status: "exhausted" };
  }

  // Reached only for a coupon Stripe considers unusable for some reason OTHER
  // than exhaustion — most plausibly an expired redeem_by. No redeem_by is set
  // on the founding coupon today, so arriving here means the coupon is not in
  // the shape this program assumes: sell at list price, and say so out loud.
  if (!live.valid) {
    return {
      status: "misconfigured",
      couponId,
      reason: `coupon ${couponId} reports valid=false and is not exhausted (${live.times_redeemed}/${live.max_redemptions ?? "unlimited"} redemptions) — most likely expired via redeem_by`,
    };
  }

  // This page and the checkout math render a fixed-amount discount only; a
  // percent_off coupon would render "$undefined off". Config error, not a
  // sellout.
  if (live.amount_off == null) {
    return {
      status: "misconfigured",
      couponId,
      reason: `coupon ${couponId} has no amount_off (percent_off=${live.percent_off}) — this program renders fixed-amount coupons only`,
    };
  }

  const slotsLeft =
    live.max_redemptions != null ? live.max_redemptions - live.times_redeemed : null;

  return {
    status: "available",
    offer: { amountOffCents: live.amount_off, slotsLeft, couponId },
  };
}

// Splits a Stripe failure into "the coupon definitively isn't there" (a
// deterministic config error — a typo'd id, a deleted coupon, or a test/live
// key mismatch, all of which surface as 404 resource_missing) versus anything
// else (network, rate limit, 5xx, auth), which may resolve on retry.
export function classifyCouponError(err: unknown, couponId: string): FoundingOfferResult {
  if (isMissingResourceError(err)) {
    return {
      status: "misconfigured",
      couponId,
      reason: `Stripe has no coupon "${couponId}" (404 resource_missing) — either the id is wrong or STRIPE_SECRET_KEY is in the other mode from the coupon`,
    };
  }
  return {
    status: "unknown",
    couponId,
    reason: `failed to retrieve Stripe coupon ${couponId}: ${err instanceof Error ? err.message : String(err)}`,
    ...stripeErrorMeta(err),
  };
}

// Stripe SDK errors expose `type` ("StripeAuthenticationError",
// "StripeRateLimitError", …) and `statusCode`. Both are read duck-typed to keep
// this module free of runtime imports. A raw network failure has neither, so
// the JS constructor name stands in — the alert still names a class either way.
function stripeErrorMeta(err: unknown): { errorType: string; statusCode?: number } {
  const e = (typeof err === "object" && err !== null ? err : {}) as {
    type?: unknown;
    statusCode?: unknown;
  };
  return {
    errorType:
      typeof e.type === "string"
        ? e.type
        : err instanceof Error
          ? err.constructor.name
          : typeof err,
    ...(typeof e.statusCode === "number" ? { statusCode: e.statusCode } : {}),
  };
}

// Duck-typed rather than `instanceof Stripe.errors.StripeInvalidRequestError`
// so this module keeps its zero runtime imports. Both fields are present on
// Stripe SDK errors; checking either keeps this working if one is ever absent.
function isMissingResourceError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; statusCode?: unknown };
  return e.code === "resource_missing" || e.statusCode === 404;
}

// errorType for the one failure the Stripe SDK can never report itself: with no
// STRIPE_SECRET_KEY the client cannot be constructed, so there is no request, no
// response, and no Stripe error object. Named rather than inlined so
// lib/alerts.ts can branch its remediation copy on the same constant.
export const MISSING_API_KEY = "MissingStripeApiKey";

// STRIPE_SECRET_KEY absent entirely. Not a coupon state — but operationally
// identical to "unknown": we cannot determine whether an offer exists, so
// checkout must refuse rather than guess, and it must say so out loud.
//
// Modeled as unknown with no statusCode, because there is no HTTP exchange to
// have a status. Distinct from a 401: an invalid key means a key was sent and
// rejected (rotate it), a missing key means none was ever configured for this
// environment (set it). Neither self-heals, but the remediation differs.
//
// Exists because new Stripe(undefined!) throws synchronously, above the route's
// try/catch and above all of this classification — a missing key produced a raw
// 500 with a stack trace, no 503, and no alert. That is a silent outage, which
// is the exact failure alertCheckoutDown was added to prevent.
export function missingApiKeyResult(couponId: string | undefined): FoundingOfferResult {
  return {
    status: "unknown",
    couponId: couponId ?? "(the founding coupon env var is not set either)",
    reason:
      "STRIPE_SECRET_KEY is not set in this environment — the Stripe client cannot be constructed, so no Stripe call was attempted at all",
    errorType: MISSING_API_KEY,
  };
}

// What /pricing sees. Any non-available state hides the founding block.
export function offerFromResult(result: FoundingOfferResult): FoundingOffer | null {
  return result.status === "available" ? result.offer : null;
}

// Two different alerts, because the two states need opposite reactions and a
// single generic "coupon problem" subject line buries the one that matters:
//   misconfigured -> sales continue at list price. Fix it today, not tonight.
//   outage        -> EVERY sale is being refused. Fix it now.
export type CheckoutAlert =
  | { kind: "misconfigured"; couponId: string | null; reason: string }
  | { kind: "outage"; couponId: string; reason: string; errorType: string; statusCode?: number };

export type CheckoutPlan = {
  // false => refuse the sale (503). Only ever set for status "unknown".
  proceed: boolean;
  // The coupon to attach, or null to sell at list price.
  couponId: string | null;
  // Non-null => fire this alert before responding. Fires on both the
  // proceed-at-list-price path and the refuse path; `kind` selects which email.
  alert: CheckoutAlert | null;
};

// The checkout side of the invariant. Note that `couponId` is non-null in
// exactly the states where offerFromResult() is non-null — i.e. checkout
// attaches a discount if and only if /pricing was advertising one.
//
// The refusal for "unknown" is deliberate and must stay: it stops us silently
// charging list price to someone /pricing may have just promised a discount.
// The bug was never that the guard existed, only that it could not tell "sold
// out" from "misconfigured" and applied the strict behaviour to both.
export function planCheckout(result: FoundingOfferResult): CheckoutPlan {
  switch (result.status) {
    case "available":
      return { proceed: true, couponId: result.offer.couponId, alert: null };
    case "exhausted":
      return { proceed: true, couponId: null, alert: null };
    case "misconfigured":
      return {
        proceed: true,
        couponId: null,
        alert: { kind: "misconfigured", couponId: result.couponId, reason: result.reason },
      };
    case "unknown":
      // Refuses the sale AND shouts. Without the alert this state was the one
      // silent failure left in the design: a revoked Stripe key 503s every
      // checkout indefinitely, /pricing stays up looking healthy, and nothing
      // anywhere reports it until a customer complains.
      return {
        proceed: false,
        couponId: null,
        alert: {
          kind: "outage",
          couponId: result.couponId,
          reason: result.reason,
          errorType: result.errorType,
          ...(result.statusCode !== undefined ? { statusCode: result.statusCode } : {}),
        },
      };
  }
}

// The checkout plan for a buyer who never asked for founding pricing — anyone
// who came in through /pricing. Nothing is looked up and nothing can alert:
// they were shown list price, so list price is the whole decision.
export const LIST_PRICE_CHECKOUT: CheckoutPlan = { proceed: true, couponId: null, alert: null };

// ---------------------------------------------------------------------------
// THE FOUNDING PROGRAM — flat founding prices, locked for life
// ---------------------------------------------------------------------------
//
// As of 2026-10-03 the founding deal is no longer "$50 off for 24 months". It
// is a flat price per tier that never expires:
//
//                 list    founding
//   Academy       $99     $50
//   Fight Team    $179    $130
//   Black Belt    $299    $200
//
// Those are not one uniform discount ($49, $49 and $99 off), so a single
// coupon cannot charge them. Each tier names its own coupon through an env
// var; two tiers MAY name the same coupon (Academy and Fight Team are both $49
// off) and redemptions are counted once per distinct coupon.
//
// Still coupons rather than a second set of Prices, for the reason that has
// held since the first design: the subscription stays on the standard Price,
// so lib/plans.ts:resolvePlanFromPriceId and everything in convex/ that maps a
// price back to a plan keep working untouched, and the invoice reads
// "$99.00, Founding −$49.00" every month — the list price they are not paying,
// restated on every bill.
//
// "LOCKED FOR LIFE" IS A PROMISE ABOUT THE COUPON, so it is checked, not
// assumed: a coupon that is not duration=forever, or whose amount does not
// land on the founding price above, makes the whole program `misconfigured`.
// /founding then hides itself and checkout sells at list price and alerts,
// rather than printing "for life" over a discount Stripe will quietly end.

// Total founding gyms, across all three tiers. The cap USED to be one coupon's
// max_redemptions; with a coupon per tier it has to be summed here instead.
export const FOUNDING_SPOTS = 5;

export const FOUNDING_PRICE_USD: Record<PlanSlug, number> = {
  academy: 50,
  fightteam: 130,
  blackbelt: 200,
};

// Vercel PRODUCTION only, like every other Stripe var — never Preview. Read by
// lib/foundingOffer.ts; listed here so the alert copy and the reader cannot
// name two different variables.
export const FOUNDING_COUPON_ENV: Record<PlanSlug, string> = {
  academy: "STRIPE_FOUNDING_COUPON_ACADEMY",
  fightteam: "STRIPE_FOUNDING_COUPON_FIGHTTEAM",
  blackbelt: "STRIPE_FOUNDING_COUPON_BLACKBELT",
};

export const FOUNDING_PLANS: readonly PlanSlug[] = ["academy", "fightteam", "blackbelt"];

// What lib/foundingOffer.ts hands over for one tier: the env var was unset,
// Stripe returned the coupon, or the retrieve threw.
export type FoundingCouponLookup =
  | { couponId: null }
  | { couponId: string; coupon: Stripe.Coupon | Stripe.DeletedCoupon }
  | { couponId: string; error: unknown };

// slotsLeft is the PROGRAM's remaining spots, and each per-tier offer carries
// that same number — a spot is a gym, whichever tier it buys.
export type FoundingProgram = { slotsLeft: number; offers: Record<PlanSlug, FoundingOffer> };

// Same four states as FoundingOfferResult, about all three tiers at once. The
// program is all-or-nothing on purpose: /founding shows three cards, and a
// page that could show two founding prices and one list price would be
// promising something different to every visitor.
export type FoundingProgramResult =
  | { status: "available"; program: FoundingProgram }
  | Exclude<FoundingOfferResult, { status: "available" }>;

export function classifyFoundingProgram(
  lookups: Record<PlanSlug, FoundingCouponLookup>,
  listPriceUsd: Record<string, number> = PLAN_PRICE_USD
): FoundingProgramResult {
  const live = {} as Record<PlanSlug, { couponId: string; coupon: Stripe.Coupon }>;
  let misconfigured: FoundingProgramResult | null = null;
  let unknown: FoundingProgramResult | null = null;

  // 1. Can every coupon be read at all?
  for (const plan of FOUNDING_PLANS) {
    const lookup = lookups[plan];
    if (lookup.couponId === null) {
      misconfigured ??= {
        status: "misconfigured",
        couponId: null,
        reason: `${FOUNDING_COUPON_ENV[plan]} is not set in this environment`,
      };
    } else if ("error" in lookup) {
      const failed = classifyCouponError(lookup.error, lookup.couponId);
      if (failed.status === "unknown") unknown ??= failed;
      else if (failed.status === "misconfigured") misconfigured ??= failed;
    } else if ("deleted" in lookup.coupon && lookup.coupon.deleted) {
      misconfigured ??= {
        status: "misconfigured",
        couponId: lookup.couponId,
        reason: `coupon ${lookup.couponId} (${FOUNDING_COUPON_ENV[plan]}) is deleted in Stripe`,
      };
    } else {
      live[plan] = { couponId: lookup.couponId, coupon: lookup.coupon as Stripe.Coupon };
    }
  }

  // A deterministic break outranks an unreachable Stripe. With any one tier
  // misconfigured the program cannot be shown no matter what the others turn
  // out to be, so we DO know what /founding is showing — nothing — and that is
  // the state that sells at list price rather than refusing.
  if (misconfigured) return misconfigured;
  if (unknown) return unknown;

  // 2. Sold out? Counted once per distinct coupon, so two tiers sharing a
  // coupon are not double-counted. This stays above every validity check for
  // the same reason classifyCoupon orders it that way: Stripe flips valid to
  // false the moment a coupon is fully redeemed, and a sell-out must never be
  // misread as a misconfiguration.
  const redeemedByCoupon = new Map<string, number>();
  for (const plan of FOUNDING_PLANS) {
    redeemedByCoupon.set(live[plan].couponId, live[plan].coupon.times_redeemed);
  }
  let redeemed = 0;
  for (const count of redeemedByCoupon.values()) redeemed += count;
  if (redeemed >= FOUNDING_SPOTS) return { status: "exhausted" };

  // 3. Does every coupon keep the promise /founding is about to print?
  const slotsLeft = FOUNDING_SPOTS - redeemed;
  const offers = {} as Record<PlanSlug, FoundingOffer>;
  for (const plan of FOUNDING_PLANS) {
    const { couponId, coupon } = live[plan];
    const broken = (reason: string): FoundingProgramResult => ({
      status: "misconfigured",
      couponId,
      reason: `coupon ${couponId} (${FOUNDING_COUPON_ENV[plan]}) ${reason}`,
    });

    // Each coupon must be able to take every remaining spot by itself, or the
    // page advertises spots that one tier cannot actually sell.
    if (coupon.max_redemptions != null && coupon.max_redemptions < FOUNDING_SPOTS) {
      return broken(
        `has max_redemptions=${coupon.max_redemptions}, below the program's ${FOUNDING_SPOTS} spots — create it with max_redemptions=${FOUNDING_SPOTS}`
      );
    }

    const base = classifyCoupon(coupon, couponId);
    // Not reachable past the two checks above (a coupon that can hold every
    // spot and is full means the program is full). Kept so a later edit to
    // either check cannot turn this into a tier that silently sells at list.
    if (base.status === "exhausted") return broken("is fully redeemed while the program still has spots");
    if (base.status !== "available") return base;

    if (coupon.duration !== "forever") {
      return broken(
        `has duration="${coupon.duration}" — the founding price is advertised as locked for life, which only a duration=forever coupon keeps`
      );
    }
    if (coupon.currency !== "usd") {
      return broken(`is in currency "${coupon.currency}", not usd`);
    }

    const listCents = Math.round(listPriceUsd[plan] * 100);
    const foundingCents = FOUNDING_PRICE_USD[plan] * 100;
    if (listCents - base.offer.amountOffCents !== foundingCents) {
      return broken(
        `takes $${base.offer.amountOffCents / 100} off the $${listPriceUsd[plan]} ${plan} list price, which is $${(listCents - base.offer.amountOffCents) / 100}/mo — the founding price is $${FOUNDING_PRICE_USD[plan]}/mo, so it must take $${(listCents - foundingCents) / 100} off`
      );
    }

    offers[plan] = { amountOffCents: base.offer.amountOffCents, slotsLeft, couponId };
  }

  return { status: "available", program: { slotsLeft, offers } };
}

// What /founding sees. Any non-available state hides the page.
export function programFromResult(result: FoundingProgramResult): FoundingProgram | null {
  return result.status === "available" ? result.program : null;
}

// What checkout sees for the one tier being bought. Narrows the program to a
// FoundingOfferResult so planCheckout() above — and every test of it — applies
// unchanged.
export function offerResultForPlan(
  result: FoundingProgramResult,
  plan: PlanSlug
): FoundingOfferResult {
  return result.status === "available"
    ? { status: "available", offer: result.program.offers[plan] }
    : result;
}
