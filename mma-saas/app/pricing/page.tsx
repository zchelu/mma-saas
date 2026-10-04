import type { Metadata } from "next";
import { currentUser } from "@clerk/nextjs/server";
import { Footer } from "../components/footer";
import { Logo } from "../components/logo";
import { TRIAL_DAYS } from "@/lib/plans";
import { TierCard } from "./tier-card";
import { PRICING_TIERS } from "./tiers";

// The header and every CTA depend on whether the visitor is signed in, so this
// page must never be served from a static/ISR cache. currentUser() below
// already forces dynamic rendering, but that is an implicit side effect of the
// auth call rather than a guarantee, so it is stated.
//
// LIST PRICES ONLY, since 2026-10-03. The founding program used to be a block
// on this page; it is now its own page, /founding, which Zain sends by hand.
// Nothing here reads the founding coupons or mentions a founding price, and
// checkout only applies one to a buyer who came in through /founding — a
// visitor quoted list price here is charged list price.
export const dynamic = "force-dynamic";

// This page is no longer part of the public funnel. The landing page header
// used to link here; it doesn't anymore, because pricing is now something
// sent directly to a prospect after the demo rather than something a visitor
// browses to on their own. The page stays live and reachable by direct URL
// (and is still the cancel_url target for Stripe checkout), but search
// engines are kept off it so a prospect can't land on pricing before the
// conversation that's supposed to precede it.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

// Every tier shows the same CTA on purpose — the plans differ by gym size,
// not by feature, so there is nothing to upsell between them.
const CTA_LABEL = "I'm Ready to Stop the Bleeding";

// Signed-out visitors sign up first and carry ?plan= through to onboarding
// (/sign-up reads it and builds the redirect); signed-in visitors skip straight
// to the wizard, which would otherwise bounce them to /sign-in anyway.
function planHref(plan: string, signedIn: boolean): string {
  return signedIn ? `/onboarding?plan=${plan}` : `/sign-up?plan=${plan}`;
}

// Small values today, but this keeps the guarantee copy from silently
// rendering "$1200" once list prices grow past four digits.
function formatUsd(amount: number): string {
  return `$${amount.toLocaleString("en-US")}`;
}

const INCLUDED_IN_EVERY_PLAN = [
  "Every member tracked — contact info, belt rank, promotion history",
  "Front-desk self check-in",
  "Automatic at-risk detection — every cold member shows up on your dashboard, by name, with days since their last visit",
  "Winback attempts taper off automatically — three texts over three weeks, then that member goes dormant so you never look like you're nagging",
  "Manual send — write your own message and send it to your at-risk members who've opted in to texts",
  "Setup call with me, on every plan",
];

const FAQS = [
  {
    question: "What if I go over 100 members?",
    answer:
      "Grow. I don't move you up a tier until you've been over the line for 60 straight days.",
  },
  {
    question: "I already use Zen Planner / Gymdesk / Kicksite.",
    answer:
      "Keep it. Run KombatDesk alongside for the first month and decide from there — I'll import your roster either way, and you're not moving anything off your current system to try this.",
  },
  {
    question: "Do my members have to consent to texts?",
    answer:
      "Yes — every member opts in before we can text them. I set up the opt-in page for your gym and hand you the link, so you can drop it in your group chat, on the whiteboard, or at the front desk. You watch the count climb from your dashboard.",
  },
  {
    question: "Contract?",
    answer: "None. Cancel from your dashboard.",
  },
];

export default async function PricingPage() {
  const user = await currentUser();

  const academyPrice = PRICING_TIERS.find((t) => t.slug === "academy")!.price;
  const sixMonthsAcademyList = academyPrice * 6;

  return (
    <div className="min-h-screen text-white flex flex-col" style={{ backgroundColor: "#0D0D0D" }}>
      <header className="flex items-center justify-between px-8 py-5" style={{ borderBottom: "1px solid #333333" }}>
        <Logo href="/" height={26} />
        {/* Plain <a>, not Link - see app/page.tsx for why: diagnosed a
            client-router bug landing on the wrong route with zero failed
            fetches, so this bypasses the client router entirely. */}
        <a
          href={user ? "/dashboard" : "/sign-in"}
          className="text-sm px-4 py-2"
          style={{ color: "#888888" }}
        >
          {user ? "Dashboard" : "Sign in"}
        </a>
      </header>

      <main className="flex flex-col items-center px-8 pt-16 flex-1">
        {/* 1. Top — deliberately compressed. The landing page owns the hero. */}
        <div className="w-full max-w-2xl text-center pb-16">
          <h1 className="text-4xl font-extrabold leading-tight tracking-tight mb-4" style={{ color: "#FFFFFF" }}>
            Same product. Priced to your gym.
          </h1>
          <p className="text-lg max-w-lg mx-auto" style={{ color: "#888888" }}>
            Your members don&apos;t quit — they stop showing up. KombatDesk catches them at
            week two and texts them back to the mats.
          </p>
        </div>

        {/* 2. Anchor block */}
        <div className="w-full max-w-xl text-center pb-16">
          <p className="text-lg leading-relaxed" style={{ color: "#AAAAAA" }}>
            Three silent quitters at $150/month dues is $5,400 a year walking out of your
            gym. You didn&apos;t lose them to a competitor. You lost them to nobody noticing.
          </p>
        </div>

        {/* 3. Tiers */}
        <div className="w-full max-w-5xl pb-24">
          <p className="text-sm text-center mb-8" style={{ color: "#888888" }}>
            No contracts. Cancel anytime. Every plan includes everything below.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 items-stretch">
            {PRICING_TIERS.map((tier) => (
              <TierCard
                key={tier.slug}
                tier={tier}
                href={planHref(tier.slug, !!user)}
                ctaLabel={CTA_LABEL}
              />
            ))}
          </div>
          <p className="text-sm text-center mt-8" style={{ color: "#888888" }}>
            {`${TRIAL_DAYS} days free. Cancel anytime. Card isn't charged until day ${TRIAL_DAYS + 1}.`}
          </p>
        </div>

        {/* 4. Included in every plan */}
        <div className="w-full max-w-3xl pb-24">
          <h2 className="text-3xl font-extrabold tracking-tight mb-8 text-center" style={{ color: "#FFFFFF" }}>
            Everything included, every plan
          </h2>
          <ul className="flex flex-col gap-4">
            {INCLUDED_IN_EVERY_PLAN.map((item) => (
              <li
                key={item}
                className="flex items-start gap-3 text-base leading-relaxed"
                style={{ color: "#CCCCCC" }}
              >
                <span className="mt-0.5 font-bold flex-shrink-0" style={{ color: "#E02020" }}>
                  ✓
                </span>
                {item}
              </li>
            ))}
          </ul>
        </div>

        {/* 5. Guarantee — pushes the risk past the free trial instead of
            restating it. The homepage's short version says the same thing;
            keep both in sync if this copy changes. */}
        <div className="w-full max-w-2xl pb-24">
          <div
            className="rounded-xl px-8 py-10 text-center"
            style={{ border: "1px solid #E02020", backgroundColor: "#1A0E0E" }}
          >
            <h2 className="text-2xl font-bold leading-snug mb-4" style={{ color: "#FFFFFF" }}>
              The Saved Member Guarantee
            </h2>
            <p className="text-base leading-relaxed mb-4" style={{ color: "#CCCCCC" }}>
              {`Your first ${TRIAL_DAYS} days are free. Card on file, nothing charged until day ${TRIAL_DAYS + 1}.`}
            </p>
            <p className="text-base leading-relaxed mb-4" style={{ color: "#CCCCCC" }}>
              After that: if KombatDesk hasn&apos;t brought back at least one member who&apos;d gone
              cold by day 90, I refund every dollar you&apos;ve paid and help you export your member
              roster on the way out. You leave with your data, not locked inside my software.
            </p>
            <p className="text-sm" style={{ color: "#AAAAAA" }}>
              A member who stays six more months instead of quitting is $900 back on your books. Six months
              of Academy is {formatUsd(sixMonthsAcademyList)}. I&apos;m betting my own revenue that I can
              find you one. If I can&apos;t, I haven&apos;t earned the right to charge you.
            </p>
          </div>
        </div>

        {/* 6. FAQ */}
        <div className="w-full max-w-3xl pb-24">
          <h2 className="text-3xl font-extrabold tracking-tight mb-8 text-center" style={{ color: "#FFFFFF" }}>
            Questions
          </h2>
          <div className="flex flex-col gap-4">
            {FAQS.map((faq) => (
              <div
                key={faq.question}
                className="rounded-xl p-6 text-left"
                style={{ backgroundColor: "#222222", border: "1px solid #333333" }}
              >
                <p className="text-base font-semibold mb-2" style={{ color: "#FFFFFF" }}>
                  {faq.question}
                </p>
                <p className="text-sm leading-relaxed" style={{ color: "#AAAAAA" }}>
                  {faq.answer}
                </p>
              </div>
            ))}
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}
