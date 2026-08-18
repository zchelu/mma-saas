// Turns a Stripe v2 connected account's merchant configuration into the six
// fields we store on `gyms`.
//
// WHY THIS IS ITS OWN MODULE. Two things write those fields:
//   - convex/connectOnboarding.ts:refreshConnectStatus (owner pressed refresh,
//     or closed the embedded panel)
//   - convex/connectWebhookAction.ts (account.updated arrived)
// They must agree exactly. Two writers of one status field that disagree is how
// a gym ends up "Setup incomplete" in the UI while Stripe has it live, or worse,
// enabled here while Stripe has restricted it — and the second direction is a
// charge attempt against an account that cannot take one.
//
// Pure and dependency-free on purpose: no Stripe import, no Convex import. It
// takes the shape it needs rather than the SDK type, so it runs in either Convex
// runtime and in a plain unit test.
//
// THE STATUS VOCABULARY IS NOT OURS. Stripe documents four values today
// (active | pending | restricted | unsupported) and the detail codes are a much
// longer, growing list. Nothing here validates against either — they pass
// through as opaque strings, which is the same reason the schema stores them as
// v.string() and never v.union: a closed set would fail on write the first time
// Stripe adds a value, which is strictly worse than not having the data.

/** The subset of a v2 account's merchant configuration this reads. */
export type MerchantConfigurationShape = {
  capabilities?: {
    card_payments?: CapabilityShape;
    stripe_balance?: { payouts?: CapabilityShape };
  };
};

type CapabilityShape = {
  status?: string;
  status_details?: Array<{ code?: string }>;
};

export type ConnectStatusFields = {
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  chargesStatus: string | undefined;
  chargesStatusCodes: string[];
  payoutsStatus: string | undefined;
  payoutsStatusCodes: string[];
};

// Only "active" counts as enabled. Measured on a real unonboarded account
// 2026-08-13: card_payments comes back "restricted" with a
// requirements_past_due code — NOT "pending" — so anything that treated
// non-active as a temporary state would have marked a brand-new gym as
// nearly-ready. Defaulting to false on an unrecognised or absent status is the
// safe direction: stage D gates charging on chargesEnabled, so an unknown
// future status must not unlock it.
function isEnabled(capability: CapabilityShape | undefined): boolean {
  return capability?.status === "active";
}

function codesOf(capability: CapabilityShape | undefined): string[] {
  return (capability?.status_details ?? [])
    .map((detail) => detail.code)
    .filter((code): code is string => typeof code === "string");
}

export function extractConnectStatus(
  merchant: MerchantConfigurationShape | undefined | null
): ConnectStatusFields {
  const cardPayments = merchant?.capabilities?.card_payments;
  const payouts = merchant?.capabilities?.stripe_balance?.payouts;

  return {
    chargesEnabled: isEnabled(cardPayments),
    payoutsEnabled: isEnabled(payouts),
    chargesStatus: cardPayments?.status,
    chargesStatusCodes: codesOf(cardPayments),
    payoutsStatus: payouts?.status,
    payoutsStatusCodes: codesOf(payouts),
  };
}
