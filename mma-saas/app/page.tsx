import Link from "next/link";
import { currentUser } from "@clerk/nextjs/server";
import { Footer } from "./components/footer";

export default async function Home() {
  const user = await currentUser();

  return (
    <div className="min-h-screen text-white flex flex-col" style={{ backgroundColor: "#0D0D0D" }}>
      <header className="flex items-center justify-between px-8 py-5" style={{ borderBottom: "1px solid #333333" }}>
        <span className="text-xl font-bold tracking-tight" style={{ color: "#E02020" }}>KombatDesk</span>
        {/* Deliberately down to a single header action. Pricing and "Get
            started" both used to live here; /pricing is now a link sent
            directly to a prospect rather than something a visitor browses to
            (the page itself is still live, just unlinked and noindexed), and
            the only conversion path on this page is the "Book My Demo" CTA
            below. Adding a second header button re-opens a competing funnel
            that skips the demo entirely. */}
        <div className="flex items-center gap-3">
          {user ? (
            // Plain <a>, not Link: forces a full page load instead of a
            // client-side RSC transition. Diagnosed live (browser-extension
            // session) landing on the wrong route with zero failed fetches -
            // a client router bug, not a server error - so the fix is to
            // bypass the client router for this jump into the authenticated
            // app rather than keep chasing the router internals.
            <a
              href="/dashboard"
              className="text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
              style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
            >
              Dashboard
            </a>
          ) : (
            <a
              href="/sign-in"
              className="text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
              style={{ backgroundColor: "#FFFFFF", color: "#000000" }}
            >
              Sign in
            </a>
          )}
        </div>
      </header>

      <main className="flex flex-col items-center text-center px-8 flex-1">
        <div className="mt-32 mb-24 max-w-2xl">
          <div className="inline-block text-xs font-semibold tracking-widest uppercase px-4 py-1 mb-6 rounded-full" style={{ color: "#888888", border: "1px solid #333333" }}>
            Built for MMA &amp; BJJ gyms
          </div>
          <h1 className="text-5xl font-extrabold leading-tight tracking-tight mb-6" style={{ color: "#FFFFFF", fontWeight: 500 }}>
            Members don&apos;t quit your gym.<br />
            <span style={{ color: "#888888" }}>They just stop showing up.</span>
          </h1>
          <p className="text-lg mb-10 max-w-lg mx-auto" style={{ color: "#888888" }}>
            KombatDesk spots members going cold and texts them back through your door — automatically.
          </p>
          {/* Both CTAs on this page say the same thing and point to the same
              place on purpose — /signup is the lead form (app/actions/sendLead.ts),
              not Clerk's /sign-up. Keep the two labels identical; a visitor
              should never be choosing between two different asks. */}
          <div className="flex justify-center">
            <Link
              href="/signup"
              className="rounded-lg font-semibold px-6 py-3 transition-colors"
              style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
            >
              Book My Demo
            </Link>
          </div>
        </div>

        <div className="w-full max-w-xl pb-24">
          <p className="text-lg leading-relaxed" style={{ color: "#AAAAAA" }}>
            A member&apos;s last check-in was three weeks ago. You were busy coaching. By the
            time you noticed, they&apos;d already canceled. That&apos;s how most gyms lose
            members — not to competitors, to silence.
          </p>
        </div>

        <div className="w-full max-w-4xl grid grid-cols-1 sm:grid-cols-3 gap-6 pb-24">
          <HowItWorksStep
            number={1}
            description="Members check in at the front desk — takes two seconds."
          />
          <HowItWorksStep
            number={2}
            description="KombatDesk flags anyone going cold before they're gone."
          />
          <HowItWorksStep
            number={3}
            description="Automatic weekly texts bring them back through your door."
          />
        </div>

        <div className="w-full max-w-2xl pb-24">
          <div
            className="rounded-xl px-8 py-10 text-center"
            style={{ border: "1px solid #E02020", backgroundColor: "#1A0E0E" }}
          >
            <p className="text-2xl font-bold leading-snug" style={{ color: "#FFFFFF" }}>
              Your first 30 days are free. If I haven&apos;t brought back at least one member
              who&apos;d stopped showing up — a KombatDesk text, and they came back to class —
              within 90 days of your first text going out, I refund every dollar you&apos;ve paid.
            </p>
          </div>
        </div>

        <div className="w-full max-w-2xl pb-24">
          <h2 className="text-3xl font-extrabold tracking-tight mb-8" style={{ color: "#FFFFFF" }}>
            Stop losing members to silence.
          </h2>
          <Link
            href="/signup"
            className="inline-block rounded-lg font-semibold px-6 py-3 transition-colors"
            style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
          >
            Book My Demo
          </Link>
        </div>
      </main>

      <Footer />
    </div>
  );
}

function HowItWorksStep({ number, description }: { number: number; description: string }) {
  return (
    <div className="rounded-xl p-6 text-left" style={{ backgroundColor: "#222222", border: "1px solid #333333" }}>
      <div
        className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold mb-4"
        style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
      >
        {number}
      </div>
      <p className="text-sm leading-relaxed" style={{ color: "#CCCCCC" }}>{description}</p>
    </div>
  );
}
