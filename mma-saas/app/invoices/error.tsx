"use client";
import { useEffect } from "react";

// Route-level error boundary — same pattern as app/dashboard/error.tsx. Without
// one, a single throwing Convex query in any "use client" child takes down the
// whole route. Production redacts plain Error messages to a generic
// "Server Error", so error.digest is the only useful handle for the logs.
export default function InvoicesError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Invoices route error:", error);
  }, [error]);

  return (
    <div className="min-h-screen" style={{ backgroundColor: "#0D0D0D" }}>
      <main className="max-w-7xl mx-auto px-8 py-16">
        <div
          className="rounded-xl p-8"
          style={{ border: "1px solid #E02020", backgroundColor: "#1A1A1A" }}
        >
          <h1 className="text-2xl mb-3" style={{ color: "#FFFFFF", fontWeight: 500 }}>
            Something went wrong loading your invoices
          </h1>
          <p className="mb-6" style={{ color: "#888888" }}>
            Your billing records are safe — this is a display problem, not a data
            problem. Try again, and if it keeps happening the reference below
            will help us track it down.
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
