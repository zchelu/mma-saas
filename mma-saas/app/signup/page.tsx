"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { sendLead } from "@/app/actions/sendLead";

const CHALLENGE_OPTIONS = [
  {
    id: "retention",
    label: "I don't know which members are about to quit",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
  {
    id: "billing",
    label: "Chasing unpaid memberships and invoices",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" />
      </svg>
    ),
  },
  {
    id: "scheduling",
    label: "Managing class schedules and attendance",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
        <line x1="16" y1="2" x2="16" y2="6" />
        <line x1="8" y1="2" x2="8" y2="6" />
        <line x1="3" y1="10" x2="21" y2="10" />
      </svg>
    ),
  },
  {
    id: "checkin",
    label: "Check-in is slow or chaotic at the door",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
        <line x1="12" y1="18" x2="12.01" y2="18" strokeWidth="2.5" />
      </svg>
    ),
  },
  {
    id: "visibility",
    label: "No visibility into how my gym is actually performing",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
      </svg>
    ),
  },
  {
    id: "admin",
    label: "Too much time on admin, not enough on the mats",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
    ),
  },
];

export default function SignupPage() {
  const router = useRouter();
  const [contactMode, setContactMode] = useState<"phone" | "email">("phone");
  const [form, setForm] = useState({ phone: "", email: "", firstName: "", lastName: "" });
  const [selected, setSelected] = useState<string | null>(null);
  const [custom, setCustom] = useState("");
  const [challengeOpen, setChallengeOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    setForm({ ...form, [e.target.name]: e.target.value });
  }

  function handleSelect(id: string) {
    setSelected(selected === id ? null : id);
    setCustom("");
  }

  function handleCustomChange(e: React.ChangeEvent<HTMLInputElement>) {
    setCustom(e.target.value);
    if (e.target.value) setSelected(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const name = `${form.firstName} ${form.lastName}`;
    const contact = contactMode === "phone" ? form.phone : form.email;
    const challenge = selected
      ? CHALLENGE_OPTIONS.find((o) => o.id === selected)?.label
      : custom || undefined;
    const result = await sendLead(name, contact, challenge);
    if (result.success) {
      router.push("/thank-you");
    } else {
      setError("Something went wrong. Please try again.");
      setLoading(false);
    }
  }

  const contactFilled = contactMode === "phone" ? form.phone : form.email;
  const ready = contactFilled && form.firstName && form.lastName;

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 py-12" style={{ backgroundColor: "#0D0D0D" }}>
      <div className="w-full max-w-[480px]">

        {/* Progress indicator */}
        <div className="flex items-center gap-3 mb-10">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: "#E02020" }} />
            <span className="text-sm font-semibold" style={{ color: "#E02020" }}>Your details</span>
          </div>
          <div className="flex-1 h-px" style={{ backgroundColor: "#333333" }} />
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: "#333333" }} />
            <span className="text-sm font-medium" style={{ color: "#555555" }}>Set up your gym</span>
          </div>
        </div>

        {/* Heading */}
        <h1 className="text-2xl font-extrabold tracking-tight mb-2" style={{ color: "#FFFFFF", fontWeight: 500 }}>
          Let&apos;s get your gym set up
        </h1>
        <p className="text-sm mb-8 leading-relaxed" style={{ color: "#888888" }}>
          We&apos;ll reach out within 24 hours to get KombatDesk running for your gym — usually takes less than an hour.
        </p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {/* Phone / Email toggle */}
          <div className="flex rounded-lg p-1" style={{ backgroundColor: "#1A1A1A", border: "1px solid #333333" }}>
            <button
              type="button"
              onClick={() => setContactMode("phone")}
              className="flex-1 py-2 text-sm font-semibold rounded-md transition-colors"
              style={{
                backgroundColor: contactMode === "phone" ? "#E02020" : "transparent",
                color: contactMode === "phone" ? "#FFFFFF" : "#888888",
              }}
            >
              Phone
            </button>
            <button
              type="button"
              onClick={() => setContactMode("email")}
              className="flex-1 py-2 text-sm font-semibold rounded-md transition-colors"
              style={{
                backgroundColor: contactMode === "email" ? "#E02020" : "transparent",
                color: contactMode === "email" ? "#FFFFFF" : "#888888",
              }}
            >
              Email
            </button>
          </div>

          {/* Contact input */}
          {contactMode === "phone" ? (
            <div className="flex rounded-lg overflow-hidden transition-colors" style={{ border: "1px solid #333333", backgroundColor: "#222222" }}>
              <div className="flex items-center gap-2 px-3 shrink-0" style={{ borderRight: "1px solid #333333", backgroundColor: "#1A1A1A" }}>
                <span className="text-lg leading-none">🇺🇸</span>
                <span className="text-sm font-medium" style={{ color: "#888888" }}>+1</span>
              </div>
              <input
                name="phone"
                value={form.phone}
                onChange={handleChange}
                type="tel"
                autoComplete="tel"
                placeholder="(720) 555-0100"
                className="flex-1 px-4 py-3 text-sm focus:outline-none"
                style={{ backgroundColor: "#222222", color: "#FFFFFF" }}
              />
            </div>
          ) : (
            <input
              name="email"
              value={form.email}
              onChange={handleChange}
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              className="w-full rounded-lg px-4 py-3 text-sm focus:outline-none transition-colors"
              style={{ backgroundColor: "#222222", border: "1px solid #333333", color: "#FFFFFF" }}
            />
          )}

          {/* First / Last name */}
          <div className="grid grid-cols-2 gap-3">
            <input
              name="firstName"
              value={form.firstName}
              onChange={handleChange}
              autoComplete="given-name"
              placeholder="First name"
              className="rounded-lg px-4 py-3 text-sm focus:outline-none transition-colors"
              style={{ backgroundColor: "#222222", border: "1px solid #333333", color: "#FFFFFF" }}
            />
            <input
              name="lastName"
              value={form.lastName}
              onChange={handleChange}
              autoComplete="family-name"
              placeholder="Last name"
              className="rounded-lg px-4 py-3 text-sm focus:outline-none transition-colors"
              style={{ backgroundColor: "#222222", border: "1px solid #333333", color: "#FFFFFF" }}
            />
          </div>

          {/* Questionnaire */}
          <button
            type="button"
            onClick={() => setChallengeOpen(!challengeOpen)}
            className="w-full flex items-center justify-between rounded-lg px-4 py-3 text-left transition-colors"
            style={{
              backgroundColor: challengeOpen ? "#1a0505" : "#222222",
              border: `1px solid ${challengeOpen || selected || custom ? "#E02020" : "#333333"}`,
            }}
          >
            <span className="text-sm font-medium" style={{ color: selected || custom ? "#FFFFFF" : "#888888" }}>
              {selected
                ? CHALLENGE_OPTIONS.find(o => o.id === selected)?.label
                : custom || "What's your biggest challenge? (optional)"}
            </span>
            <svg
              width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"
              style={{
                color: "#888888",
                transform: challengeOpen ? "rotate(180deg)" : "rotate(0deg)",
                transition: "transform 0.2s",
                flexShrink: 0,
              }}
            >
              <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          {challengeOpen && (
            <div className="flex flex-col gap-2">
              {CHALLENGE_OPTIONS.map((option) => {
                const isSelected = selected === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => { handleSelect(option.id); setChallengeOpen(false); }}
                    className="w-full flex items-center gap-3 rounded-lg px-4 py-3 text-left transition-colors"
                    style={{
                      backgroundColor: isSelected ? "#1a0505" : "#222222",
                      border: `1px solid ${isSelected ? "#E02020" : "#333333"}`,
                    }}
                  >
                    <span className="shrink-0" style={{ color: isSelected ? "#E02020" : "#888888" }}>
                      {option.icon}
                    </span>
                    <span className="flex-1 text-sm leading-snug" style={{ color: "#FFFFFF" }}>
                      {option.label}
                    </span>
                    <span
                      className="shrink-0 w-5 h-5 rounded-full flex items-center justify-center"
                      style={{
                        backgroundColor: isSelected ? "#E02020" : "transparent",
                        border: `2px solid ${isSelected ? "#E02020" : "#555555"}`,
                      }}
                    >
                      {isSelected && (
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                          <path d="M2 5l2.5 2.5L8 3" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </span>
                  </button>
                );
              })}

              <input
                value={custom}
                onChange={(e) => { handleCustomChange(e); if (e.target.value) setChallengeOpen(false); }}
                type="text"
                placeholder="Something else? Tell us in your own words…"
                className="w-full rounded-lg px-4 py-3 text-sm focus:outline-none"
                style={{
                  backgroundColor: "#222222",
                  border: `1px solid ${custom ? "#E02020" : "#333333"}`,
                  color: "#FFFFFF",
                }}
              />
            </div>
          )}

          {/* Terms */}
          <p className="text-xs text-center leading-relaxed" style={{ color: "#555555" }}>
            By continuing, you agree to our{" "}
            <Link href="/terms" className="underline transition-colors hover:text-white" style={{ color: "#888888" }}>
              Terms of Service
            </Link>{" "}
            and{" "}
            <Link href="/privacy" className="underline transition-colors hover:text-white" style={{ color: "#888888" }}>
              Privacy Policy
            </Link>
            .
          </p>

          {error && (
            <p className="text-sm text-center" style={{ color: "#E02020" }}>{error}</p>
          )}

          {/* CTA */}
          <button
            type="submit"
            disabled={!ready || loading}
            className="w-full flex items-center justify-center gap-2 rounded-lg px-6 py-3.5 text-sm font-semibold text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ backgroundColor: "#E02020" }}
            onMouseEnter={e => { if (ready && !loading) e.currentTarget.style.backgroundColor = "#B91C1C"; }}
            onMouseLeave={e => { e.currentTarget.style.backgroundColor = "#E02020"; }}
          >
            {loading ? "Sending…" : "I’m ready to get started"}
            {!loading && (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
