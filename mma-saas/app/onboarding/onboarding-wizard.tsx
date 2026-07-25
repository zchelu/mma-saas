"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { PLAN_LABEL, PLAN_PRICE_USD, TRIAL_DAYS } from "@/lib/plans";

const GENERIC_ERROR = "Something went wrong — please try again or contact us.";

// Colorado Automatic Renewal Law (C.R.S. 6-1-732) requires the auto-renewal
// terms be clear and conspicuous immediately adjacent to the enrollment
// button — not just earlier on /pricing. Price and trial length both come from
// lib/plans.ts — the same source app/pricing/page.tsx uses for price — so
// this can't drift from what the customer saw there or from what Stripe
// actually grants.
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
}: {
  initialPlan: string;
  priceIdByPlan: Record<string, string | undefined>;
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

  const [step, setStep] = useState(0);
  const [gymName, setGymName] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");

  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      });

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
            disabled={!gymName.trim() || (skipConsent && submitting)}
            onClick={() => (skipConsent ? handleFinish() : setStep(1))}
            className="mt-4 rounded-lg font-semibold px-6 py-3 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
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
              receive SMS messages, per KombatDesk&apos;s SMS Consent Addendum — enforced
              whenever a phone number is added to a member.
            </span>
          </label>

          {error && <p className="text-sm" style={{ color: "#FF6B6B" }}>{error}</p>}

          <RenewalDisclosure plan={plan} />

          <div className="flex gap-3 mt-2">
            <button
              type="button"
              onClick={() => setStep(0)}
              disabled={submitting}
              className="rounded-lg font-semibold px-6 py-3 text-sm disabled:opacity-40"
              style={{ backgroundColor: "#1A1A1A", color: "#AAAAAA", border: "1px solid #333333" }}
            >
              Back
            </button>
            <button
              type="button"
              disabled={submitting || !consent}
              onClick={handleFinish}
              className="flex-1 rounded-lg font-semibold px-6 py-3 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
            >
              {submitting ? "Setting up…" : "Continue to payment"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
