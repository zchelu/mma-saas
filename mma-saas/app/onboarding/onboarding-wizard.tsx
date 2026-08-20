"use client";

import { useState } from "react";
import { useUser } from "@clerk/nextjs";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { PLAN_LABEL, PLAN_PRICE_USD, TRIAL_DAYS } from "@/lib/plans";
import { DISABLED_BUTTON_STYLE } from "../components/button-styles";

const GENERIC_ERROR = "Something went wrong — please try again or contact us.";

// Colorado Automatic Renewal Law (C.R.S. 6-1-732) requires the auto-renewal
// terms be clear and conspicuous immediately adjacent to the enrollment
// button — not just earlier on /pricing. Price and trial length both come from
// lib/plans.ts (PLAN_PRICE_USD and TRIAL_DAYS), so this can't drift from the
// trial Stripe actually grants.
//
// It CAN drift from /pricing, and this comment used to deny that. /pricing
// renders its prices from app/pricing/tiers.ts:PRICING_TIERS, not from
// PLAN_PRICE_USD — two separate price tables that agree today (99/179/299)
// and are kept in step by nothing but attention. They were never one source;
// the claim was wrong before PRICING_TIERS moved out of the page file, and
// only looks wrong now. If they ever diverge the customer reads one price on
// /pricing and is disclosed another immediately above the enrollment button,
// which is precisely the mismatch C.R.S. 6-1-732 makes legally material.
function RenewalDisclosure({ plan }: { plan: string }) {
  const price = PLAN_PRICE_USD[plan];
  return (
    <p className="text-xs leading-relaxed" style={{ color: "#777777" }}>
      {`${TRIAL_DAYS}-day free trial, then $${price}/month, billed monthly. Cancel anytime before your trial ends to avoid being charged.`}
    </p>
  );
}

const inputStyle = {
  backgroundColor: "#222222",
  border: "1px solid #333333",
  color: "#FFFFFF",
};

function StepHeader({ step, plan, labels }: { step: number; plan: string; labels: string[] }) {
  return (
    <div className="mb-10">
      <p className="text-xs uppercase tracking-widest mb-3" style={{ color: "#888888" }}>
        Setting up {PLAN_LABEL[plan] ?? plan}
      </p>
      <div className="flex items-center gap-3">
        {labels.map((label, i) => (
          <div key={label} className="flex items-center gap-3 flex-1">
            <div className="flex items-center gap-2">
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: i <= step ? "#E02020" : "#333333" }}
              />
              <span
                className="text-sm font-semibold whitespace-nowrap"
                style={{ color: i <= step ? "#E02020" : "#555555" }}
              >
                {label}
              </span>
            </div>
            {i < labels.length - 1 && <div className="flex-1 h-px" style={{ backgroundColor: "#333333" }} />}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function OnboardingWizard({
  initialPlan,
  priceIdByPlan,
  repairMode = false,
  initialGymName = "",
  initialCity = "",
  initialState = "",
}: {
  initialPlan: string;
  priceIdByPlan: Record<string, string | undefined>;
  // Seeded from the gym row (app/onboarding/page.tsx). Anyone re-entering the
  // wizard has already been through it at least once — completeOnboarding runs
  // BEFORE Stripe Checkout, so their name/city/state are saved even though the
  // redirect guard sends them back here. Defaulted to "" so a brand-new owner
  // is unaffected.
  initialGymName?: string;
  initialCity?: string;
  initialState?: string;
  // True only for a gym that already has an active/trialing plan but no slug —
  // the guest-checkout dead-gym state (see app/onboarding/page.tsx). These
  // owners have already paid; the wizard exists for them purely to capture the
  // gym name so completeOnboarding can assign a slug and bring the consent page
  // to life. THEY MUST NOT BE SENT TO STRIPE AGAIN — doing so creates a second
  // subscription on the same customer.
  repairMode?: boolean;
}) {
  const plan = initialPlan;
  // No renamed tier skips the consent step: every academy/fightteam/blackbelt
  // plan includes winback texts (see the pricing page's "included in every
  // plan" list), unlike legacy Starter, which had none and used to skip this.
  // Not a rename of that old `plan === "starter"` check — academy inherits
  // Starter's price tier, not its feature set, so mechanically renaming the
  // string would have silently resurrected the skip for Academy.
  const skipConsent = false;
  const completeOnboarding = useMutation(api.onboarding.completeOnboarding);
  const { user } = useUser();

  const [step, setStep] = useState(0);
  const [gymName, setGymName] = useState(initialGymName);
  const [city, setCity] = useState(initialCity);
  const [state, setState] = useState(initialState);

  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Declared once each, because `disabled` and the disabled STYLE now read the
  // same boolean. Inlining the expression twice per button is how a control
  // ends up looking enabled while refusing to click, or the reverse.
  const step0Blocked = !gymName.trim() || (skipConsent && submitting);
  const step1Blocked = submitting || !consent;

  async function handleFinish() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await completeOnboarding({
        gymName: gymName.trim(),
        city: city.trim() || undefined,
        state: state.trim() || undefined,
        smsConsentConfirmed: consent,
        ownerEmail: user?.primaryEmailAddress?.emailAddress,
      });

      // Repair path: the subscription already exists and is active. The only
      // thing that was missing is the gym name, and completeOnboarding above
      // has now set it and generated the slug. Going on to /api/stripe/checkout
      // here would open a SECOND subscription for a customer who is already
      // paying — the one outcome worse than the dead-gym state this repairs.
      if (repairMode) {
        window.location.href = "/dashboard";
        return;
      }

      const priceId = priceIdByPlan[plan];
      if (!priceId) throw new Error("That plan isn't available right now.");

      const res = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priceId }),
      });
      const data = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (!res.ok || !data?.url) {
        setError(data?.error ?? GENERIC_ERROR);
        setSubmitting(false);
        return;
      }
      window.location.href = data.url;
    } catch (err) {
      console.error("Onboarding completion failed:", err);
      setError(err instanceof Error ? err.message : GENERIC_ERROR);
      setSubmitting(false);
    }
  }

  const labels = skipConsent ? ["Your gym"] : ["Your gym", "SMS consent"];

  return (
    <div className="max-w-xl mx-auto px-6 py-16">
      <StepHeader step={step} plan={plan} labels={labels} />

      {step === 0 && (
        <div className="flex flex-col gap-4">
          <h1 className="text-2xl font-bold mb-2" style={{ color: "#FFFFFF" }}>
            Tell us about your gym
          </h1>
          {repairMode && (
            <p
              className="text-sm leading-relaxed rounded-lg p-4 mb-1"
              style={{ color: "#CCCCCC", border: "1px solid #333333", backgroundColor: "#1A1A1A" }}
            >
              Your subscription is already active — nothing here will charge you. We just
              need your gym&apos;s name to finish setting up your member consent page.
            </p>
          )}
          <input
            value={gymName}
            onChange={(e) => setGymName(e.target.value)}
            placeholder="Gym name"
            className="rounded-lg px-4 py-3 text-sm focus:outline-none"
            style={inputStyle}
          />
          <div className="grid grid-cols-2 gap-3">
            <input
              value={city}
              onChange={(e) => setCity(e.target.value)}
              placeholder="City"
              className="rounded-lg px-4 py-3 text-sm focus:outline-none"
              style={inputStyle}
            />
            <input
              value={state}
              onChange={(e) => setState(e.target.value)}
              placeholder="State"
              className="rounded-lg px-4 py-3 text-sm focus:outline-none"
              style={inputStyle}
            />
          </div>

          {skipConsent && error && <p className="text-sm" style={{ color: "#FF6B6B" }}>{error}</p>}

          {skipConsent && <RenewalDisclosure plan={plan} />}

          <button
            type="button"
            disabled={step0Blocked}
            onClick={() => (skipConsent ? handleFinish() : setStep(1))}
            className="mt-4 rounded-lg font-semibold px-6 py-3 text-sm disabled:cursor-not-allowed"
            style={step0Blocked ? DISABLED_BUTTON_STYLE : { backgroundColor: "#E02020", color: "#FFFFFF" }}
          >
            {skipConsent ? (submitting ? "Setting up…" : "Continue to payment") : "Continue"}
          </button>
        </div>
      )}

      {step === 1 && !skipConsent && (
        <div className="flex flex-col gap-4">
          <h1 className="text-2xl font-bold mb-1" style={{ color: "#FFFFFF" }}>
            SMS consent
          </h1>
          <p className="text-sm mb-2" style={{ color: "#888888" }}>
            {gymName} · {PLAN_LABEL[plan] ?? plan}
          </p>

          <label
            className="flex items-start gap-3 rounded-lg p-4 cursor-pointer"
            style={{ border: `1px solid ${consent ? "#E02020" : "#333333"}` }}
          >
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              className="mt-0.5 w-4 h-4 shrink-0"
            />
            <span className="text-sm leading-relaxed" style={{ color: "#CCCCCC" }}>
              I understand that before texting any member, I must obtain their consent to
              receive SMS messages, per{" "}
              <a
                href="/terms#addclause"
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                Terms §26
              </a>{" "}
              — KombatDesk will not text a member whose consent has not been confirmed.
            </span>
          </label>

          {error && <p className="text-sm" style={{ color: "#FF6B6B" }}>{error}</p>}

          {/* C.R.S. 6-1-732 wants the auto-renewal terms adjacent to the
              ENROLLMENT button. In repair mode this button doesn't enroll
              anyone — the subscription already exists — so showing "30-day free
              trial, then $X/month" here would state terms that are no longer
              the ones taking effect. Say what this button actually does. */}
          {repairMode ? (
            <p className="text-xs leading-relaxed" style={{ color: "#777777" }}>
              This finishes your setup. Your existing subscription is unchanged and you
              will not be charged again here.
            </p>
          ) : (
            <RenewalDisclosure plan={plan} />
          )}

          <div className="flex gap-3 mt-2">
            <button
              type="button"
              onClick={() => setStep(0)}
              disabled={submitting}
              className="rounded-lg font-semibold px-6 py-3 text-sm disabled:cursor-not-allowed"
              style={{
                backgroundColor: "#1A1A1A",
                color: "#AAAAAA",
                border: "1px solid #333333",
                ...(submitting ? DISABLED_BUTTON_STYLE : {}),
              }}
            >
              Back
            </button>
            <button
              type="button"
              disabled={step1Blocked}
              onClick={handleFinish}
              className="flex-1 rounded-lg font-semibold px-6 py-3 text-sm disabled:cursor-not-allowed"
              style={step1Blocked ? DISABLED_BUTTON_STYLE : { backgroundColor: "#E02020", color: "#FFFFFF" }}
            >
              {submitting ? "Setting up…" : repairMode ? "Finish setup" : "Continue to payment"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
