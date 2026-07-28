"use client";

import { useRef, useState } from "react";
import { submitConsentAction } from "./actions";

const inputStyle = {
  backgroundColor: "#222222",
  border: "1px solid #333333",
  color: "#FFFFFF",
};

// The submit button is enabled at ALL times and the consent checkbox starts
// UNCHECKED, by Twilio compliance requirement (2026-07-28): a submit control
// that is inert until the consent box is ticked is classified as "forced
// consent" and fails review. The checkbox therefore carries no `required`
// attribute either — `required` blocks submission just as effectively as a
// disabled button and would fail the same check.
//
// That makes this the only reason the form needs to be a Client Component:
// with the button always live, an unchecked submit must be intercepted BEFORE
// anything leaves the browser. consentSubmissions is our TCPA evidence table,
// so a row must never exist for someone who did not tick the box. Everything
// else on this page (heading, banner, disclosure, success state) stays a
// Server Component, and the consented path is untouched — same
// submitConsentAction, same redirect-based result.
//
// The `action` prop stays bound unconditionally so the no-JS path still
// renders a real POST target. Without it React would emit a plain <form> with
// no action/method, and a no-JS submit would GET the current URL with the
// member's name and phone number in the query string. The no-JS unchecked
// case is handled server-side instead — actions.ts returns ?status=declined
// without calling submitConsent.
export function ConsentForm({
  gymSlug,
  consentText,
  disclosure,
  initialDeclined = false,
}: {
  gymSlug: string;
  consentText: string;
  disclosure: React.ReactNode;
  // Set by page.tsx from ?status=declined — the no-JS unchecked submit, which
  // round-trips through actions.ts and comes back here so both paths show the
  // same notice.
  initialDeclined?: boolean;
}) {
  const [declined, setDeclined] = useState(initialDeclined);
  const consentRef = useRef<HTMLInputElement>(null);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    // Native validation on the name/phone inputs runs before this event
    // fires, so an incomplete form never reaches either branch — field
    // validation is deliberately unchanged, Twilio's objection was only to
    // the consent checkbox.
    if (consentRef.current?.checked) {
      // Consented: fall through untouched. React dispatches
      // submitConsentAction, which writes the consentSubmissions row.
      setDeclined(false);
      return;
    }

    // Not consented: stop here. No Server Action, no Convex mutation, no
    // consentSubmissions row, no member patch — nothing but local state.
    event.preventDefault();
    setDeclined(true);
  }

  return (
    <>
      {declined && (
        <div
          className="rounded-lg p-4 mb-6"
          style={{ border: "1px solid #333333", backgroundColor: "#161616" }}
        >
          <p className="text-sm font-semibold mb-1" style={{ color: "#FFFFFF" }}>
            Thanks — we&apos;ve received your details.
          </p>
          <p className="text-sm leading-relaxed" style={{ color: "#888888" }}>
            You have not been signed up for text messages. If you&apos;d like to
            receive them, tick the consent box and submit again.
          </p>
        </div>
      )}

      <form
        action={submitConsentAction}
        onSubmit={handleSubmit}
        className="flex flex-col gap-4"
      >
        <input type="hidden" name="gymSlug" value={gymSlug} />

        <input
          name="name"
          required
          maxLength={200}
          placeholder="Full name"
          autoComplete="name"
          className="rounded-lg px-4 py-3 text-base focus:outline-none"
          style={inputStyle}
        />
        <input
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          required
          maxLength={30}
          placeholder="Phone number"
          className="rounded-lg px-4 py-3 text-base focus:outline-none"
          style={inputStyle}
        />

        <label
          className="flex items-start gap-3 rounded-lg p-4 cursor-pointer"
          style={{ border: "1px solid #333333" }}
        >
          <input
            ref={consentRef}
            type="checkbox"
            name="consent"
            value="yes"
            className="mt-0.5 w-4 h-4 shrink-0"
          />
          <span className="text-sm leading-relaxed" style={{ color: "#CCCCCC" }}>
            {consentText}
          </span>
        </label>

        {disclosure}

        <button
          type="submit"
          className="mt-2 rounded-lg font-semibold px-6 py-3 text-sm"
          style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
        >
          Submit
        </button>
      </form>
    </>
  );
}
