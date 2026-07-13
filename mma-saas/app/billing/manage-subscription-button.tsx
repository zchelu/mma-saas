"use client";

import { useState } from "react";

export default function ManageSubscriptionButton() {
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    setLoading(true);
    try {
      const res = await fetch("/api/stripe/portal", { method: "POST" });
      const data = await res.json() as { url?: string; error?: string };
      if (data.url) window.location.href = data.url;
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleClick}
      disabled={loading}
      className="rounded-lg text-sm font-semibold px-4 py-2 transition-opacity disabled:opacity-60"
      style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
    >
      {loading ? "Opening…" : "Manage subscription"}
    </button>
  );
}
