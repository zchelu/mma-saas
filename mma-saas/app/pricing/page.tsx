import Link from "next/link";
import PricingCards from "../components/pricing-cards";

export default function PricingPage() {
  return (
    <div className="min-h-screen text-white flex flex-col" style={{ backgroundColor: "#0D0D0D" }}>
      <header className="flex items-center justify-between px-8 py-5" style={{ borderBottom: "1px solid #333333" }}>
        <Link href="/" className="text-xl font-bold tracking-tight" style={{ color: "#E02020" }}>
          KombatDesk
        </Link>
        <Link
          href="/sign-in"
          className="text-sm px-4 py-2"
          style={{ color: "#888888" }}
        >
          Sign in
        </Link>
      </header>

      <main className="flex flex-col items-center px-8 py-24 flex-1">
        <div className="text-center mb-14">
          <div
            className="inline-block text-xs font-semibold tracking-widest uppercase px-4 py-1 mb-6 rounded-full"
            style={{ color: "#888888", border: "1px solid #333333" }}
          >
            Simple pricing
          </div>
          <h1 className="text-4xl font-extrabold tracking-tight mb-4" style={{ color: "#FFFFFF" }}>
            Pick your plan
          </h1>
          <p className="text-lg" style={{ color: "#888888" }}>
            No contracts. Cancel anytime.
          </p>
        </div>

        <PricingCards
          starterPriceId={process.env.STRIPE_STARTER_PRICE_ID ?? ""}
          proPriceId={process.env.STRIPE_PRO_PRICE_ID ?? ""}
        />
      </main>

      <footer className="px-8 py-5 text-center text-xs" style={{ borderTop: "1px solid #333333", color: "#555555" }}>
        © {new Date().getFullYear()} KombatDesk. All rights reserved.
      </footer>
    </div>
  );
}
