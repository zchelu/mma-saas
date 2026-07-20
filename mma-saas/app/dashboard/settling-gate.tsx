"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

const MAX_WAIT_MS = 8000;

// Rendered by dashboard/page.tsx when the server-side check found the plan
// not active yet. Reactively watches the subscription via Convex's live
// query — the moment claimGymBySessionId or the webhook writes plan/
// planStatus, this updates with no polling needed. If the user genuinely
// never checked out (no stripeCustomerId at all), bounce to /pricing right
// away. If they did but it's still settling, wait up to MAX_WAIT_MS before
// giving up and sending them to /pricing.
export default function SettlingGate() {
  const subscription = useQuery(api.subscriptions.getSubscription);
  const router = useRouter();
  const refreshed = useRef(false);

  const isActive = !!(
    subscription?.plan &&
    (subscription.planStatus === "active" || subscription.planStatus === "trialing")
  );
  const hasBilling = !!subscription?.stripeCustomerId;

  useEffect(() => {
    if (subscription === undefined) return;

    if (isActive) {
      if (!refreshed.current) {
        refreshed.current = true;
        router.refresh();
      }
      return;
    }

    // Hard navigation (not router.replace) - this fires the instant the
    // reactive query resolves, right on top of the /dashboard navigation
    // that's still in flight. Stacking a second client-router transition
    // there was a likely contributor to the intermittent RSC-navigation
    // 503s (confirmed absent once accounts stop hitting this path at all -
    // see 2026-07-20 investigation). A full page load can't race the
    // in-flight client-side transition the way router.replace can.
    if (!hasBilling) {
      window.location.href = "/pricing";
      return;
    }

    const timer = setTimeout(() => {
      window.location.href = "/pricing";
    }, MAX_WAIT_MS);
    return () => clearTimeout(timer);
  }, [subscription, isActive, hasBilling, router]);

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center text-center px-6"
      style={{ backgroundColor: "#0D0D0D" }}
    >
      <span
        className="inline-block w-6 h-6 rounded-full border-2 animate-spin"
        style={{ borderColor: "#E02020", borderTopColor: "transparent" }}
      />
      <p className="mt-4 text-sm" style={{ color: "#888888" }}>
        Finalizing your account…
      </p>
    </div>
  );
}
