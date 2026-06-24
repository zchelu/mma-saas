export default function ThankYouPage() {
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
          You&apos;re on the list.
        </h1>
        <p className="text-base leading-relaxed" style={{ color: "#888888" }}>
          We&apos;ll call you within 24 hours to get KombatDesk set up for your gym.
        </p>
      </div>
    </div>
  );
}
