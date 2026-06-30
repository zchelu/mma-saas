"use client";

import { useState } from "react";

const STARTER_FEATURES = [
  "Add, edit, and track every member",
  "Members check themselves in at the front desk",
  "See who's showing up and who isn't",
  "Spot members going cold — when you remember to check",
  "You hit the button to text them yourself, one batch at a time",
];

const PRO_FEATURES = [
  "Everything in Starter",
  "Automated daily retention texts",
  "At-risk email alerts to gym owner",
];

function PricingCard({
  title,
  tagline,
  price,
  features,
  priceId,
  ctaLabel,
  badge,
  highlighted,
  checkColor = "#E02020",
  guarantee,
}: {
  title: string;
  tagline?: string;
  price: string;
  features: string[];
  priceId: string;
  ctaLabel: string;
  badge?: string;
  highlighted?: boolean;
  checkColor?: string;
  guarantee?: string;
}) {
  const [loading, setLoading] = useState(false);

  async function handleCheckout() {
    setLoading(true);
    try {
      const res = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priceId }),
      });
      const data = await res.json() as { url?: string; error?: string };
      if (data.url) {
        window.location.href = data.url;
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="rounded-xl flex flex-col gap-5 relative"
      style={{
        backgroundColor: highlighted ? "#1A1A1A" : "#0D0D0D",
        border: `1px solid ${highlighted ? "#E02020" : "#2A2A2A"}`,
        padding: highlighted ? "2rem" : "1.5rem",
        flex: 1,
      }}
    >
      {badge && (
        <span
          className="absolute top-4 right-4 text-xs font-bold px-3 py-1 rounded-full"
          style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
        >
          {badge}
        </span>
      )}

      <div>
        <p
          className="text-xs uppercase tracking-widest mb-2"
          style={{ color: highlighted ? "#888888" : "#555555" }}
        >
          {title}
        </p>
        {tagline && (
          <h3
            className="text-base font-semibold mb-3 leading-snug"
            style={{ color: highlighted ? "#FFFFFF" : "#AAAAAA" }}
          >
            {tagline}
          </h3>
        )}
        <div className="flex items-baseline gap-1">
          <span
            className="font-extrabold"
            style={{
              color: "#FFFFFF",
              fontSize: highlighted ? "2.5rem" : "2rem",
            }}
          >
            {price}
          </span>
          <span className="text-sm" style={{ color: "#555555" }}>
            /month
          </span>
        </div>
      </div>

      <ul className="flex flex-col gap-3">
        {features.map((f) => (
          <li key={f} className="flex items-start gap-2 text-sm" style={{ color: highlighted ? "#CCCCCC" : "#888888" }}>
            <span style={{ color: checkColor, marginTop: 2, flexShrink: 0 }}>✓</span>
            {f}
          </li>
        ))}
      </ul>

      {guarantee && (
        <p className="text-xs text-center" style={{ color: "#555555" }}>
          {guarantee}
        </p>
      )}

      <button
        onClick={handleCheckout}
        disabled={loading}
        className="mt-auto rounded-lg font-semibold px-6 py-3 transition-opacity disabled:opacity-60 flex items-center justify-center gap-2 text-sm"
        style={{
          backgroundColor: highlighted ? "#E02020" : "#1A1A1A",
          color: highlighted ? "#FFFFFF" : "#AAAAAA",
          border: highlighted ? "none" : "1px solid #333333",
        }}
      >
        {loading && (
          <span className="inline-block w-4 h-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
        )}
        {ctaLabel}
      </button>
    </div>
  );
}

const PRO_VALUE_STACK = [
  "Everything in Starter, plus:",
  "We text every inactive member once a week, automatically — until they walk back through your door",
  "Know exactly who's about to quit before they do",
  "Get pinged the moment a member goes cold",
];

function ProCard({ priceId }: { priceId: string }) {
  const [loading, setLoading] = useState(false);

  async function handleCheckout() {
    setLoading(true);
    try {
      const res = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priceId }),
      });
      const data = await res.json() as { url?: string; error?: string };
      if (data.url) window.location.href = data.url;
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="rounded-xl flex flex-col relative overflow-hidden"
      style={{
        backgroundColor: "#0D0D0D",
        border: "1px solid #E02020",
        flex: 1,
        boxShadow: "0 0 40px rgba(224, 32, 32, 0.12)",
      }}
    >
      {/* Top badge bar */}
      <div
        className="px-8 py-2 flex items-center justify-center"
        style={{ backgroundColor: "#E02020" }}
      >
        <span className="text-xs font-bold tracking-widest uppercase" style={{ color: "#FFFFFF" }}>
          Most Popular
        </span>
      </div>

      <div className="p-8 flex flex-col gap-6">
        {/* Tier label + headline */}
        <div>
          <p className="text-xs font-semibold tracking-widest uppercase mb-3" style={{ color: "#E02020" }}>
            Pro
          </p>
          <h3 className="text-xl font-bold leading-snug mb-5" style={{ color: "#FFFFFF" }}>
            Never Lose Another Member<br />to Silent Quitting
          </h3>

          <div className="flex items-baseline gap-1">
            <span className="text-4xl font-extrabold" style={{ color: "#FFFFFF" }}>$89</span>
            <span className="text-sm" style={{ color: "#555555" }}>/month</span>
          </div>
        </div>

        {/* Value stack */}
        <ul className="flex flex-col gap-4">
          {PRO_VALUE_STACK.map((line) => (
            <li key={line} className="flex items-start gap-3 text-sm leading-snug" style={{ color: "#CCCCCC" }}>
              <span className="mt-0.5 font-bold flex-shrink-0" style={{ color: "#E02020" }}>✓</span>
              {line}
            </li>
          ))}
        </ul>

        {/* Risk reversal */}
        <div
          className="rounded-lg px-4 py-3 text-sm leading-relaxed"
          style={{ border: "1px solid #2A2A2A", backgroundColor: "#111111", color: "#777777" }}
        >
          Cancel anytime. If KombatDesk doesn&apos;t save you at least one member in 30 days,{" "}
          <span style={{ color: "#FFFFFF", fontWeight: 600 }}>it&apos;s free.</span>
        </div>

        {/* CTA */}
        <button
          onClick={handleCheckout}
          disabled={loading}
          className="rounded-lg font-bold px-6 py-4 text-base transition-opacity disabled:opacity-60 flex items-center justify-center gap-2"
          style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
        >
          {loading && (
            <span className="inline-block w-4 h-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
          )}
          I&apos;m Ready to Stop the Bleeding — $89/mo
        </button>
      </div>
    </div>
  );
}

const ELITE_VALUE_STACK = [
  "Everything in Pro, plus:",
  "Skip the line — your questions get answered first, always",
  "We set up your gym with you on a 1-on-1 call",
  "A clear monthly breakdown of who you saved and who's at risk",
  "First in line for every new feature we ship",
];

function EliteCard({ priceId }: { priceId: string }) {
  const [loading, setLoading] = useState(false);

  async function handleCheckout() {
    setLoading(true);
    try {
      const res = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priceId }),
      });
      const data = await res.json() as { url?: string; error?: string };
      if (data.url) window.location.href = data.url;
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="rounded-xl flex flex-col"
      style={{
        backgroundColor: "#0D0D0D",
        border: "1px solid #2A2A2A",
        flex: 1,
      }}
    >
      <div className="p-8 flex flex-col gap-6">
        <div>
          <p className="text-xs font-semibold tracking-widest uppercase mb-3" style={{ color: "#3B82F6" }}>
            Elite
          </p>
          <h3 className="text-xl font-bold leading-snug mb-5" style={{ color: "#FFFFFF" }}>
            For Owners Who Want Us<br />in Their Corner
          </h3>

          <div className="flex items-baseline gap-1">
            <span className="text-4xl font-extrabold" style={{ color: "#FFFFFF" }}>$149</span>
            <span className="text-sm" style={{ color: "#555555" }}>/month</span>
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <ul className="flex flex-col gap-4">
            {ELITE_VALUE_STACK.map((line) => (
              <li key={line} className="flex items-start gap-3 text-sm leading-snug" style={{ color: "#CCCCCC" }}>
                <span className="mt-0.5 font-bold flex-shrink-0" style={{ color: "#3B82F6" }}>✓</span>
                {line}
              </li>
            ))}
          </ul>
        </div>

        <button
          onClick={handleCheckout}
          disabled={loading}
          className="mt-auto rounded-lg font-bold px-6 py-4 text-base transition-opacity disabled:opacity-60 flex items-center justify-center gap-2"
          style={{ backgroundColor: "#3B82F6", color: "#FFFFFF" }}
        >
          {loading && (
            <span className="inline-block w-4 h-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
          )}
          I Want the Full Corner — $149/mo
        </button>
      </div>
    </div>
  );
}

export default function PricingCards({
  starterPriceId,
  proPriceId,
  elitePriceId,
}: {
  starterPriceId: string;
  proPriceId: string;
  elitePriceId: string;
}) {
  return (
    <div className="flex flex-col sm:flex-row gap-6 w-full mx-auto items-start">
      <PricingCard
        title="Starter"
        tagline="For Owners Who Want to Do It Themselves"
        price="$49"
        features={STARTER_FEATURES}
        priceId={starterPriceId}
        ctaLabel="I'll Start With the Basics — $49/mo"
        checkColor="#3B82F6"
      />
      <ProCard priceId={proPriceId} />
      <EliteCard priceId={elitePriceId} />
    </div>
  );
}
