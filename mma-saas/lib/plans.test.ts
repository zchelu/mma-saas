// Covers the founding (comped) trial helpers — the no-card trial granted to the
// first gym(s) by convex/onboarding.ts, which has NO Stripe object behind it and
// therefore nothing that ends it except these functions.
//
// Worth testing precisely because there is no Stripe here to be the adult in the
// room: for a normal customer the trial ends when Stripe charges the card, and
// Stripe will do that whether our code is right or not. For a founding gym,
// foundingTrialExpired() IS the end of the trial. If it returns false forever,
// the comped trial is permanent and silent.
import { describe, expect, test } from "vitest";
import {
  FOUNDING_TRIAL_DAYS,
  TRIAL_DAYS,
  discountConfirmationLine,
  foundingTrialDaysLeft,
  foundingTrialEndFrom,
  foundingTrialExpired,
  hasFoundingTrial,
  hasUsedFoundingTrial,
  isOnFoundingTrial,
} from "./plans";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

describe("a gym with no founding trial is untouched by any of this", () => {
  test("every helper is false/zero for a plain gym", () => {
    const gym = {};
    expect(hasFoundingTrial(gym)).toBe(false);
    expect(isOnFoundingTrial(gym, NOW)).toBe(false);
    expect(foundingTrialExpired(gym, NOW)).toBe(false);
    expect(hasUsedFoundingTrial(gym)).toBe(false);
    expect(foundingTrialDaysLeft(gym, NOW)).toBe(0);
  });

  // The whole point of the change: a normal Stripe customer must never be
  // affected by the founding-trial code path.
  test("a normal Stripe subscriber is never treated as expired", () => {
    const gym = { stripeSubscriptionId: "sub_live" };
    expect(foundingTrialExpired(gym, NOW)).toBe(false);
  });
});

describe("an active founding trial", () => {
  const gym = { foundingTrialEndsAt: NOW + 10 * DAY };

  test("is on trial, not expired", () => {
    expect(isOnFoundingTrial(gym, NOW)).toBe(true);
    expect(foundingTrialExpired(gym, NOW)).toBe(false);
  });

  test("days left rounds UP so the last partial day still reads as a day", () => {
    expect(foundingTrialDaysLeft({ foundingTrialEndsAt: NOW + 1 }, NOW)).toBe(1);
    expect(foundingTrialDaysLeft({ foundingTrialEndsAt: NOW + 10 * DAY }, NOW)).toBe(10);
  });
});

describe("expiry", () => {
  test("REGRESSION the trial ends the moment the timestamp passes", () => {
    const gym = { foundingTrialEndsAt: NOW };
    expect(foundingTrialExpired(gym, NOW)).toBe(true);
    expect(isOnFoundingTrial(gym, NOW)).toBe(false);
    expect(foundingTrialDaysLeft(gym, NOW)).toBe(0);
  });

  test("days left never goes negative", () => {
    expect(foundingTrialDaysLeft({ foundingTrialEndsAt: NOW - 99 * DAY }, NOW)).toBe(0);
  });
});

describe("conversion to a paid subscription", () => {
  // foundingTrialEndsAt is never cleared, so a gym that converted keeps a
  // timestamp in the past forever. If that read as "expired" it would revoke
  // write access from a PAYING customer — the worst outcome in this file.
  const converted = { foundingTrialEndsAt: NOW - 60 * DAY, stripeSubscriptionId: "sub_live" };

  test("REGRESSION a stale trial timestamp cannot lock out a paying gym", () => {
    expect(hasFoundingTrial(converted)).toBe(false);
    expect(foundingTrialExpired(converted, NOW)).toBe(false);
    expect(isOnFoundingTrial(converted, NOW)).toBe(false);
  });

  // ...but the "already had a free month" record survives conversion, because
  // that is what stops app/api/stripe/checkout/route.ts granting a second
  // Stripe-side trial on the way in.
  test("REGRESSION the used-a-free-month record survives conversion", () => {
    expect(hasUsedFoundingTrial(converted)).toBe(true);
  });
});

describe("the grant length", () => {
  test("is FOUNDING_TRIAL_DAYS, never a second hardcoded number", () => {
    expect(foundingTrialEndFrom(NOW)).toBe(NOW + FOUNDING_TRIAL_DAYS * DAY);
  });

  // The founding grant and the Stripe trial are two different promises to two
  // different people. Collapsing them would either hand every paying signup a
  // free two months, or quietly contradict content/terms.html, which states
  // "30-day free trial" as literal untemplated text.
  test("REGRESSION the founding grant is independent of the Stripe TRIAL_DAYS", () => {
    expect(TRIAL_DAYS).toBe(30);
    expect(FOUNDING_TRIAL_DAYS).not.toBe(TRIAL_DAYS);
  });
});

// The discount line of the C.R.S. 6-1-732 confirmation email. It is the written
// record of the price the customer agreed to, so the wording is asserted, not
// just the branch taken.
describe("discountConfirmationLine", () => {
  test("no discount -> no line at all", () => {
    expect(discountConfirmationLine({ listUsd: 99, chargeUsd: 99, lockedForLife: false })).toBeNull();
    expect(discountConfirmationLine({ listUsd: 99, chargeUsd: 99, lockedForLife: true })).toBeNull();
  });

  // The flat founding prices never revert. Telling this gym "then $99.00/month"
  // would put a price increase in writing that is never going to happen.
  test("a founding price locked for life never names a date or a reverting price", () => {
    const line = discountConfirmationLine({ listUsd: 99, chargeUsd: 50, lockedForLife: true })!;
    expect(line).toBe(
      "Founding price: $50.00/month, locked for as long as you stay subscribed. The standard price is $99.00/month."
    );
    expect(line).not.toContain("24");
    expect(line).not.toContain("then");
  });

  test("a discount that ends still says when, and what it reverts to", () => {
    expect(discountConfirmationLine({ listUsd: 179, chargeUsd: 129, lockedForLife: false })).toBe(
      "Founding rate applied: $50.00 off per month for at least your next 24 bills, then $179.00/month."
    );
  });
});
