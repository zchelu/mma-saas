import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentUser } from "@clerk/nextjs/server";
import { Footer } from "../components/footer";
import { Logo } from "../components/logo";
import { getFoundingProgram } from "@/lib/foundingOffer";
import { FOUNDING_SPOTS } from "@/lib/foundingOfferPolicy";
import { PLAN_PRICE_USD, TRIAL_DAYS, type PlanSlug } from "@/lib/plans";
import { TierCard } from "../pricing/tier-card";
import { PRICING_TIERS } from "../pricing/tiers";

// The founding coupons' redemption count changes between requests (another
// gym takes a spot), so this page must never be served from a static/ISR
// cache. Same reasoning /pricing used when the founding block lived there.
export const dynamic = "force-dynamic";

// /pricing's three cards and nothing else, at the founding prices. NOT part of
// the public funnel: it is a link Zain sends by hand after a demo, so it is
// kept out of search engines, the nav, the footer and the sitemap, exactly
// like /pricing. List price stays the anchor everywhere a stranger can land.
export const metadata: Metadata = {
  title: "Founding gym pricing | KombatDesk",
  robots: { index: false, follow: false },
};

const CTA_LABEL = "Lock In My Founding Price";

// `founding=1` is what makes checkout apply the founding coupon — see
// app/api/stripe/checkout/route.ts. It travels /sign-up -> /onboarding -> the
// wizard's POST. Signed-in visitors skip straight to the wizard, same as
// /pricing's planHref.
function foundingHref(plan: string, signedIn: boolean): string {
  return signedIn
    ? `/onboarding?plan=${plan}&founding=1`
    : `/sign-up?plan=${plan}&founding=1`;
}

export default async function FoundingPage() {
  // null covers every state in which a founding price must not be shown: sold
  // out, a coupon missing or breaking the program's rules, or Stripe
  // unreachable. This page then does not exist — the visitor lands on list
  // pricing instead of a founding price Stripe would not charge. That is also
  // what makes deploying this page BEFORE the coupons exist safe.
  const program = await getFoundingProgram();
  if (!program) redirect("/pricing");

  const user = await currentUser();
  const { slotsLeft } = program;

  return (
    <div className="min-h-screen text-white flex flex-col" style={{ backgroundColor: "#0D0D0D" }}>
      <header className="flex items-center justify-between px-8 py-5" style={{ borderBottom: "1px solid #333333" }}>
        <Logo href="/" height={26} />
        {/* Plain <a>, not Link - see app/page.tsx for why. */}
        <a
          href={user ? "/dashboard" : "/sign-in"}
          className="text-sm px-4 py-2"
          style={{ color: "#888888" }}
        >
          {user ? "Dashboard" : "Sign in"}
        </a>
      </header>

      <main className="flex flex-col items-center px-8 pt-16 flex-1">
        <div className="w-full max-w-2xl text-center pb-16">
          <p className="text-xs font-semibold tracking-widest uppercase mb-4" style={{ color: "#E02020" }}>
            Founding gym pricing
          </p>
          <h1 className="text-4xl font-extrabold leading-tight tracking-tight mb-4" style={{ color: "#FFFFFF" }}>
            Founding prices. Locked for life.
          </h1>
          <p className="text-lg max-w-lg mx-auto" style={{ color: "#888888" }}>
            {`I'm taking ${FOUNDING_SPOTS} gyms as founding members. You get the full product at the prices below, and your price never goes up for as long as you stay.`}
          </p>
        </div>

        <div className="w-full max-w-5xl pb-24">
          <p className="text-sm text-center mb-8" style={{ color: "#888888" }}>
            No contracts. Cancel anytime. Every plan includes the full product.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 items-stretch">
            {PRICING_TIERS.map((tier) => {
              // Read off the coupon, never hardcoded: list minus what Stripe
              // will actually take off. classifyFoundingProgram has already
              // refused to return a program unless this lands on the founding
              // price for every tier, so the number on the card and the number
              // on the invoice cannot be two numbers.
              const plan = tier.slug as PlanSlug;
              const foundingPrice = PLAN_PRICE_USD[plan] - program.offers[plan].amountOffCents / 100;
              return (
                <TierCard
                  key={tier.slug}
                  tier={tier}
                  href={foundingHref(tier.slug, !!user)}
                  ctaLabel={CTA_LABEL}
                  foundingPrice={foundingPrice}
                />
              );
            })}
          </div>
          <p className="text-sm text-center mt-8" style={{ color: "#888888" }}>
            {`${TRIAL_DAYS} days free. Cancel anytime. Card isn't charged until day ${TRIAL_DAYS + 1}.`}
          </p>
          <p className="text-sm font-semibold text-center mt-6" style={{ color: "#E02020" }}>
            {`${slotsLeft} of ${FOUNDING_SPOTS} founding spots left. When ${slotsLeft === 1 ? "it's" : "they're"} gone, this page comes down.`}
          </p>
          <p className="text-xs text-center mt-6 max-w-xl mx-auto leading-relaxed" style={{ color: "#777777" }}>
            Locked for life means your monthly price stays the same for as long as your subscription
            stays active. If you cancel, the founding price ends with your subscription.
          </p>
        </div>
      </main>

      <Footer />
    </div>
  );
}
