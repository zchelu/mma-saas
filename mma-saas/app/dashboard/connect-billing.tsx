"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { loadConnectAndInitialize } from "@stripe/connect-js";
import type { StripeConnectInstance } from "@stripe/connect-js";
import {
  ConnectAccountManagement,
  ConnectAccountOnboarding,
  ConnectComponentsProvider,
  ConnectNotificationBanner,
} from "@stripe/react-connect-js";
import { api } from "../../convex/_generated/api";

// Stage C of Connect member billing (spec §5.1): the owner-facing surface for
// connecting a Stripe account so the gym can bill its own members.
//
// NOTHING HERE CHARGES ANYTHING, and the copy is careful not to imply it does.
// Defining plans and enrolling members are later stages, so an owner who
// finishes this flow has a merchant account and no way to use it yet. Do not
// promise more than that until stage F lands.
//
// EMBEDDED COMPONENTS, NOT A REDIRECT. Variant 7 puts Stripe on the hook for
// negative balances, and Stripe requires embedded onboarding, account management
// and the notification banner wherever it bears losses. With dashboard "none"
// the gym has no Stripe-hosted surface at all, so this card is the only place
// they can see or fix anything.
//
// PLACEMENT — deliberate, and it is two places, not one. While the gym is NOT
// connected this lives on the DASHBOARD, because an owner who never opens
// settings never connects billing; discovery has to sit where attention already
// is. Once charges are live it collapses to a line in /settings, because it
// stops being something to discover and becomes something to administer. Do not
// "simplify" that into one location — each half is wrong in the other's state.

// Convex surfaces a thrown ConvexError to the client with the payload on
// `.data`; a plain Error is redacted to "Server Error" in production, which is
// why convex/connect.ts throws ConvexError for anything an owner should read.
function errorText(err: unknown, fallback: string): string {
  if (err && typeof err === "object" && "data" in err && typeof err.data === "string") {
    return err.data;
  }
  return err instanceof Error ? err.message : fallback;
}

export default function ConnectBilling() {
  const status = useQuery(api.connect.getConnectStatus);
  const createSession = useAction(api.connectOnboarding.createConnectSession);
  const refreshStatus = useAction(api.connectOnboarding.refreshConnectStatus);
  const saveTimezone = useMutation(api.connect.setTimezone);

  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [connectInstance, setConnectInstance] = useState<StripeConnectInstance | null>(null);

  // The browser's IANA zone, read after mount rather than during render.
  // Resolving it inline would run once on the server (where it is UTC) and again
  // in the browser — both a hydration mismatch and the wrong answer. See spec §3.
  const [detectedTimezone, setDetectedTimezone] = useState<string | null>(null);
  const [timezoneDraft, setTimezoneDraft] = useState<string | null>(null);

  useEffect(() => {
    try {
      setDetectedTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || null);
    } catch {
      setDetectedTimezone(null);
    }
  }, []);

  const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;

  // fetchClientSecret is a CALLBACK, not a one-shot value: connect-js re-invokes
  // it whenever the secret expires. That is the shape difference from the old
  // redirect flow, where a single account link was minted and handed over.
  const fetchClientSecret = useCallback(async () => {
    const { clientSecret } = await createSession({});
    return clientSecret;
  }, [createSession]);

  // Built once, lazily, and only when the owner actually opens the panel — this
  // loads Stripe's script and mints a session, neither of which should happen on
  // every dashboard render for gyms that will never click it.
  const instance = useMemo(() => {
    if (!open || !publishableKey) return null;
    return loadConnectAndInitialize({ publishableKey, fetchClientSecret });
  }, [open, publishableKey, fetchClientSecret]);

  useEffect(() => {
    setConnectInstance(instance);
  }, [instance]);

  const recheck = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      await refreshStatus({});
    } catch (err) {
      setError(errorText(err, "Couldn't check your billing status. Reload to try again."));
    } finally {
      setChecking(false);
    }
  }, [refreshStatus]);

  if (status === undefined || status === null) return null;

  const timezone = timezoneDraft ?? status.timezone ?? detectedTimezone ?? "";

  async function openPanel() {
    setError(null);
    try {
      // Saved BEFORE the panel opens on purpose: an owner who abandons Stripe's
      // flow still leaves their timezone recorded instead of losing it with the
      // rest of the attempt.
      if (timezone) await saveTimezone({ timezone });
      setOpen(true);
    } catch (err) {
      setError(errorText(err, "Couldn't start member billing setup. Try again in a moment."));
    }
  }

  // The component's exit callback fires when the owner CLOSES the panel — not
  // when Stripe finishes reviewing. Re-checking here is best-effort; stage D's
  // account.updated webhook is what will actually catch a later approval. See
  // the header comment on refreshConnectStatus.
  function onPanelExit() {
    setOpen(false);
    void recheck();
  }

  return (
    <div className="rounded-xl p-6 mt-6" style={{ backgroundColor: "#222222", border: "1px solid #333333" }}>
      <div className="flex items-center gap-3 mb-1">
        <p className="text-sm font-semibold" style={{ color: "#FFFFFF" }}>
          Member billing
        </p>
        <StatusPill status={status} checking={checking} />
      </div>

      <p className="text-xs mb-5 leading-relaxed" style={{ color: "#888888" }}>
        Collect your members&apos; monthly dues by card. Stripe handles the payments and the
        payouts land in your bank account — KombatDesk adds nothing on top of Stripe&apos;s
        processing fee.
      </p>

      {!publishableKey && (
        <p className="text-xs mb-5 leading-relaxed" style={{ color: "#FF6B6B" }}>
          Member billing setup is unavailable right now. Nothing on your account has changed.
        </p>
      )}

      {!status.connected && !open && (
        <TimezoneField value={timezone} detected={detectedTimezone} onChange={setTimezoneDraft} />
      )}

      {status.connected && !status.chargesEnabled && !open && (
        <StatusExplanation status={status} />
      )}

      {status.connected && status.chargesEnabled && !status.payoutsEnabled && !open && (
        <p className="text-xs mb-5 leading-relaxed" style={{ color: "#888888" }}>
          You can take payments. Payouts to your bank aren&apos;t enabled yet — Stripe usually
          resolves this on its own once your details are verified.
        </p>
      )}

      {/* Stripe renders these inside its own iframes. The notification banner is
          what actually tells an owner what Stripe still needs, which is why our
          stored status codes are captured rather than interpreted. */}
      {connectInstance && (
        <ConnectComponentsProvider connectInstance={connectInstance}>
          <div className="mb-4">
            <ConnectNotificationBanner />
          </div>
          {status.chargesEnabled ? (
            <ConnectAccountManagement />
          ) : (
            <ConnectAccountOnboarding onExit={onPanelExit} />
          )}
          <button
            type="button"
            onClick={onPanelExit}
            className="text-xs rounded-lg px-4 py-2 mt-4"
            style={{ border: "1px solid #333333", color: "#CCCCCC" }}
          >
            Done
          </button>
        </ConnectComponentsProvider>
      )}

      {!open && (
        <div className="flex items-center gap-3 flex-wrap">
          <button
            type="button"
            onClick={openPanel}
            disabled={checking || !publishableKey}
            className="text-xs font-semibold rounded-lg px-4 py-2 disabled:opacity-40"
            style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
          >
            {!status.connected
              ? "Set up member billing"
              : status.chargesEnabled
                ? "Manage billing details"
                : "Finish setup"}
          </button>

          {status.connected && (
            <button
              type="button"
              onClick={recheck}
              disabled={checking}
              className="text-xs rounded-lg px-4 py-2 disabled:opacity-40"
              style={{ border: "1px solid #333333", color: "#CCCCCC" }}
            >
              {checking ? "Checking…" : "Refresh status"}
            </button>
          )}

          {error && (
            <span className="text-xs" style={{ color: "#FF6B6B" }}>
              {error}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// Reads the four-state status rather than the boolean, because "Stripe is still
// reviewing you" and "Stripe needs something from you" are different things to
// tell an owner and the booleans flatten both to false.
function StatusPill({
  status,
  checking,
}: {
  status: { connected: boolean; chargesEnabled: boolean; chargesStatus: string | null };
  checking: boolean;
}) {
  let label = "Not set up";
  let color = "#888888";

  if (checking) {
    label = "Checking";
  } else if (status.connected) {
    if (status.chargesEnabled) {
      label = "Live";
      color = "#4ADE80";
    } else if (status.chargesStatus === "pending") {
      label = "Stripe is reviewing";
      color = "#3B82F6";
    } else {
      label = "Setup incomplete";
      color = "#F87171";
    }
  }

  return (
    <span
      className="text-xs font-semibold px-2 py-0.5 rounded-full"
      style={{ backgroundColor: "#1A1A1A", color }}
    >
      {label}
    </span>
  );
}

// Deliberately does NOT interpret status codes. Stripe's notification_banner
// does the remediation prompting with far better copy than we could keep
// current, and their vocabulary grows. This only distinguishes "waiting on
// Stripe" from "waiting on you", which changes what we ask the owner to do next.
function StatusExplanation({ status }: { status: { chargesStatus: string | null } }) {
  if (status.chargesStatus === "pending") {
    return (
      <p className="text-xs mb-5 leading-relaxed" style={{ color: "#888888" }}>
        Stripe is reviewing what you sent. Nothing more is needed from you right now — this
        usually clears on its own.
      </p>
    );
  }
  return (
    <p className="text-xs mb-5 leading-relaxed" style={{ color: "#FF6B6B" }}>
      Stripe still needs more information before you can take payments. Open setup and it will
      tell you exactly what is missing.
    </p>
  );
}

// The gym's billing timezone. Read spec §3 before changing anything here.
//
// This is NOT the question lib/localDate.ts answers. That one is "what day is it
// where this device is standing", for attendance and the kiosk, and it is
// correct to keep deriving it from the device. This one is "what day will this
// member's card be charged", which gets server-rendered into an email for a gym
// that may not be in Colorado, with no device in the loop to borrow a clock
// from. Collecting it here is the only moment we have an owner's browser and
// their attention at the same time.
function TimezoneField({
  value,
  detected,
  onChange,
}: {
  value: string;
  detected: string | null;
  onChange: (v: string) => void;
}) {
  return (
    <div className="mb-5">
      <label className="block text-xs font-semibold mb-1" style={{ color: "#FFFFFF" }}>
        Your gym&apos;s timezone
      </label>
      <p className="text-xs mb-2 leading-relaxed" style={{ color: "#888888" }}>
        Used for the dates your members see on their receipts and renewal notices. We
        {detected ? " detected this from your browser — " : " couldn't detect this — "}
        change it if your gym is somewhere else.
      </p>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="America/Denver"
        spellCheck={false}
        className="w-full max-w-xs rounded-lg px-3 py-2 text-sm focus:outline-none"
        style={{ backgroundColor: "#1A1A1A", border: "1px solid #333333", color: "#FFFFFF" }}
      />
    </div>
  );
}
