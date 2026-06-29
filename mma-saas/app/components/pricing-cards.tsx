"use client";

import { useState } from "react";

const STARTER_FEATURES = [
  "Member management",
  "Check-in kiosk",
  "Attendance history",
  "At-risk member dashboard",
  "Manual text trigger",
];

const PRO_FEATURES = [
  "Everything in Starter",
  "Automated daily retention texts",
  "At-risk email alerts to gym owner",
];

function PricingCard({
  title,
  price,
  features,
  priceId,
  ctaLabel,
  badge,
  highlighted,
}: {
  title: string;
  price: string;
  features: string[];
  priceId: string;
  ctaLabel: string;
  badge?: string;
  highlighted?: boolean;
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
      className="rounded-xl p-8 flex flex-col gap-6 relative"
      style={{
        backgroundColor: highlighted ? "#1A1A1A" : "#111111",
        border: `1px solid ${highlighted ? "#E02020" : "#333333"}`,
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
        <h3 className="text-lg font-semibold mb-1" style={{ color: "#FFFFFF" }}>
          {title}
        </h3>
        <div className="flex items-baseline gap-1">
          <span className="text-4xl font-extrabold" style={{ color: "#FFFFFF" }}>
            {price}
          </span>
          <span className="text-sm" style={{ color: "#888888" }}>
            /month
          </span>
        </div>
      </div>

      <ul className="flex flex-col gap-3">
        {features.map((f) => (
          <li key={f} className="flex items-start gap-2 text-sm" style={{ color: "#CCCCCC" }}>
            <span style={{ color: "#E02020", marginTop: 2, flexShrink: 0 }}>✓</span>
            {f}
          </li>
        ))}
      </ul>

      <button
        onClick={handleCheckout}
        disabled={loading}
        className="mt-auto rounded-lg font-semibold px-6 py-3 transition-opacity disabled:opacity-60 flex items-center justify-center gap-2"
        style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
      >
        {loading && (
          <span
            className="inline-block w-4 h-4 rounded-full border-2 border-white border-t-transparent animate-spin"
          />
        )}
        {ctaLabel}
      </button>
    </div>
  );
}

export default function PricingCards({
  starterPriceId,
  proPriceId,
}: {
  starterPriceId: string;
  proPriceId: string;
}) {
  return (
    <div className="flex flex-col sm:flex-row gap-6 w-full max-w-3xl mx-auto">
      <PricingCard
        title="Starter"
        price="$49"
        features={STARTER_FEATURES}
        priceId={starterPriceId}
        ctaLabel="I'm Ready to Start — $49/mo"
      />
      <PricingCard
        title="Pro"
        price="$89"
        features={PRO_FEATURES}
        priceId={proPriceId}
        ctaLabel="I'm Ready to Go Pro — $89/mo"
        badge="Most Popular"
        highlighted
      />
    </div>
  );
}
