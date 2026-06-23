"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function SignupPage() {
  const router = useRouter();
  const [form, setForm] = useState({ phone: "", firstName: "", lastName: "" });

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    setForm({ ...form, [e.target.name]: e.target.value });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    router.push("/signup/gym");
  }

  const ready = form.phone && form.firstName && form.lastName;

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
          {/* Phone number */}
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

          {/* CTA */}
          <button
            type="submit"
            disabled={!ready}
            className="w-full flex items-center justify-center gap-2 rounded-lg px-6 py-3.5 text-sm font-semibold text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ backgroundColor: "#E02020" }}
            onMouseEnter={e => { if (ready) e.currentTarget.style.backgroundColor = "#B91C1C"; }}
            onMouseLeave={e => { e.currentTarget.style.backgroundColor = "#E02020"; }}
          >
            I&apos;m ready to get started
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </form>
      </div>
    </div>
  );
}
