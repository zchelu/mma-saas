const ALERT_TO = "kombatdesk@outlook.com";
const ALERT_FROM = "KombatDesk <billing@kombatdesk.com>";
const PRICE_ENV_VAR_NAMES =
  "STRIPE_STARTER_PRICE_ID, STRIPE_PRO_PRICE_ID, STRIPE_ELITE_PRICE_ID";

// Raw fetch to Resend's REST API, not the SDK — so this same function works
// unmodified from a Convex action (either runtime) and from Next server code,
// with no "use node" requirement anywhere.
export async function sendAlertEmail(subject: string, text: string): Promise<void> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: ALERT_FROM, to: ALERT_TO, subject, text }),
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
