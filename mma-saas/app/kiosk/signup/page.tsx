"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import WaiverStep from "../../components/waiver-step";
import { getErrorMessage } from "../../components/error-toast";
import { useIsHydrated } from "../../components/use-hydrated";
import { getConsentText } from "@/lib/consentText";

// New-member signup on the front-desk tablet — the other half of the kiosk,
// alongside /checkin. Public and unauthenticated by design: it runs on a
// device at the door with no Clerk session, exactly like /checkin, and
// authenticates itself with the gym's kiosk token from the URL the same way.
//
// Bookmark this device to /kiosk/signup?k=<kioskToken>. The dashboard's owner
// links panel is where an owner gets that URL, and where they regenerate the
// token if the tablet goes missing. The token — never a gym id — is what the
// server resolves; see convex/gyms.ts:tryGetKioskGym.
//
// The flow is deliberately three screens, not one long form: details, then
// the waiver, then a confirmation that resets the tablet for the next person.
// A member who walks away halfway leaves a roster row with no signature,
// which the /members screen surfaces — that is the correct failure, and much
// better than losing the person entirely because the form was too long.

export default function KioskSignupPage() {
  return (
    <Suspense fallback={null}>
      <KioskSignupInner />
    </Suspense>
  );
}

// Shape gate on the kiosk token in the URL, so a malformed bookmark fails soft
// here instead of as a server-side ArgumentValidationError that crashes the
// tablet. 24 hex characters — see convex/gyms.ts:generateKioskToken.
const KIOSK_TOKEN_SHAPE = /^[a-f0-9]{24}$/;

type Stage =
  | { type: "form" }
  | { type: "waiver"; memberId: Id<"members">; firstName: string }
  | { type: "done"; firstName: string };

function KioskSignupInner() {
  const searchParams = useSearchParams();
  const rawToken = searchParams.get("k");
  const kioskToken = rawToken && KIOSK_TOKEN_SHAPE.test(rawToken) ? rawToken : null;

  const gym = useQuery(
    api.documents.getKioskGym,
    kioskToken ? { kioskToken } : "skip"
  );
  const createMember = useMutation(api.documents.createMemberFromKiosk);
  // See use-hydrated.ts. Until React is live this form is plain HTML and its
  // button performs a native GET submit that strips the kiosk token out of
  // the URL.
  const hydrated = useIsHydrated();

  const [stage, setStage] = useState<Stage>({ type: "form" });
  const [name, setName] = useState("");
  const [dob, setDob] = useState("");
  const [address, setAddress] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [smsConsent, setSmsConsent] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stable across renders — every call inside it is a React setter, so it can
  // sit in the auto-reset effect's dependency list without restarting the
  // timer on every render.
  const resetForm = useCallback(() => {
    setName("");
    setDob("");
    setAddress("");
    setEmail("");
    setPhone("");
    setSmsConsent(false);
    setSaving(false);
    setError(null);
    setStage({ type: "form" });
  }, []);

  // Auto-reset back to a blank form after the confirmation, so the tablet is
  // ready for the next person and the previous member's details aren't left on
  // screen for whoever picks it up. Twice the check-in kiosk's 2.5s — there's
  // more to read here.
  useEffect(() => {
    if (stage.type !== "done") return;
    const t = setTimeout(resetForm, 5000);
    return () => clearTimeout(t);
  }, [stage, resetForm]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!kioskToken) return;
    setSaving(true);
    setError(null);
    try {
      const memberId = await createMember({
        kioskToken,
        name,
        dob,
        address: address.trim() || undefined,
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        smsConsent,
      });
      setStage({
        type: "waiver",
        memberId,
        firstName: name.trim().split(/\s+/)[0],
      });
    } catch (err) {
      setError(getErrorMessage(err, "Couldn't save that — check the connection and try again."));
      setSaving(false);
    }
  }

  // `null` means the gym exists but has no name yet, or the id is wrong. The
  // form must not render either way: the SMS consent sentence interpolates the
  // gym name, and convex/documents.ts stores that exact sentence as evidence —
  // showing a placeholder name would put different text on the tablet than on
  // the record. `undefined` is just the query loading.
  if (!kioskToken || gym === null) {
    return (
      <Shell>
        <h1 className="text-3xl font-bold mb-3" style={{ color: "#FFFFFF" }}>
          Kiosk not configured
        </h1>
        <p className="text-lg max-w-md" style={{ color: "#888888" }}>
          This signup page has no valid kiosk link. Get the current one from your
          dashboard under &ldquo;Your gym&apos;s links&rdquo; and bookmark this device to it —
          an old link stops working once the kiosk code is regenerated.
        </p>
      </Shell>
    );
  }

  if (stage.type === "waiver") {
    return (
      <WaiverStep
        kioskToken={kioskToken}
        memberId={stage.memberId}
        cancelLabel="Finish later"
        // Signup is where a gym collects EVERYTHING — the waiver plus any
        // photo release or rental agreement. The check-in gate deliberately
        // does not; see convex/documents.ts:isRequired.
        includeOptional
        onDone={() => setStage({ type: "done", firstName: stage.firstName })}
        // Backing out leaves the member on the roster with an unsigned waiver.
        // They'll be stopped at check-in next time — which is the point of the
        // gate, and better than discarding a person who is standing right there.
        onCancel={() => setStage({ type: "done", firstName: stage.firstName })}
      />
    );
  }

  if (stage.type === "done") {
    return (
      <Shell>
        <div
          className="w-28 h-28 rounded-full flex items-center justify-center mb-8"
          style={{ backgroundColor: "rgba(74,222,128,0.1)" }}
        >
          <svg
            className="w-14 h-14"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2.5}
            style={{ color: "#4ADE80" }}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h1 className="text-6xl font-extrabold mb-4 tracking-tight" style={{ color: "#FFFFFF" }}>
          Welcome, {stage.firstName}!
        </h1>
        <p className="text-2xl mb-10" style={{ color: "#888888" }}>
          You&apos;re all set. See you on the mats.
        </p>
        <button
          type="button"
          onClick={resetForm}
          className="rounded-xl px-8 py-4 text-lg font-semibold"
          style={{ backgroundColor: "#222222", border: "1px solid #333333", color: "#FFFFFF" }}
        >
          Sign up someone else
        </button>
      </Shell>
    );
  }

  // gym === null is handled above and gym === undefined only means the query
  // is still in flight, so the phone/consent block below is gated on having a
  // real name rather than substituting one.
  const consentText = gym ? getConsentText(gym.name) : null;

  return (
    <div className="min-h-screen" style={{ backgroundColor: "#0D0D0D" }}>
      <div className="max-w-2xl mx-auto px-6 pt-16 pb-14">
        <div className="text-center mb-12">
          <p
            className="text-sm font-semibold uppercase tracking-widest mb-3"
            style={{ color: "#E02020" }}
          >
            {gym?.name ?? "KombatDesk"}
          </p>
          <h1 className="text-5xl font-extrabold tracking-tight" style={{ color: "#FFFFFF" }}>
            New member
          </h1>
          <p className="text-lg mt-3" style={{ color: "#888888" }}>
            Takes about a minute. You&apos;ll sign the waiver on the next screen.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-6">
          {/* FAIL-SAFE, not decoration. If a native submit ever does slip
              through (this form is plain HTML until React hydrates), the
              browser rebuilds the URL from the named fields — and this is the
              only named field, so the gym id round-trips instead of being
              erased. Without it the page lands on `/kiosk/signup?` and
              honestly reports "Kiosk not configured", which is what happened
              on a real iPad. The submit button below is gated on hydration so
              this should never fire; it is here for the case where that is
              somehow not enough. */}
          <input type="hidden" name="k" value={kioskToken} />
          <Field label="Full name" required>
            <input
              required
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Maya Ortiz"
              className="input"
              style={{ fontSize: "1.35rem", padding: "1rem 1.1rem" }}
            />
          </Field>

          {/* Required, not optional. The waiver step cannot decide whether a
              guardian must sign without it, and a martial arts gym signs up
              children constantly. */}
          <Field label="Date of birth" required>
            <input
              required
              type="date"
              value={dob}
              onChange={(e) => setDob(e.target.value)}
              className="input"
              style={{ fontSize: "1.35rem", padding: "1rem 1.1rem" }}
            />
          </Field>

          {/* Required exactly when this gym's documents print it — see
              getKioskGym's collectsAddress. Asking for it here, once, is the
              whole point: the waiver step would otherwise stop the signer on
              the next screen to demand a field this one called optional. */}
          <Field label="Address" required={gym?.collectsAddress === true}>
            <input
              required={gym?.collectsAddress === true}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="1200 N Nevada Ave, Colorado Springs, CO"
              className="input"
              style={{ fontSize: "1.35rem", padding: "1rem 1.1rem" }}
            />
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <Field label="Email">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="maya@email.com"
                className="input"
                style={{ fontSize: "1.35rem", padding: "1rem 1.1rem" }}
              />
            </Field>
            <Field label="Mobile number">
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="(720) 555-0100"
                className="input"
                style={{ fontSize: "1.35rem", padding: "1rem 1.1rem" }}
              />
            </Field>
          </div>

          {/* THE CONSENT CHECKBOX IS COMPLIANCE SURFACE, NOT COPY. The label
              is lib/consentText.ts verbatim — the same string
              convex/consent.ts freezes onto the evidence row and the same one
              five other places must stay byte-identical with (see AGENTS.md
              §4). Do not paraphrase it, shorten it, or move the opt-out
              sentence out of it.

              Unticked is a valid outcome, and it is NOT a validation error:
              convex/documents.ts:createMemberFromKiosk simply stores no phone
              number in that case. A number saved without consent can never be
              lawfully texted, so keeping it would create a row that looks
              reachable and isn't. */}
          {phone.trim().length > 0 && consentText && (
            <label
              className="flex items-start gap-3 rounded-2xl p-5 cursor-pointer"
              style={{ backgroundColor: "#1A1A1A", border: "1px solid #333333" }}
            >
              <input
                type="checkbox"
                checked={smsConsent}
                onChange={(e) => setSmsConsent(e.target.checked)}
                className="mt-1 shrink-0 w-6 h-6"
                style={{ accentColor: "#E02020" }}
              />
              <span className="text-base leading-relaxed" style={{ color: "#CCCCCC" }}>
                {consentText}
              </span>
            </label>
          )}
          {phone.trim().length > 0 && consentText && (
            <>
              {/* Carriers cross-check the opt-in disclosure against the linked
                  legal documents — lib/consentText.ts spells out which five
                  places the frequency sentence has to match. Every other
                  opt-in surface in this product puts /terms and /privacy one
                  click away; this one has to as well. */}
              <p className="text-sm -mt-3" style={{ color: "#888888" }}>
                See our{" "}
                <a
                  href="/terms#sms"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                  style={{ color: "#CCCCCC" }}
                >
                  Terms of Service
                </a>{" "}
                and{" "}
                <a
                  href="/privacy"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                  style={{ color: "#CCCCCC" }}
                >
                  Privacy Policy
                </a>
                .{!smsConsent && " Leave the box unticked and we simply won't save the number."}
              </p>
            </>
          )}

          {error && (
            <p
              className="text-base px-4 py-3 rounded-xl"
              style={{ backgroundColor: "#2A0A0A", border: "1px solid #F87171", color: "#F87171" }}
            >
              {error}
            </p>
          )}

          {/* Disabled until React is live. A tap that beats hydration would
              otherwise take the native path and wipe the gym id from the URL —
              the form the member just filled in vanishes and the screen says
              the kiosk isn't configured. The window is a few hundred
              milliseconds; the label says what's happening rather than sitting
              there dead. */}
          <button
            type="submit"
            disabled={saving || !hydrated}
            className="w-full rounded-2xl text-2xl font-bold py-6 mt-2 transition-all active:scale-[0.99] disabled:opacity-50"
            style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
          >
            {!hydrated ? "Starting up…" : saving ? "Saving…" : "Continue to the waiver"}
          </button>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm uppercase tracking-widest" style={{ color: "#888888" }}>
        {label}
        {!required && <span style={{ color: "#555555" }}> · optional</span>}
      </label>
      {children}
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center text-center px-8"
      style={{ backgroundColor: "#0D0D0D" }}
    >
      {children}
    </div>
  );
}
