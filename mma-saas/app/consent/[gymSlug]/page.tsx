import { notFound } from "next/navigation";
import { fetchQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { getConsentText } from "@/lib/consentText";
import { ConsentForm } from "./ConsentForm";

// Shown on both the form and the success state. This is the only KombatDesk
// surface a gym member ever sees, and it previously named neither KombatDesk
// nor the evidence captured at submission (IP + user agent — see actions.ts,
// disclosed in Privacy §2/§4). Rendered as its own line rather than folded
// into the checkbox label on purpose: that label comes from
// lib/consentText.ts and is frozen onto each consentSubmissions row, so
// editing it without bumping CONSENT_VERSION would desync stored evidence
// from the wording actually agreed to.
function ConsentDisclosure({ gymName }: { gymName: string }) {
  return (
    <p className="text-xs leading-relaxed" style={{ color: "#888888" }}>
      {/* The space after {gymName} must be an explicit {" "} expression: the
          JSX text that follows it spans multiple lines, and the compiler strips
          that chunk's leading whitespace while collapsing the line break —
          which shipped "…the software Colorado Springs BJJuses to manage…" to
          production. A literal space in the source is not enough here. */}
      Texts are sent by KombatDesk, the software {gymName}{" "}
      uses to manage its membership, on the gym&apos;s behalf. Your name, phone
      number, IP address, and browser are recorded as proof of consent. See our{" "}
      <a href="/privacy" className="underline" style={{ color: "#AAAAAA" }}>
        Privacy Policy
      </a>{" "}
      and{" "}
      {/* "Terms of Service", not "Terms" — Twilio's required disclosure names
          it that way and a compliance reviewer string-matches the label. Href
          is unchanged. */}
      <a href="/terms" className="underline" style={{ color: "#AAAAAA" }}>
        Terms of Service
      </a>
      .
    </p>
  );
}

export default async function ConsentPage({
  params,
  searchParams,
}: {
  params: Promise<{ gymSlug: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const { gymSlug } = await params;
  const { status } = await searchParams;

  const gym = await fetchQuery(api.gyms.getBySlug, { slug: gymSlug });

  if (!gym) notFound();

  if (status === "ok") {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center text-center px-8" style={{ backgroundColor: "#0D0D0D" }}>
        <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6" style={{ backgroundColor: "rgba(74,222,128,0.1)" }}>
          <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} style={{ color: "#4ADE80" }}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h1 className="text-3xl font-extrabold mb-3 tracking-tight" style={{ color: "#FFFFFF" }}>You&apos;re all set</h1>
        <p className="text-base max-w-sm" style={{ color: "#888888" }}>
          Thanks — {gym.name} can now text you about your membership.
        </p>
        <div className="max-w-sm mt-8">
          <ConsentDisclosure gymName={gym.name} />
        </div>
      </div>
    );
  }

  const banner =
    status === "rate_limited"
      ? "Too many attempts from this device. Try again in a few minutes."
      : status === "invalid"
      ? "Enter your name and phone number to continue."
      : status === "error"
      ? "Something went wrong. Please try again."
      : null;

  return (
    <div className="min-h-screen text-white" style={{ backgroundColor: "#0D0D0D" }}>
      <div className="max-w-md mx-auto px-6 pt-16 pb-10">
        <h1 className="text-3xl font-extrabold tracking-tight text-center mb-2" style={{ color: "#FFFFFF" }}>
          {gym.name}
        </h1>
        <p className="text-sm font-semibold uppercase tracking-widest text-center mb-8" style={{ color: "#E02020" }}>
          Opt in to text updates
        </p>

        {banner && (
          <p className="text-sm mb-6 text-center" style={{ color: "#FF6B6B" }}>{banner}</p>
        )}

        <ConsentForm
          gymSlug={gymSlug}
          consentText={getConsentText(gym.name)}
          disclosure={<ConsentDisclosure gymName={gym.name} />}
          initialDeclined={status === "declined"}
        />
      </div>
    </div>
  );
}
