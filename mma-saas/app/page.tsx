import Link from "next/link";

export default function Home() {
  return (
    <div className="min-h-screen bg-zinc-950 text-white flex flex-col">
      <header className="flex items-center justify-between px-8 py-5 border-b border-zinc-800">
        <span className="text-xl font-bold tracking-tight">MatFlow</span>
        <div className="flex gap-3">
          <Link
            href="/sign-in"
            className="text-sm text-zinc-400 hover:text-white px-4 py-2 transition-colors"
          >
            Sign in
          </Link>
          <Link
            href="/sign-up"
            className="text-sm font-semibold bg-white text-black px-4 py-2 rounded-lg hover:bg-zinc-200 transition-colors"
          >
            Get started
          </Link>
        </div>
      </header>

      <main className="flex flex-col items-center text-center px-8 flex-1">
        <div className="mt-32 mb-16 max-w-2xl">
          <div className="inline-block text-xs font-semibold tracking-widest uppercase text-zinc-400 border border-zinc-700 rounded-full px-4 py-1 mb-6">
            Built for MMA &amp; BJJ gyms
          </div>
          <h1 className="text-5xl font-extrabold leading-tight tracking-tight mb-6">
            Run your gym.<br />
            <span className="text-zinc-400">Not spreadsheets.</span>
          </h1>
          <p className="text-lg text-zinc-400 mb-10 max-w-lg mx-auto">
            MatFlow gives coaches and gym owners one place to manage members, track attendance, and handle billing — without the chaos.
          </p>
          <div className="flex gap-4 justify-center">
            <Link
              href="/sign-up"
              className="rounded-lg bg-white text-black font-semibold px-6 py-3 hover:bg-zinc-200 transition-colors"
            >
              Start free
            </Link>
            <Link
              href="/sign-in"
              className="rounded-lg border border-zinc-700 text-zinc-300 font-semibold px-6 py-3 hover:bg-zinc-800 transition-colors"
            >
              Sign in
            </Link>
          </div>
        </div>

        <div className="w-full max-w-4xl grid grid-cols-1 sm:grid-cols-3 gap-6 pb-24">
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
      </main>

      <footer className="border-t border-zinc-800 px-8 py-5 text-center text-xs text-zinc-600">
        © {new Date().getFullYear()} MatFlow. All rights reserved.
      </footer>
    </div>
  );
}

function FeatureCard({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6 text-left">
      <h3 className="font-semibold text-white mb-2">{title}</h3>
      <p className="text-sm text-zinc-400 leading-relaxed">{description}</p>
    </div>
  );
}
