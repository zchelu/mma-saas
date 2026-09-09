// Stripe's success_url for setup-mode dues Checkout
// (convex/memberBillingStripe.ts:createDuesSetupLink).
//
// MEMBER-FACING. The person reading this has no KombatDesk account, so there is
// no header, no dashboard link and no sign-in prompt. It is also a plain server
// component with no Convex hooks: the page carries no session and no gym or
// member id, deliberately — everything that identifies this checkout travels in
// the session metadata Stripe hands to the webhook, not through the browser.
// That is also why the gym is not named here; the page has no way to know it.
//
// THE COPY MUST NOT CLAIM THE MEMBERSHIP IS ACTIVE. Setup mode saves the card
// and nothing more. convex/connectDuesWebhookAction.ts creates the subscription
// when Stripe delivers `checkout.session.completed`, which is a moment or two
// later and can fail. "You're all set" here would be a promise this page is in
// no position to make.
export default function DuesSavedPage() {
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
            <path d="M5 13l4 4L19 7" stroke="#E02020" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>

        <h1 className="text-3xl font-extrabold tracking-tight mb-3" style={{ color: "#FFFFFF", fontWeight: 500 }}>
          Your card is saved.
        </h1>
        <p className="text-base leading-relaxed" style={{ color: "#888888" }}>
          Your gym takes it from here. When the first payment goes through, a receipt
          will land in your email — nothing else is needed from you.
        </p>
      </div>
    </div>
  );
}
