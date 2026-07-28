"use client";
import { useEffect } from "react";

// Route-level error boundary for /dashboard. Without this, a single throwing
// Convex query inside any "use client" child (StatsGrid, AtRiskPanel,
// WinbackPanel) takes down the entire route — which is exactly how
// consent.getConsentStats crashed production. The per-query fix (tryGetGym)
// stops the known case; this stops the whole class of them.
//
// Production redacts plain Error messages to a generic "Server Error", so
// error.message is usually not worth showing. The digest is what's actually
// searchable in the Convex/Vercel logs, so surface that instead when present.
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Dashboard route error:", error);
  }, [error]);

  return (
    <div className="min-h-screen" style={{ backgroundColor: "#0D0D0D" }}>
      <main className="max-w-5xl mx-auto px-8 py-16">
        <div
          className="rounded-xl p-8"
          style={{ border: "1px solid #E02020", backgroundColor: "#1A1A1A" }}
        >
          <h1 className="text-2xl mb-3" style={{ color: "#FFFFFF", fontWeight: 500 }}>
            Something went wrong loading your dashboard
          </h1>
          <p className="mb-6" style={{ color: "#888888" }}>
            Your data is safe — this is a display problem, not a data problem.
            Try again, and if it keeps happening the reference below will help
            us track it down.
          </p>
          <div className="flex items-center gap-4">
            <button
              onClick={reset}
              className="rounded-lg px-5 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90"
              style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
            >
              Try again
            </button>
            {error.digest && (
              <span className="text-xs font-mono" style={{ color: "#555555" }}>
                Reference: {error.digest}
              </span>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
