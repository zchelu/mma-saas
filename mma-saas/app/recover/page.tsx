"use client";

import { useState } from "react";

const GENERIC_ERROR = "Something went wrong — please try again or contact us.";

export default function RecoverPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("loading");
    setError(null);

    try {
      const res = await fetch("/api/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? GENERIC_ERROR);
        setStatus("idle");
        return;
      }
      setStatus("done");
    } catch {
      setError(GENERIC_ERROR);
      setStatus("idle");
    }
  }

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center text-center px-6"
      style={{ backgroundColor: "#0D0D0D" }}
    >
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-bold mb-2" style={{ color: "#FFFFFF" }}>
          Recover your purchase
        </h1>

        {status === "done" ? (
          <p className="text-sm mt-4" style={{ color: "#AAAAAA" }}>
            If that email has a purchase on file, we&apos;ve sent a link to finish setting up your account.
          </p>
        ) : (
          <>
            <p className="text-sm mb-6" style={{ color: "#888888" }}>
              Already paid but never finished creating your account? Enter the email you paid with and
              we&apos;ll send you a link to pick up where you left off.
            </p>
            <form onSubmit={handleSubmit} className="flex flex-col gap-3">
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@yourgym.com"
                className="rounded-lg px-4 py-3 text-sm outline-none"
                style={{ backgroundColor: "#1A1A1A", border: "1px solid #333333", color: "#FFFFFF" }}
              />
              {error && (
                <p className="text-sm" style={{ color: "#FF6B6B" }}>
                  {error}
                </p>
              )}
              <button
                type="submit"
                disabled={status === "loading"}
                className="rounded-lg font-semibold px-6 py-3 text-sm transition-opacity disabled:opacity-60"
                style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
              >
                {status === "loading" ? "Sending…" : "Send recovery link"}
              </button>
            </form>
          </>
        )}

        <a href="/pricing" className="text-sm underline mt-6 inline-block" style={{ color: "#888888" }}>
          Back to pricing
        </a>
      </div>
    </div>
  );
}
