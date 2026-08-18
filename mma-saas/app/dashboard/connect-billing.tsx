"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { loadConnectAndInitialize } from "@stripe/connect-js";
import type { AppearanceOptions, StripeConnectInstance } from "@stripe/connect-js";
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

// Stripe's embedded components render in their own iframes and default to a
// LIGHT theme, which puts dark-grey text on our #222222 card. "Add information
// to start accepting money" — the single most important sentence on this card —
// came out close to unreadable. `appearance` is the only way in: we cannot style
// across the iframe boundary with CSS.
//
// EVERY VALUE BELOW IS COPIED FROM SOMETHING THAT ALREADY EXISTS. Nothing here
// is a new colour. Sources:
//   #222222  this card's own backgroundColor, and .input in app/globals.css
//   #1A1A1A  inset surfaces — the timezone input and status pill in this file
//   #333333  the card border, .input border, secondary button border
//   #FFFFFF  primary text
//   #8A8A8A  secondary/muted text — see the contrast note below
//   #FF4D4D  .legal-content a:hover in app/globals.css
//   #CCCCCC  secondary button text in this file
//   #E02020  brand red — the primary button here and the .input focus ring
//   #F87171 / #4ADE80 / #FBBF24  the danger/success/warning already used on the
//            dashboard panels
//   Arial, Helvetica, sans-serif — the body font in app/globals.css (NOT the
//            Geist variables, which that stylesheet defines but body overrides)
//   8px      rounded-lg, what every button and input in this card uses
//
// Buttons are themed as well as text, deliberately: Stripe's default blue CTA
// against a red-accented dark card reads as pasted on rather than part of the
// product, which is the impression this whole card exists to avoid.
//
// THREE VALUES ARE DELIBERATELY NOT COPIES, because the originals fail WCAG AA
// (4.5:1 for normal-size text) against these backgrounds. Measured, not guessed:
//   colorSecondaryText        #888888 on #222222 = 4.49:1 -> #8A8A8A = 4.61:1
//   actionPrimaryColorText    #E02020 on #222222 = 3.33:1 -> #FF4D4D = 4.86:1
//   formPlaceholderTextColor  #555555 on #1A1A1A = 2.33:1 -> #8A8A8A = 5.04:1
// actionPrimary mattered most: Stripe styles every "Learn more" and "Why do we
// need this?" link in onboarding with it, so #E02020 was the same illegibility
// bug this block exists to fix, one element over. The placeholder one is the
// same defect that still ships in .input::placeholder (#555555 on #222222 =
// 2.13:1) — NOT fixed there — and Stripe's KYC placeholders carry format hints
// (SSN, routing number, DOB) an owner has to be able to read.
//
// THE TYPE ANNOTATION IS LOAD-BEARING — do not drop it. Every variable here is
// optional, and TypeScript's excess-property check only applies to inline object
// literals. Assigned to a named const without the annotation, a mistyped
// variable name compiles clean and is then silently ignored by Stripe, leaving
// exactly the unreadable-text bug this block exists to fix. Confirmed both ways:
// a bogus `colorTotallyMadeUp` drew no error before the annotation and a TS2353
// after it.
const CONNECT_APPEARANCE: AppearanceOptions = {
  variables: {
    fontFamily: "Arial, Helvetica, sans-serif",
    fontSizeBase: "14px",
    borderRadius: "8px",

    colorBackground: "#222222",
    colorText: "#FFFFFF",
    colorSecondaryText: "#8A8A8A",
    colorBorder: "#333333",
    colorPrimary: "#E02020",
    colorDanger: "#F87171",

    // Surfaces Stripe insets against the base — matched to the pattern this
    // card already uses, where nested elements go darker rather than lighter.
    offsetBackgroundColor: "#1A1A1A",
    formBackgroundColor: "#1A1A1A",
    formBorderRadius: "8px",
    formPlaceholderTextColor: "#8A8A8A",
    formHighlightColorBorder: "#E02020",
    formAccentColor: "#E02020",

    buttonPrimaryColorBackground: "#E02020",
    buttonPrimaryColorBorder: "#E02020",
    buttonPrimaryColorText: "#FFFFFF",
    buttonSecondaryColorBackground: "#1A1A1A",
    buttonSecondaryColorBorder: "#333333",
    buttonSecondaryColorText: "#CCCCCC",

    // Outlined, NOT filled. colorPrimary is already brand red, so a filled red
    // danger button is indistinguishable from the primary CTA beside it — and in
    // ConnectAccountManagement the destructive action (remove a bank account)
    // must not look like the thing you are meant to click.
    buttonDangerColorBackground: "#1A1A1A",
    buttonDangerColorBorder: "#F87171",
    buttonDangerColorText: "#F87171",

    actionPrimaryColorText: "#FF4D4D",
    actionSecondaryColorText: "#8A8A8A",

    // Same shape as StatusPill below: dark chip, coloured label, quiet border.
    badgeNeutralColorBackground: "#1A1A1A",
    badgeNeutralColorText: "#8A8A8A",
    badgeNeutralColorBorder: "#333333",
    badgeSuccessColorBackground: "#1A1A1A",
    badgeSuccessColorText: "#4ADE80",
    badgeSuccessColorBorder: "#333333",
    badgeWarningColorBackground: "#1A1A1A",
    badgeWarningColorText: "#FBBF24",
    badgeWarningColorBorder: "#333333",
    badgeDangerColorBackground: "#1A1A1A",
    badgeDangerColorText: "#F87171",
    badgeDangerColorBorder: "#333333",
  },
};

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
    try {
      const { clientSecret } = await createSession({});
      return clientSecret;
    } catch (err) {
      // connect-js calls this EAGERLY and synchronously inside
      // loadConnectAndInitialize — before Stripe's script even loads — and keeps
      // the resulting promise to itself (initStripeConnect's
      // eagerClientSecretPromise). It never hands the rejection back, so without
      // this catch the likeliest failure in this card reached the owner as an
      // empty panel and a console warning. Re-thrown so connect-js still learns
      // the mint failed.
      setError(errorText(err, "Couldn't start member billing setup. Try again in a moment."));
      throw err;
    }
  }, [createSession]);

  // Built once, lazily, and only when the owner actually opens the panel — this
  // loads Stripe's script and mints a session, neither of which should happen on
  // every dashboard render for gyms that will never click it.
  const instance = useMemo(() => {
    if (!open || !publishableKey) return null;
    return loadConnectAndInitialize({
      publishableKey,
      fetchClientSecret,
      appearance: CONNECT_APPEARANCE,
    });
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

      {/* OUTSIDE the !open guard on purpose. The account session is minted the
          instant the panel opens, so the likeliest error in this card happens
          while open === true, and rendering this inside the !open block made
          exactly that error unrenderable. */}
      {error && (
        <p className="text-xs mb-3 leading-relaxed" style={{ color: "#FF6B6B" }}>
          {error}
        </p>
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
