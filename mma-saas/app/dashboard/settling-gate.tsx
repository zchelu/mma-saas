"use client";

import { useEffect, useRef, useState } from "react";
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
export default function SettlingGate({ awaitingCheckout = false }: { awaitingCheckout?: boolean }) {
  const subscription = useQuery(api.subscriptions.getSubscription);
  const router = useRouter();
  const refreshed = useRef(false);
  const [stranded, setStranded] = useState(false);

  const isActive = !!(
    subscription?.plan &&
    (subscription.planStatus === "active" || subscription.planStatus === "trialing")
  );
  // awaitingCheckout (set when this instant's dashboard load followed a
  // Stripe redirect via the auth-first flow — see app/dashboard/page.tsx)
  // means stripeCustomerId is genuinely expected to be missing for a beat:
  // nothing synchronously claimed the subscription the way /welcome's
  // claimGymBySessionId does for the old guest-checkout path, so this
  // request can land here before the customer.subscription.created webhook
  // has even fired. Treat it as "known to be settling" instead of "never
  // checked out", or a real paying customer gets bounced to /pricing on
  // every single auth-first purchase — the exact bug /welcome's synchronous
  // claim was built to avoid, just via a different code path this time.
  const hasBilling = !!subscription?.stripeCustomerId || awaitingCheckout;

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
      // THE LOOP ENDED HERE. This branch used to send everyone to /pricing, and
      // for awaitingCheckout that meant a buyer Stripe had just accepted was
      // dropped back at the top of the funnel with no message — they re-entered
      // the wizard, checked out again, and landed here again. Silent, repeatable,
      // and it burned a founding coupon slot on every lap.
      //
      // /pricing is still right for the non-checkout case: no stripeCustomerId
      // and no checkout in flight genuinely means this person never bought
      // anything, and the pricing page is where they should be.
      if (awaitingCheckout) {
        setStranded(true);
        return;
      }
      window.location.href = "/pricing";
    }, MAX_WAIT_MS);
    return () => clearTimeout(timer);
  }, [subscription, isActive, hasBilling, awaitingCheckout, router]);

  // Deliberately says "checkout completed", not "payment went through": every
  // plan starts on a TRIAL_DAYS trial, so nothing has actually been charged
  // today and telling them it has would be a false statement about billing.
  if (stranded) {
    return (
      <div
        className="min-h-screen flex flex-col items-center justify-center text-center px-6"
        style={{ backgroundColor: "#0D0D0D" }}
      >
        <p className="text-2xl font-bold mb-3" style={{ color: "#FFFFFF" }}>
          Your checkout went through — your account didn&apos;t finish setting up
        </p>
        <p className="text-sm mb-6 max-w-md" style={{ color: "#888888" }}>
          Stripe has your subscription. Something on my end didn&apos;t finish, and
          I&apos;ve already been alerted. Don&apos;t check out again — it would
          start a second subscription.
        </p>
        <div className="flex items-center gap-3">
          <a
            href="/recover"
            className="rounded-lg font-semibold px-6 py-3 text-sm"
            style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
          >
            Recover my purchase
          </a>
          <a
            href="/dashboard"
            className="rounded-lg font-semibold px-6 py-3 text-sm"
            style={{ border: "1px solid #333333", color: "#FFFFFF" }}
          >
            Try again
          </a>
        </div>
        <p className="text-sm mt-6" style={{ color: "#888888" }}>
          Or email{" "}
          <a className="underline" href="mailto:kombatdesk@outlook.com" style={{ color: "#AAAAAA" }}>
            kombatdesk@outlook.com
          </a>{" "}
          and I&apos;ll sort it out.
        </p>
      </div>
    );
  }

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
