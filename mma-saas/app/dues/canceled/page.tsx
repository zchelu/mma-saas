// Stripe's cancel_url for setup-mode dues Checkout
// (convex/memberBillingStripe.ts:createDuesSetupLink).
//
// MEMBER-FACING, same shell and same constraints as ../saved/page.tsx: no
// account, no header, no sign-in link, no Convex, no gym name.
//
// Reaching here means the member backed out of Stripe's page. No card was
// attached and no charge was made, so the copy says exactly that — a member who
// leaves unsure whether they were billed calls the gym.
export default function DuesCanceledPage() {
  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center px-6 text-center"
      style={{ backgroundColor: "#0D0D0D" }}
    >
      <div className="w-full max-w-md">
        <div
          className="w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-6"
          style={{ backgroundColor: "#1a0505", border: "1px solid #E02020" }}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="#E02020" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>

        <h1 className="text-3xl font-extrabold tracking-tight mb-3" style={{ color: "#FFFFFF", fontWeight: 500 }}>
          Nothing was saved.
        </h1>
        <p className="text-base leading-relaxed" style={{ color: "#888888" }}>
          No card was stored and you weren&apos;t charged. Reopen the link your gym sent
          you whenever you&apos;re ready.
        </p>
      </div>
    </div>
  );
}
