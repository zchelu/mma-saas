"use client";

// Membership plans — the owner-facing surface. Stage 3 of the Connect
// member-billing build (spec §5.3).
//
// NOTHING HERE CHARGES ANYONE. A plan is a Product and a Price on the gym's own
// Stripe account; enrolling a member against one is stage 4. The copy is
// careful not to imply otherwise, for the same reason connect-billing.tsx is —
// a founding gym reading "billing" as "we are billing" is a promise the product
// cannot yet keep.
//
// PLACEMENT: under the Connect card, and only once an account exists. Plans are
// meaningless without a connected account to hold the Prices, and rendering an
// empty plans card above an unconnected billing card reads as two broken
// features instead of one sequence.
import { useState, type FormEvent } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { DISABLED_BUTTON_STYLE } from "../components/button-styles";
import { formatPlanPrice, parseDollarsToCents } from "../../lib/money";

// Same shape as connect-billing.tsx's errorText. A ConvexError's payload is the
// message we wrote for the owner; anything else is redacted to "Server Error" in
// production, so a fallback has to carry the meaning.
function errorText(err: unknown, fallback: string): string {
  if (err && typeof err === "object" && "data" in err) {
    const data = (err as { data?: unknown }).data;
    if (typeof data === "string" && data) return data;
  }
  return err instanceof Error && err.message ? err.message : fallback;
}

export default function MemberPlans() {
  const status = useQuery(api.connect.getConnectStatus);
  // "skip" until there is a connected account. This query sits ABOVE the
  // `status.connected` early return because hooks must run unconditionally,
  // so without the sentinel every dashboard load in the fleet calls it —
  // including the gyms that have no Connect account and never will render
  // this card. It also means a deploy that lands the client before the
  // Convex functions cannot call a function that is not there yet.
  const plans = useQuery(api.gymPlans.listPlans, status?.connected ? {} : "skip");
  const createPlan = useAction(api.gymPlansStripe.createPlan);
  const retryPlanPrice = useAction(api.gymPlansStripe.retryPlanPrice);
  const archivePlan = useMutation(api.gymPlans.archivePlan);

  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [interval, setInterval] = useState<"month" | "year">("month");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyPlanId, setBusyPlanId] = useState<Id<"gymPlans"> | null>(null);

  // Render nothing until there is an account to hang Prices on. `status`
  // undefined means the query hasn't resolved; null means no gym yet. Neither
  // is a state worth showing a card for.
  if (!status || !status.connected) return null;

  const parsed = parseDollarsToCents(amount);
  // The submit gate is the parser, not a separate rule — so the button is
  // disabled exactly when the server would reject the value, and the two can't
  // drift apart.
  const canSubmit = !saving && name.trim().length > 0 && parsed.ok;

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await createPlan({ name: name.trim(), amountCents: parsed.cents, interval });
      setName("");
      setAmount("");
    } catch (err) {
      setError(errorText(err, "Couldn't save that plan. Try again in a moment."));
    } finally {
      setSaving(false);
    }
  }

  async function onRetry(planId: Id<"gymPlans">) {
    setBusyPlanId(planId);
    setError(null);
    try {
      await retryPlanPrice({ planId });
    } catch (err) {
      setError(errorText(err, "Couldn't reach Stripe. Try again in a moment."));
    } finally {
      setBusyPlanId(null);
    }
  }

  async function onArchive(planId: Id<"gymPlans">) {
    setBusyPlanId(planId);
    setError(null);
    try {
      await archivePlan({ planId });
    } catch (err) {
      setError(errorText(err, "Couldn't remove that plan. Try again in a moment."));
    } finally {
      setBusyPlanId(null);
    }
  }

  return (
    <div className="rounded-xl p-6 mt-6" style={{ backgroundColor: "#222222", border: "1px solid #333333" }}>
      <p className="text-sm font-semibold mb-1" style={{ color: "#FFFFFF" }}>
        Membership plans
      </p>
      <p className="text-xs mb-5 leading-relaxed" style={{ color: "#888888" }}>
        The plans your members pay for — &quot;Adult Unlimited&quot;, &quot;Kids 2x/week&quot;. Each one
        becomes a price on your own Stripe account. Setting them up now doesn&apos;t charge anyone;
        assigning members comes next.
      </p>

      {plans === undefined && (
        <p className="text-xs mb-5" style={{ color: "#888888" }}>
          Loading your plans…
        </p>
      )}

      {plans && plans.length > 0 && (
        <ul className="mb-5 flex flex-col gap-2">
          {plans.map((plan) => (
            <li
              key={plan._id}
              className="flex items-center justify-between gap-3 rounded-lg px-4 py-3"
              style={{ backgroundColor: "#1A1A1A", border: "1px solid #333333" }}
            >
              <div className="min-w-0">
                <p className="text-sm truncate" style={{ color: "#FFFFFF" }}>
                  {plan.name}
                </p>
                <p className="text-xs" style={{ color: "#888888" }}>
                  {formatPlanPrice(plan.amountCents, plan.interval)}
                </p>
                {/* The plan row is kept when its Stripe Price fails so it stays
                    fixable rather than vanishing. This is the line that says so
                    — without it the plan looks ready and silently isn't. */}
                {!plan.billable && (
                  <p className="text-xs mt-1" style={{ color: "#F87171" }}>
                    Not set up at Stripe yet — retry to finish it.
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {!plan.billable && (
                  <button
                    type="button"
                    onClick={() => onRetry(plan._id)}
                    disabled={busyPlanId === plan._id}
                    className="text-xs rounded-lg px-3 py-2 disabled:cursor-not-allowed"
                    style={
                      busyPlanId === plan._id
                        ? DISABLED_BUTTON_STYLE
                        : { border: "1px solid #333333", color: "#CCCCCC" }
                    }
                  >
                    Retry
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onArchive(plan._id)}
                  disabled={busyPlanId === plan._id}
                  className="text-xs rounded-lg px-3 py-2 disabled:cursor-not-allowed"
                  style={
                    busyPlanId === plan._id
                      ? DISABLED_BUTTON_STYLE
                      : { border: "1px solid #333333", color: "#CCCCCC" }
                  }
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {plans && plans.length === 0 && (
        <p className="text-xs mb-5" style={{ color: "#888888" }}>
          No plans yet. Add the one most of your members are on first.
        </p>
      )}

      <form onSubmit={onCreate} className="flex flex-wrap items-start gap-3">
        <input
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Adult Unlimited"
          maxLength={80}
          aria-label="Plan name"
          className="text-xs rounded-lg px-3 py-2 flex-1 min-w-[12rem]"
          style={{ backgroundColor: "#1A1A1A", border: "1px solid #333333", color: "#FFFFFF" }}
        />
        {/* type="text", not type="number", on purpose. A number input lets the
            browser hand back "1e3" and locale decimal commas, and its spinner
            invites a click that changes a price by a dollar. The parser in
            lib/money.ts is the one authority on what a price may be. */}
        <input
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          placeholder="150.00"
          maxLength={12}
          aria-label="Monthly price in dollars"
          className="text-xs rounded-lg px-3 py-2 w-32"
          style={{ backgroundColor: "#1A1A1A", border: "1px solid #333333", color: "#FFFFFF" }}
        />
        <select
          value={interval}
          onChange={(event) => setInterval(event.target.value === "year" ? "year" : "month")}
          aria-label="Billing interval"
          className="text-xs rounded-lg px-3 py-2"
          style={{ backgroundColor: "#1A1A1A", border: "1px solid #333333", color: "#FFFFFF" }}
        >
          <option value="month">per month</option>
          <option value="year">per year</option>
        </select>
        <button
          type="submit"
          disabled={!canSubmit}
          className="text-xs font-semibold rounded-lg px-4 py-2 disabled:cursor-not-allowed"
          style={!canSubmit ? DISABLED_BUTTON_STYLE : { backgroundColor: "#E02020", color: "#FFFFFF" }}
        >
          {saving ? "Saving…" : "Add plan"}
        </button>
      </form>

      {/* Only once they have typed something — an empty field is not an error,
          it is the starting state, and colouring it red on load reads as a bug. */}
      {amount.trim().length > 0 && !parsed.ok && (
        <p className="text-xs mt-3 leading-relaxed" style={{ color: "#F87171" }}>
          {parsed.error}
        </p>
      )}

      {error && (
        <p className="text-xs mt-3 leading-relaxed" style={{ color: "#FF6B6B" }}>
          {error}
        </p>
      )}
    </div>
  );
}
