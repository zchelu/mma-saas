import Link from "next/link";
import { currentUser } from "@clerk/nextjs/server";

export default async function Home() {
  const user = await currentUser();

  return (
    <div className="min-h-screen text-white flex flex-col" style={{ backgroundColor: "#0D0D0D" }}>
      <header className="flex items-center justify-between px-8 py-5" style={{ borderBottom: "1px solid #333333" }}>
        <span className="text-xl font-bold tracking-tight" style={{ color: "#E02020" }}>KombatDesk</span>
        <div className="flex items-center gap-3">
          <Link
            href="/pricing"
            className="text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
            style={{ backgroundColor: "#FFFFFF", color: "#000000" }}
          >
            Pricing
          </Link>
          {user ? (
            <Link
              href="/dashboard"
              prefetch={false}
              className="text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
              style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
            >
              Dashboard
            </Link>
          ) : (
            <>
              <Link
                href="/sign-in"
                prefetch={false}
                className="text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
                style={{ backgroundColor: "#FFFFFF", color: "#000000" }}
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
            </>
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
            <p className="text-2xl font-bold leading-snug mb-4" style={{ color: "#FFFFFF" }}>
              If KombatDesk doesn&apos;t save you at least one member in your first 30 days,
              it&apos;s free.
            </p>
            <p className="text-sm" style={{ color: "#AAAAAA" }}>
              One saved member pays for KombatDesk. Everything after that is profit you were
              losing to silence.
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
            Set up my gym
          </Link>
        </div>
      </main>

      <footer
        className="flex flex-col sm:flex-row items-center justify-center gap-2 sm:gap-4 px-8 py-5 text-center text-xs"
        style={{ borderTop: "1px solid #333333", color: "#555555" }}
      >
        <span>© {new Date().getFullYear()} KombatDesk. All rights reserved.</span>
      </footer>
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
