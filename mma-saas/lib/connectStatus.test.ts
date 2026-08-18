import { describe, it, expect } from "vitest";
import { extractConnectStatus } from "./connectStatus";

// These lock the exact shapes measured against the Stripe sandbox on
// 2026-08-13, not invented ones. Two writers use this function — the embedded
// panel's refresh and the account.updated webhook — and the whole point of
// extracting it was that they can never disagree.

describe("extractConnectStatus", () => {
  it("reads a brand-new unonboarded account as restricted, not pending", () => {
    // Verbatim from the sandbox probe. This is the case the two booleans
    // destroyed: an owner who has done nothing yet is `restricted` with a
    // machine-readable reason, and "restricted" is what the card must be able
    // to tell apart from "Stripe is still reviewing you".
    const result = extractConnectStatus({
      capabilities: {
        card_payments: {
          status: "restricted",
          status_details: [{ code: "requirements_past_due" }],
        },
        stripe_balance: {
          payouts: {
            status: "restricted",
            status_details: [{ code: "requirements_past_due" }],
          },
        },
      },
    });

    expect(result.chargesEnabled).toBe(false);
    expect(result.payoutsEnabled).toBe(false);
    expect(result.chargesStatus).toBe("restricted");
    expect(result.chargesStatusCodes).toEqual(["requirements_past_due"]);
    expect(result.payoutsStatus).toBe("restricted");
  });

  it("enables only on active", () => {
    const result = extractConnectStatus({
      capabilities: {
        card_payments: { status: "active", status_details: [] },
        stripe_balance: { payouts: { status: "active", status_details: [] } },
      },
    });
    expect(result.chargesEnabled).toBe(true);
    expect(result.payoutsEnabled).toBe(true);
    expect(result.chargesStatusCodes).toEqual([]);
  });

  it("does not enable on pending", () => {
    const result = extractConnectStatus({
      capabilities: { card_payments: { status: "pending" } },
    });
    expect(result.chargesEnabled).toBe(false);
    expect(result.chargesStatus).toBe("pending");
  });

  it("charges and payouts move independently", () => {
    // The real intermediate state: Stripe enables card_payments before payouts
    // while bank details verify. The card renders a specific line for it.
    const result = extractConnectStatus({
      capabilities: {
        card_payments: { status: "active" },
        stripe_balance: { payouts: { status: "pending" } },
      },
    });
    expect(result.chargesEnabled).toBe(true);
    expect(result.payoutsEnabled).toBe(false);
    expect(result.payoutsStatus).toBe("pending");
  });

  it("treats an unrecognised future status as NOT enabled", () => {
    // Stripe's vocabulary grows. Failing closed is the only safe direction:
    // stage D gates charging on chargesEnabled, so a status we have never seen
    // must never unlock a charge.
    const result = extractConnectStatus({
      capabilities: { card_payments: { status: "some_future_state" } },
    });
    expect(result.chargesEnabled).toBe(false);
    expect(result.chargesStatus).toBe("some_future_state");
  });

  it("survives a missing merchant configuration entirely", () => {
    // v2 returns null for anything not requested via `include`, so a caller
    // that forgets it gets undefined here rather than a crash — and must not
    // silently read as enabled.
    for (const input of [undefined, null, {}, { capabilities: {} }]) {
      const result = extractConnectStatus(input);
      expect(result.chargesEnabled).toBe(false);
      expect(result.payoutsEnabled).toBe(false);
      expect(result.chargesStatus).toBeUndefined();
      expect(result.chargesStatusCodes).toEqual([]);
    }
  });

  it("drops malformed detail entries rather than emitting undefined codes", () => {
    const result = extractConnectStatus({
      capabilities: {
        card_payments: {
          status: "restricted",
          status_details: [{ code: "requirements_past_due" }, {}, { code: "verification_failed" }],
        },
      },
    });
    expect(result.chargesStatusCodes).toEqual(["requirements_past_due", "verification_failed"]);
  });
});
