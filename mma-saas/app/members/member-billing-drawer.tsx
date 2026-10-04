"use client";
import { useMemo, useState } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { ErrorToast, getErrorMessage } from "../components/error-toast";
import { DISABLED_BUTTON_STYLE } from "../components/button-styles";
import { useOrigin } from "../components/use-origin";
import SelectField from "../components/select-field";

// The member's Billing tab — dues, end to end, for one member.
//
// Same drawer shape as documents-drawer.tsx. This is the ONLY thing in app/
// that reaches the member-dues path (convex/memberBilling.ts +
// convex/memberBillingStripe.ts), so every state that path can be in has to be
// explainable here, and each one gets a sentence the owner can act on rather
// than a button that throws when pressed.
//
// THE STATES ARE ORDERED, not independent. connectReady gates everything —
// spec §5.2's charge gate, which memberBillingStripe.requireChargeReadyAccount
// enforces server-side. This renders it as an explanation rather than trusting
// the action to reject: a dead "Send payment link" button on an unverified
// account is a support call.

type Props = {
  memberId: Id<"members">;
  memberName: string;
  onClose: () => void;
};

// The ONLY place in this component that touches the cents/dollars boundary.
//
// planAmountCents is INTEGER cents, the same integer Stripe holds (see the
// schema comment on gymPlans.amountCents). Dividing anywhere else is how two
// parts of a screen come to disagree about a price by a rounding step, so
// every display goes through here and nothing else multiplies or divides.
function formatMoney(amountCents: number): string {
  return (amountCents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

function formatPlanPrice(amountCents: number, interval: "month" | "year"): string {
  return `${formatMoney(amountCents)} / ${interval}`;
}

// Stripe's subscription vocabulary, in the owner's words. Must stay in step
// with convex/memberBilling.ts:duesStatus.
const DUES_PILL: Record<string, { label: string; background: string; color: string }> = {
  active: { label: "Active", background: "#0A2A14", color: "#4ADE80" },
  past_due: { label: "Past due", background: "#2A1F0A", color: "#FBBF24" },
  unpaid: { label: "Unpaid", background: "#2A0A0A", color: "#F87171" },
  // A card was attached but the first charge hasn't cleared yet — distinct
  // from "unpaid" (Stripe has given up retrying). See
  // connectDuesWebhookAction.ts:toDuesStatus.
  incomplete: { label: "Payment failed", background: "#2A0A0A", color: "#F87171" },
  canceled: { label: "Canceled", background: "#222222", color: "#888888" },
};

export default function MemberBillingDrawer({ memberId, memberName, onClose }: Props) {
  const billing = useQuery(api.memberBilling.getMemberBillingState, { memberId });
  const plans = useQuery(api.gymPlans.listPlans);

  const createDuesSetupLink = useAction(api.memberBillingStripe.createDuesSetupLink);
  const changeMemberPlan = useAction(api.memberBillingStripe.changeMemberPlan);
  const cancelMemberDues = useAction(api.memberBillingStripe.cancelMemberDues);
  const assignMemberPlan = useMutation(api.memberBilling.assignMemberPlan);

  // "" on the server and through hydration — see use-origin.ts. The action
  // ALLOWLISTS this value (memberBillingStripe.requireAllowedOrigin), so
  // sending "" is a guaranteed ConvexError. The button waits instead.
  const origin = useOrigin();

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The link Stripe returns ONCE. Nothing persists it — not the members row,
  // not the session — so losing it means creating another Checkout Session.
  // It stays on screen until the drawer closes.
  const [setupLink, setSetupLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  const planList = useMemo(() => plans ?? [], [plans]);

  async function run(work: () => Promise<void>, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      // VERBATIM. Every throw on this path is a ConvexError written for the
      // owner — "Retry it on the plans card", "Finish verification on the
      // dashboard first". Replacing them with a generic string throws away the
      // only instruction that tells them what to do next.
      setError(getErrorMessage(err, fallback));
    } finally {
      setBusy(false);
    }
  }

  function handleSendLink() {
    void run(async () => {
      const { url } = await createDuesSetupLink({ memberId, origin });
      setSetupLink(url);
      setCopied(false);
    }, "Couldn't create a payment link — try again in a moment.");
  }

  function handlePickPlan(planId: Id<"gymPlans">) {
    void run(async () => {
      if (billing?.hasSubscription) {
        // Stripe moves FIRST and prorates; the row follows. Never the mutation
        // here — it refuses under a live subscription for exactly this reason.
        await changeMemberPlan({ memberId, planId });
      } else {
        await assignMemberPlan({ memberId, planId });
      }
    }, "Couldn't change the plan — try again.");
  }

  function handleCancelDues() {
    void run(async () => {
      await cancelMemberDues({ memberId });
      setConfirmingCancel(false);
    }, "Couldn't cancel dues — nothing was changed. Try again.");
  }

  async function handleCopy() {
    if (!setupLink) return;
    try {
      await navigator.clipboard.writeText(setupLink);
      setCopied(true);
    } catch {
      // Clipboard access can be refused outright (permissions, an insecure
      // origin). The field is selectable, so saying so beats a silent no-op.
      setError("Couldn't copy — select the link and copy it manually.");
    }
  }

  return (
    <>
      <div
        className="fixed inset-0 z-40"
        style={{ backgroundColor: "rgba(0,0,0,0.6)" }}
        onClick={onClose}
      />
      <div
        className="fixed right-0 top-0 h-full z-50 flex flex-col"
        style={{ width: 420, backgroundColor: "#111111", borderLeft: "1px solid #333333" }}
      >
        <div
          className="flex items-center justify-between px-6 py-5"
          style={{ borderBottom: "1px solid #333333" }}
        >
          <div>
            <p className="text-xs uppercase tracking-widest mb-1" style={{ color: "#555555" }}>
              Billing
            </p>
            <h2 className="text-lg font-semibold" style={{ color: "#FFFFFF" }}>
              {memberName}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors text-sm"
            style={{ color: "#888888", backgroundColor: "#1A1A1A" }}
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">
          {error && <ErrorToast message={error} />}

          {billing === undefined ? (
            <p className="text-sm" style={{ color: "#555555" }}>
              Loading…
            </p>
          ) : billing === null ? (
            // null is "no gym yet, or not your member" — a state the query
            // returns rather than throwing (see its tryGetGym comment). It
            // reaches here on first paint before Clerk hydrates, so it must
            // read as empty, never as an error.
            <p className="text-sm" style={{ color: "#555555" }}>
              Nothing to show for this member.
            </p>
          ) : !billing.connectReady ? (
            <Notice>
              Finish your Stripe setup on the dashboard before you can charge members.
            </Notice>
          ) : !billing.billable ? (
            // members.gymId is optional-until-backfilled. This member predates
            // the backfill, so nothing server-side will bill them.
            <Notice>
              This member was added before gym billing was set up and can&apos;t be charged
              until the data migration runs. Everything else about them still works.
            </Notice>
          ) : (
            <>
              {billing.hasSubscription && (
                <SubscriptionSummary
                  duesStatus={billing.duesStatus}
                  planName={billing.planName}
                  planAmountCents={billing.planAmountCents}
                  planInterval={billing.planInterval}
                  duesFailedAt={billing.duesFailedAt}
                  duesFailureCount={billing.duesFailureCount}
                />
              )}

              {!billing.planId ? (
                <p className="text-sm" style={{ color: "#888888" }}>
                  Pick a plan to start dues.
                </p>
              ) : !billing.planBillable ? (
                <Notice>
                  &ldquo;{billing.planName}&rdquo; isn&apos;t finished at Stripe yet. Retry it
                  on the plans card on your dashboard, then come back.
                </Notice>
              ) : !billing.hasSubscription && !billing.hasCustomer ? (
                <p className="text-sm" style={{ color: "#888888" }}>
                  Send {memberName.trim().split(/\s+/)[0]} a link to save a card. Nothing is
                  charged until they do.
                </p>
              ) : billing.duesStatus === "incomplete_expired" ? (
                // Stripe expired the setup link before the member attached a
                // card — a dead end, not something that will resolve on its
                // own. "the old link keeps working too" below would be false
                // here, which is why this gets its own branch instead of
                // falling into the generic "no card saved yet" copy.
                <p className="text-sm" style={{ color: "#F87171" }}>
                  Link expired, send a new one — the old one stopped working before{" "}
                  {memberName.trim().split(/\s+/)[0]} saved a card.
                </p>
              ) : !billing.hasSubscription ? (
                // A Customer exists but no subscription. The link was created;
                // the card was never saved. Deliberately NOT called pending or
                // active — nothing is running and nothing will collect.
                //
                // THE EARLIER LINK IS DELIBERATELY NOT STORED, and "let the
                // owner re-view it" is not the fix it looks like. A Checkout
                // Session URL is a BEARER CREDENTIAL: anyone holding it can
                // attach a card to this member's customer record, no login
                // required. Persisting it would park a live, reusable
                // credential in the dashboard, outliving the reason it was
                // created and readable by anyone who reaches this panel.
                // Generating a fresh session is one API call. Do that instead.
                <p className="text-sm" style={{ color: "#888888" }}>
                  Link sent — no card saved yet. Send a fresh one whenever you like; the
                  old link keeps working too.
                </p>
              ) : null}

              <PlanPicker
                plans={planList}
                loading={plans === undefined}
                currentPlanId={billing.planId}
                hasSubscription={billing.hasSubscription}
                disabled={busy}
                onPick={handlePickPlan}
              />

              {billing.planId && billing.planBillable && !billing.hasSubscription && (
                <div className="flex flex-col gap-3">
                  <button
                    onClick={handleSendLink}
                    disabled={busy || origin === ""}
                    className="rounded-lg text-sm font-semibold px-4 py-2 transition-colors"
                    style={{
                      backgroundColor: "#E02020",
                      color: "#FFFFFF",
                      ...(busy || origin === "" ? DISABLED_BUTTON_STYLE : {}),
                    }}
                  >
                    {busy
                      ? "Working…"
                      : billing.hasCustomer
                        ? "Send a fresh link"
                        : "Send payment link"}
                  </button>

                  {setupLink && (
                    <SetupLinkField url={setupLink} copied={copied} onCopy={handleCopy} />
                  )}
                </div>
              )}

              {billing.hasSubscription && (
                <CancelDues
                  confirming={confirmingCancel}
                  busy={busy}
                  onStart={() => setConfirmingCancel(true)}
                  onAbort={() => setConfirmingCancel(false)}
                  onConfirm={handleCancelDues}
                />
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded-lg px-4 py-3"
      style={{ backgroundColor: "#1A1A1A", border: "1px solid #333333" }}
    >
      <p className="text-sm leading-relaxed" style={{ color: "#888888" }}>
        {children}
      </p>
    </div>
  );
}

function SubscriptionSummary({
  duesStatus,
  planName,
  planAmountCents,
  planInterval,
  duesFailedAt,
  duesFailureCount,
}: {
  duesStatus: string | null;
  planName: string | null;
  planAmountCents: number | null;
  planInterval: "month" | "year" | null;
  duesFailedAt: number | null;
  duesFailureCount: number;
}) {
  const pill = duesStatus ? DUES_PILL[duesStatus] : undefined;
  return (
    <div
      className="rounded-lg px-4 py-4 flex flex-col gap-2"
      style={{ backgroundColor: "#1A1A1A", borderLeft: "3px solid #E02020" }}
    >
      <div className="flex items-center gap-2 flex-wrap">
        {pill && (
          <span
            className="text-xs px-2 py-0.5 rounded-full font-semibold"
            style={{ backgroundColor: pill.background, color: pill.color }}
          >
            {pill.label}
          </span>
        )}
        <span className="text-sm font-medium" style={{ color: "#FFFFFF" }}>
          {planName ?? "Plan removed"}
        </span>
      </div>
      {planAmountCents !== null && planInterval !== null && (
        <p className="text-xs" style={{ color: "#888888" }}>
          {formatPlanPrice(planAmountCents, planInterval)}
        </p>
      )}
      {duesFailedAt !== null && duesFailureCount > 0 && (
        <p className="text-xs" style={{ color: "#FBBF24" }}>
          {duesFailureCount === 1 ? "1 failed payment" : `${duesFailureCount} failed payments`},
          last on{" "}
          {new Date(duesFailedAt).toLocaleDateString("en-US", {
            month: "long",
            day: "numeric",
            year: "numeric",
          })}
          .{" "}
          {/* incomplete = the FIRST charge failed. Stripe gives the member
              ~23 hours to pay that invoice, then expires the subscription and
              voids it — the owner has to send a new link. Renewal failures
              (past_due/unpaid) are retried by Stripe, so the old copy holds. */}
          {duesStatus === "incomplete"
            ? "They have about a day to pay. After that the link expires and you send a new one."
            : <>Stripe emails them about the card; you don&apos;t need to do anything here.</>}
        </p>
      )}
    </div>
  );
}

type PlanOption = {
  _id: Id<"gymPlans">;
  name: string;
  amountCents: number;
  interval: "month" | "year";
  billable: boolean;
};

function PlanPicker({
  plans,
  loading,
  currentPlanId,
  hasSubscription,
  disabled,
  onPick,
}: {
  plans: PlanOption[];
  loading: boolean;
  currentPlanId: Id<"gymPlans"> | null;
  hasSubscription: boolean;
  disabled: boolean;
  onPick: (planId: Id<"gymPlans">) => void;
}) {
  const options = useMemo(
    () =>
      plans.map((plan) => ({
        value: plan._id,
        label: plan.name,
        hint: `${formatPlanPrice(plan.amountCents, plan.interval)}${
          plan.billable ? "" : " (not ready at Stripe)"
        }`,
      })),
    [plans]
  );

  if (loading) {
    return (
      <p className="text-sm" style={{ color: "#555555" }}>
        Loading plans…
      </p>
    );
  }
  if (plans.length === 0) {
    return (
      <Notice>
        No plans yet. Create one on the plans card on your dashboard, then come back.
      </Notice>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs uppercase tracking-widest" style={{ color: "#555555" }}>
        {hasSubscription ? "Change plan" : "Plan"}
      </p>
      <SelectField
        className="w-full"
        value={currentPlanId ?? ""}
        disabled={disabled}
        onChange={(next) => {
          if (next && next !== currentPlanId) onPick(next as Id<"gymPlans">);
        }}
        options={options}
        placeholder="Select a plan…"
      />
      {hasSubscription && (
        // Says what changeMemberPlan actually does, before it is done. The
        // proration is a real charge or credit on the member's next invoice.
        <p className="text-xs" style={{ color: "#555555" }}>
          Changing this moves the subscription at Stripe straight away and prorates the rest
          of the current period.
        </p>
      )}
    </div>
  );
}

function SetupLinkField({
  url,
  copied,
  onCopy,
}: {
  url: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div
      className="rounded-lg px-4 py-4 flex flex-col gap-3"
      style={{ backgroundColor: "#1A1A1A", border: "1px solid #333333" }}
    >
      {/* Stripe returns this URL once and nothing stores it. Selectable, not
          just copyable, so a failed clipboard write is recoverable. */}
      <p
        className="text-xs break-all select-all"
        style={{ color: "#FFFFFF", fontFamily: "var(--font-geist-mono)" }}
      >
        {url}
      </p>
      <button
        onClick={onCopy}
        className="rounded-lg text-sm font-semibold px-4 py-2 transition-colors self-start"
        style={{ backgroundColor: "#333333", color: "#FFFFFF" }}
      >
        {copied ? "Copied" : "Copy link"}
      </button>
      <p className="text-xs leading-relaxed" style={{ color: "#888888" }}>
        Text or email this. It&apos;s a Stripe-hosted page for entering a card — it carries no
        login and gives access to nothing but this one member&apos;s card entry.
      </p>
      <p className="text-xs" style={{ color: "#555555" }}>
        It won&apos;t be shown again after you close this panel. Sending a fresh one later is
        free.
      </p>
    </div>
  );
}

function CancelDues({
  confirming,
  busy,
  onStart,
  onAbort,
  onConfirm,
}: {
  confirming: boolean;
  busy: boolean;
  onStart: () => void;
  onAbort: () => void;
  onConfirm: () => void;
}) {
  // Two-step INSIDE the drawer, never window.confirm — a native modal blocks
  // the page and the browser extension along with it, and this panel is one of
  // the flows most likely to be driven from there.
  if (!confirming) {
    return (
      <button
        onClick={onStart}
        className="text-xs transition-colors self-start"
        style={{ color: "#F87171" }}
      >
        Cancel dues
      </button>
    );
  }

  return (
    <div
      className="rounded-lg px-4 py-4 flex flex-col gap-3"
      style={{ backgroundColor: "#2A0A0A", border: "1px solid #F87171" }}
    >
      <p className="text-sm leading-relaxed" style={{ color: "#F87171" }}>
        Cancel dues now? This stops the subscription immediately — not at the end of the
        period — so there is no final charge. Restarting means sending a new payment link.
      </p>
      <div className="flex gap-3">
        <button
          onClick={onConfirm}
          disabled={busy}
          className="rounded-lg text-sm font-semibold px-4 py-2 transition-colors"
          style={{
            backgroundColor: "#E02020",
            color: "#FFFFFF",
            ...(busy ? DISABLED_BUTTON_STYLE : {}),
          }}
        >
          {busy ? "Canceling…" : "Yes, cancel dues"}
        </button>
        <button
          onClick={onAbort}
          disabled={busy}
          className="rounded-lg text-sm font-semibold px-4 py-2 transition-colors"
          style={{
            backgroundColor: "#333333",
            color: "#FFFFFF",
            ...(busy ? DISABLED_BUTTON_STYLE : {}),
          }}
        >
          Keep dues
        </button>
      </div>
    </div>
  );
}
