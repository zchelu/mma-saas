import Link from "next/link";
import PricingCards from "./components/pricing-cards";

export default function Home() {
  return (
    <div className="min-h-screen text-white flex flex-col" style={{ backgroundColor: "#0D0D0D" }}>
      <header className="flex items-center justify-between px-8 py-5" style={{ borderBottom: "1px solid #333333" }}>
        <span className="text-xl font-bold tracking-tight" style={{ color: "#E02020" }}>KombatDesk</span>
        <div className="flex gap-3">
          <Link
            href="/sign-in"
            className="text-sm px-4 py-2 transition-colors"
            style={{ color: "#888888" }}
          >
            Sign in
          </Link>
          <Link
            href="/signup"
            className="text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
            style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
          >
            Get started
          </Link>
        </div>
      </header>

      <main className="flex flex-col items-center text-center px-8 flex-1">
        <div className="mt-32 mb-16 max-w-2xl">
          <div className="inline-block text-xs font-semibold tracking-widest uppercase px-4 py-1 mb-6 rounded-full" style={{ color: "#888888", border: "1px solid #333333" }}>
            Built for MMA &amp; BJJ gyms
          </div>
          <h1 className="text-5xl font-extrabold leading-tight tracking-tight mb-6" style={{ color: "#FFFFFF", fontWeight: 500 }}>
            Run your gym.<br />
            <span style={{ color: "#888888" }}>Not spreadsheets.</span>
          </h1>
          <p className="text-lg mb-10 max-w-lg mx-auto" style={{ color: "#888888" }}>
            Check-ins, member tracking, classes, and billing — all in one place. KombatDesk handles the admin so you can spend more time on the mats.
          </p>
          <div className="flex justify-center">
            <Link
              href="/signup"
              className="rounded-lg font-semibold px-6 py-3 transition-colors"
              style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
            >
              Set up my gym
            </Link>
          </div>
        </div>

        <div className="w-full max-w-4xl grid grid-cols-1 sm:grid-cols-3 gap-6 mb-32">
          <FeatureCard
            title="Member Management"
            description="Add, edit, and track every athlete. See who's active, on what plan, and when they last trained."
          />
          <FeatureCard
            title="Attendance Tracking"
            description="Log class attendance in seconds. Know exactly who's showing up and who's gone cold."
          />
          <FeatureCard
            title="Billing & Invoices"
            description="Send invoices and track payments without leaving the platform. Get paid on time, every time."
          />
        </div>

        <div className="w-full max-w-3xl pb-24">
          <div className="text-center mb-14">
            <div
              className="inline-block text-xs font-semibold tracking-widest uppercase px-4 py-1 mb-6 rounded-full"
              style={{ color: "#888888", border: "1px solid #333333" }}
            >
              Simple pricing
            </div>
            <h2 className="text-4xl font-extrabold tracking-tight mb-4" style={{ color: "#FFFFFF" }}>
              Pick your plan
            </h2>
            <p className="text-lg" style={{ color: "#888888" }}>
              No contracts. Cancel anytime.
            </p>
          </div>
          <PricingCards
            starterPriceId={process.env.STRIPE_STARTER_PRICE_ID ?? ""}
            proPriceId={process.env.STRIPE_PRO_PRICE_ID ?? ""}
          />
        </div>
      </main>

      <footer className="px-8 py-5 text-center text-xs" style={{ borderTop: "1px solid #333333", color: "#555555" }}>
        © {new Date().getFullYear()} KombatDesk. All rights reserved.
      </footer>
    </div>
  );
}

function FeatureCard({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-xl p-6 text-left" style={{ backgroundColor: "#222222", border: "1px solid #333333" }}>
      <h3 className="font-medium mb-2" style={{ color: "#FFFFFF" }}>{title}</h3>
      <p className="text-sm leading-relaxed" style={{ color: "#888888" }}>{description}</p>
    </div>
  );
}
