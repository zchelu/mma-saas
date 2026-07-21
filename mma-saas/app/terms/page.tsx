import Link from "next/link";
import Script from "next/script";

// TODO: replace with the real Termly Terms & Conditions policy UUID once
// generated (Termly dashboard > Policies > Terms and Conditions > Install).
const TERMLY_TERMS_POLICY_ID = "REPLACE_WITH_TERMLY_TERMS_POLICY_ID";

export default function TermsPage() {
  return (
    <div className="min-h-screen px-6 py-12" style={{ backgroundColor: "#0D0D0D" }}>
      <div className="w-full max-w-[720px] mx-auto">
        <Link href="/" className="text-sm underline transition-colors hover:text-white" style={{ color: "#888888" }}>
          &larr; Back to KombatDesk
        </Link>

        <h1 className="text-2xl font-extrabold tracking-tight mt-6 mb-8" style={{ color: "#FFFFFF", fontWeight: 500 }}>
          Terms of Service
        </h1>

        <div
          {...({ name: "termly-embed" } as unknown as React.HTMLAttributes<HTMLDivElement>)}
          data-id={TERMLY_TERMS_POLICY_ID}
          data-type="iframe"
        />
        <Script src="https://app.termly.io/embed-policy.min.js" strategy="afterInteractive" />
      </div>
    </div>
  );
}
