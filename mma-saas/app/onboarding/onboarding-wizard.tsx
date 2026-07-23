"use client";

import { useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";

type MemberDraft = { name: string; email?: string; phone?: string; beltRank?: string };

const PLAN_LABEL: Record<string, string> = { starter: "Starter", pro: "Pro", elite: "Elite" };
const GENERIC_ERROR = "Something went wrong — please try again or contact us.";

const inputStyle = {
  backgroundColor: "#222222",
  border: "1px solid #333333",
  color: "#FFFFFF",
};

// Simple same-shape CSV parser for the onboarding roster upload — expects a
// header row containing name/email/phone/beltRank in some order. This is
// deliberately NOT scripts/import-members.js's platform auto-detection
// (PushPress/Zen Planner/Kicksite/Gymdesk column-mapping + belt-taxonomy
// normalization): that logic is Node-only and CLI-run by design (see its
// header comment), and pulling it into the browser bundle for a one-time
// initial-roster step during signup isn't worth the size/complexity here.
// Gyms migrating a full existing roster from one of those platforms should
// still use that script post-signup, not this upload.
function parseCsv(text: string): MemberDraft[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const nameIdx = headers.indexOf("name");
  if (nameIdx === -1) return [];
  const emailIdx = headers.indexOf("email");
  const phoneIdx = headers.indexOf("phone");
  const beltIdx = headers.findIndex((h) => h === "beltrank" || h === "belt");

  return lines.slice(1).map((line) => {
    const cols = line.split(",").map((c) => c.trim());
    return {
      name: cols[nameIdx] ?? "",
      email: emailIdx >= 0 ? cols[emailIdx] || undefined : undefined,
      phone: phoneIdx >= 0 ? cols[phoneIdx] || undefined : undefined,
      beltRank: beltIdx >= 0 ? cols[beltIdx] || undefined : undefined,
    };
  }).filter((m) => m.name);
}

function StepHeader({ step, plan }: { step: number; plan: string }) {
  const labels = ["Your gym", "Add members", "Confirm & continue"];
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
  const completeOnboarding = useMutation(api.onboarding.completeOnboarding);

  const [step, setStep] = useState(0);
  const [gymName, setGymName] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");

  const [members, setMembers] = useState<MemberDraft[]>([]);
  const [draft, setDraft] = useState<MemberDraft>({ name: "", email: "", phone: "" });
  const fileInput = useRef<HTMLInputElement>(null);
  const [csvError, setCsvError] = useState<string | null>(null);

  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasPhoneMembers = members.some((m) => m.phone);

  function addDraftMember() {
    if (!draft.name.trim()) return;
    setMembers((prev) => [...prev, { ...draft, name: draft.name.trim() }]);
    setDraft({ name: "", email: "", phone: "" });
  }

  function removeMember(idx: number) {
    setMembers((prev) => prev.filter((_, i) => i !== idx));
  }

  async function handleCsvFile(file: File) {
    setCsvError(null);
    try {
      const text = await file.text();
      const parsed = parseCsv(text);
      if (parsed.length === 0) {
        setCsvError('No rows found — make sure the file has a header row with a "name" column.');
        return;
      }
      setMembers((prev) => [...prev, ...parsed]);
    } catch {
      setCsvError("Couldn't read that file — please try a plain CSV export.");
    }
  }

  async function handleFinish() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await completeOnboarding({
        gymName: gymName.trim(),
        city: city.trim() || undefined,
        state: state.trim() || undefined,
        members: members.map((m) => ({
          name: m.name,
          email: m.email || undefined,
          phone: m.phone || undefined,
          beltRank: m.beltRank || undefined,
        })),
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

  return (
    <div className="max-w-xl mx-auto px-6 py-16">
      <StepHeader step={step} plan={plan} />

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
          <button
            type="button"
            disabled={!gymName.trim()}
            onClick={() => setStep(1)}
            className="mt-4 rounded-lg font-semibold px-6 py-3 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
          >
            Continue
          </button>
        </div>
      )}

      {step === 1 && (
        <div className="flex flex-col gap-4">
          <h1 className="text-2xl font-bold mb-1" style={{ color: "#FFFFFF" }}>
            Add your members
          </h1>
          <p className="text-sm mb-2" style={{ color: "#888888" }}>
            Add at least one member — one at a time, or upload a CSV.
          </p>

          <div className="flex flex-col gap-2 rounded-lg p-4" style={{ border: "1px solid #333333" }}>
            <div className="grid grid-cols-2 gap-3">
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="Name"
                className="rounded-lg px-3 py-2 text-sm focus:outline-none"
                style={inputStyle}
              />
              <input
                value={draft.phone ?? ""}
                onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
                placeholder="Phone (optional)"
                className="rounded-lg px-3 py-2 text-sm focus:outline-none"
                style={inputStyle}
              />
            </div>
            <input
              value={draft.email ?? ""}
              onChange={(e) => setDraft({ ...draft, email: e.target.value })}
              placeholder="Email (optional)"
              className="rounded-lg px-3 py-2 text-sm focus:outline-none"
              style={inputStyle}
            />
            <button
              type="button"
              onClick={addDraftMember}
              disabled={!draft.name.trim()}
              className="self-start rounded-lg font-semibold px-4 py-2 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ backgroundColor: "#1A1A1A", color: "#FFFFFF", border: "1px solid #333333" }}
            >
              Add member
            </button>
          </div>

          <div>
            <input
              ref={fileInput}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleCsvFile(file);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              className="text-sm underline"
              style={{ color: "#888888" }}
            >
              Or upload a CSV (name, email, phone, beltRank columns)
            </button>
            {csvError && <p className="text-sm mt-2" style={{ color: "#FF6B6B" }}>{csvError}</p>}
          </div>

          {members.length > 0 && (
            <ul className="flex flex-col gap-2 mt-2">
              {members.map((m, i) => (
                <li
                  key={`${m.name}-${i}`}
                  className="flex items-center justify-between rounded-lg px-4 py-2 text-sm"
                  style={{ backgroundColor: "#1A1A1A", color: "#CCCCCC" }}
                >
                  <span>
                    {m.name} {m.phone && <span style={{ color: "#666666" }}>· {m.phone}</span>}
                  </span>
                  <button type="button" onClick={() => removeMember(i)} style={{ color: "#888888" }}>
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex gap-3 mt-4">
            <button
              type="button"
              onClick={() => setStep(0)}
              className="rounded-lg font-semibold px-6 py-3 text-sm"
              style={{ backgroundColor: "#1A1A1A", color: "#AAAAAA", border: "1px solid #333333" }}
            >
              Back
            </button>
            <button
              type="button"
              disabled={members.length === 0}
              onClick={() => setStep(2)}
              className="flex-1 rounded-lg font-semibold px-6 py-3 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="flex flex-col gap-4">
          <h1 className="text-2xl font-bold mb-1" style={{ color: "#FFFFFF" }}>
            Confirm & continue
          </h1>
          <p className="text-sm mb-2" style={{ color: "#888888" }}>
            {gymName} · {members.length} member{members.length === 1 ? "" : "s"} · {PLAN_LABEL[plan]}
          </p>

          {hasPhoneMembers && (
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
                I confirm I have obtained consent from the members above to receive SMS messages
                from my gym, per KombatDesk&apos;s SMS Consent Addendum. Members added without a
                phone number don&apos;t require this.
              </span>
            </label>
          )}

          {error && <p className="text-sm" style={{ color: "#FF6B6B" }}>{error}</p>}

          <div className="flex gap-3 mt-2">
            <button
              type="button"
              onClick={() => setStep(1)}
              disabled={submitting}
              className="rounded-lg font-semibold px-6 py-3 text-sm disabled:opacity-40"
              style={{ backgroundColor: "#1A1A1A", color: "#AAAAAA", border: "1px solid #333333" }}
            >
              Back
            </button>
            <button
              type="button"
              disabled={submitting || (hasPhoneMembers && !consent)}
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
