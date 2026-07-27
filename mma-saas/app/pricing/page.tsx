import type { Metadata } from "next";
import Link from "next/link";
import { currentUser } from "@clerk/nextjs/server";
import { Footer } from "../components/footer";
import { getFoundingOffer } from "@/lib/foundingOffer";

// The founding coupon's redemption count can change between requests (someone
// else closes a founding gym), so this page must never be served from a
// stale static/ISR cache — currentUser() below already forces dynamic
// rendering today, but that's an implicit side effect of an unrelated auth
// call, not a guarantee. Making it explicit means the founding pricing stays
// correct even if that auth call's caching behavior ever changes.
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

// Single place to change tier names, prices, and slugs for this page. As of
// the starter/pro/elite -> academy/fightteam/blackbelt rename, these slugs are
// what the onboarding wizard and Stripe webhook use too.
export const PRICING_TIERS = [
  {
    slug: "academy",
    name: "Academy",
    size: "Up to 100 members",
    price: 99,
    perks: [] as string[],
  },
  {
    slug: "fightteam",
    name: "Fight Team",
    size: "101–250 members",
    price: 179,
    perks: [] as string[],
  },
  {
    slug: "blackbelt",
    name: "Black Belt",
    size: "251+ members",
    price: 299,
    perks: [
      "Done-for-you roster import",
      "Monthly revenue review call with me",
      "Direct line to me",
    ] as string[],
  },
];

// Every tier shows the same CTA on purpose — the plans differ by gym size,
// not by feature, so there is nothing to upsell between them.
const CTA_LABEL = "I'm Ready to Stop the Bleeding";

// Signed-out visitors sign up first and carry ?plan= through to onboarding
// (/sign-up reads it and builds the redirect); signed-in visitors skip straight
// to the wizard, which would otherwise bounce them to /sign-in anyway.
function planHref(plan: string, signedIn: boolean): string {
  return signedIn ? `/onboarding?plan=${plan}` : `/sign-up?plan=${plan}`;
}

const INCLUDED_IN_EVERY_PLAN = [
  "Every member tracked — contact info, belt rank, promotion history",
  "Front-desk self check-in",
  "Automatic at-risk detection — every cold member shows up on your dashboard, by name, with days since their last visit",
  "Winback attempts taper off automatically — three texts over three weeks, then that member goes dormant so you never look like you're nagging",
  "Manual send — write your own message and send it to your at-risk members who've opted in to texts",
  "Monthly retention report — exactly who came back, exactly who's at risk",
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
      "Keep it. Most owners run KombatDesk alongside for the first month and decide from there. I'll import your roster either way.",
  },
  {
    question: "Do my members have to consent to texts?",
    answer:
      "Yes — and I give you the consent language and the addendum at setup. Takes five minutes.",
  },
  {
    question: "Contract?",
    answer: "None. Cancel from your dashboard.",
  },
];

export default async function PricingPage() {
  const user = await currentUser();
  const foundingOffer = await getFoundingOffer();

  return (
    <div className="min-h-screen text-white flex flex-col" style={{ backgroundColor: "#0D0D0D" }}>
      <header className="flex items-center justify-between px-8 py-5" style={{ borderBottom: "1px solid #333333" }}>
        <Link href="/" className="text-xl font-bold tracking-tight" style={{ color: "#E02020" }}>
          KombatDesk
        </Link>
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
              <TierCard key={tier.slug} tier={tier} signedIn={!!user} />
            ))}
          </div>
          <p className="text-sm text-center mt-8" style={{ color: "#888888" }}>
            30 days free. Cancel anytime. Card isn&apos;t charged until day 31.
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

        {/* 5. Founding offer — omitted entirely once the coupon is exhausted,
            deleted, or unconfigured; getFoundingOffer() is the single source
            of truth for whether this section (and its numbers) exist. */}
        {foundingOffer && (
          <div className="w-full max-w-2xl pb-24">
            <div
              className="rounded-xl px-8 py-10 text-center"
              style={{ border: "1px solid #E02020", backgroundColor: "#1A0E0E" }}
            >
              <h2 className="text-2xl font-bold leading-snug mb-4" style={{ color: "#FFFFFF" }}>
                First 5 gyms lock founding pricing for 24 months.
              </h2>
              <p className="text-lg font-semibold" style={{ color: "#E02020" }}>
                {PRICING_TIERS.map(
                  (t) => `$${t.price - foundingOffer.amountOffCents / 100}`
                ).join(" · ")}
                <span className="font-normal" style={{ color: "#AAAAAA" }}>
                  {" "}
                  — guaranteed for 24 months while the subscription stays active.
                </span>
              </p>
            </div>
          </div>
        )}

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

function TierCard({
  tier,
  signedIn,
}: {
  tier: (typeof PRICING_TIERS)[number];
  signedIn: boolean;
}) {
  return (
    <div
      className="rounded-xl p-8 flex flex-col text-left"
      style={{ backgroundColor: "#222222", border: "1px solid #333333" }}
    >
      <p className="text-xs font-semibold tracking-widest uppercase mb-2" style={{ color: "#E02020" }}>
        {tier.name}
      </p>
      <p className="text-sm mb-5" style={{ color: "#888888" }}>
        {tier.size}
      </p>

      <div className="flex items-baseline gap-1 mb-6">
        <span className="text-4xl font-extrabold" style={{ color: "#FFFFFF" }}>
          {`$${tier.price}`}
        </span>
        <span className="text-sm" style={{ color: "#888888" }}>
          /mo
        </span>
      </div>

      {tier.perks.length > 0 && (
        <ul className="flex flex-col gap-3 mb-6">
          {tier.perks.map((perk) => (
            <li key={perk} className="flex items-start gap-2 text-sm leading-snug" style={{ color: "#CCCCCC" }}>
              <span className="font-bold flex-shrink-0" style={{ color: "#E02020" }}>
                +
              </span>
              {perk}
            </li>
          ))}
        </ul>
      )}

      <Link
        href={planHref(tier.slug, signedIn)}
        className="mt-auto rounded-lg font-semibold px-6 py-3 text-sm text-center transition-colors"
        style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
      >
        {CTA_LABEL}
      </Link>
    </div>
  );
}
