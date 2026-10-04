import { currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { fetchQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { getConvexToken } from "@/lib/convex-auth";
import { getFoundingProgram } from "@/lib/foundingOffer";
import { PLAN_PRICE_USD, resolvePriceId, PlanSlug } from "@/lib/plans";
import OnboardingWizard from "./onboarding-wizard";

const VALID_PLANS = new Set(["academy", "fightteam", "blackbelt"]);

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string; code?: string; founding?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const token = await getConvexToken();
  const subscription = await fetchQuery(api.subscriptions.getSubscription, {}, { token });

  // Already done — don't re-run the wizard over an existing gym. Covers both
  // a completed onboarding+active plan, and someone who already paid via the
  // old guest-checkout/recovery path (those gyms have stripeCustomerId set
  // but onboardingCompleted is undefined). Either signal alone used to be
  // enough to redirect — but onboardingCompleted gets set (by
  // convex/onboarding.ts) before Stripe Checkout ever runs, and
  // stripeCustomerId can exist from a canceled/never-activated attempt too.
  // Neither means the gym actually has a plan worth skipping to a dashboard
  // for, so both are now gated on a real active/trialing planStatus — an
  // abandoned checkout falls through to show the wizard again instead of
  // permanently landing on a fake unpurchased plan.
  const hasActivePlan =
    subscription.planStatus === "active" || subscription.planStatus === "trialing";

  // A paying gym with no slug is the guest-checkout dead-gym state: slug is
  // assigned in exactly one place (onboarding.completeOnboarding), the guest
  // path never mounts this wizard, and no slug means no /consent/[gymSlug]
  // page, which means no member can ever confirm SMS consent, which means the
  // gym can never send a retention text. Before this guard existed the redirect
  // below bounced them to /dashboard on sight, so there was no in-app route to
  // ever set the name — a paid subscription permanently unable to do the one
  // thing it was bought for. See claude/guest-checkout-dead-gym-trap.md.
  //
  // Letting them back in is only safe because the wizard is told not to charge
  // them again — see repairMode below. Without that they'd be walked into a
  // second Stripe subscription, which is a far worse failure than the one this
  // fixes.
  const needsSetupRepair = hasActivePlan && !subscription.hasSlug;

  if (
    (subscription.onboardingCompleted || subscription.stripeCustomerId) &&
    hasActivePlan &&
    !needsSetupRepair
  ) {
    redirect("/dashboard");
  }

  const { plan, code, founding } = await searchParams;
  const initialPlan = plan && VALID_PLANS.has(plan) ? plan : "academy";

  // FOUNDING PRICE (not the founding TRIAL below — different thing). ?founding=1
  // is set by /founding's CTAs and means "this owner was shown the founding
  // price". The number is resolved HERE, from the Stripe coupons, so the wizard
  // can disclose the price that will really be charged right above the
  // enrollment button (C.R.S. 6-1-732) and ask checkout for it.
  //
  // null in every other case: no flag, or the program is sold out / broken /
  // unreachable. The wizard then discloses list price and does not ask — which
  // is also what checkout would charge, so the two cannot disagree.
  let foundingPriceUsd: number | null = null;
  if (founding === "1") {
    const program = await getFoundingProgram();
    const offer = program?.offers[initialPlan as PlanSlug];
    if (offer) foundingPriceUsd = PLAN_PRICE_USD[initialPlan] - offer.amountOffCents / 100;
  }

  // FOUNDING (COMPED) TRIAL. ?code= prefills the founding-access field so Zain
  // can send one link and the gym owner types nothing extra — the whole point
  // of this path is that the first gym enters no card and as little else as
  // possible. Never validated here: the code is checked server-side inside
  // convex/onboarding.ts:completeOnboarding, which is also where the rate limit
  // and the redemption cap live. Anything this page decided about it would be
  // decoration, and a client-visible "valid/invalid" answer would turn the
  // wizard into a code oracle.
  const initialFoundingCode = typeof code === "string" ? code.slice(0, 100) : "";

  // Resolved server-side so raw Stripe price IDs never need a NEXT_PUBLIC_
  // env var / never ship to the client bundle — the wizard only ever holds
  // the plan slug in its own state and gets the matching priceId as a prop.
  const priceIdByPlan: Record<string, string | undefined> = Object.fromEntries(
    [...VALID_PLANS].map((p) => [p, resolvePriceId(p as PlanSlug)])
  );

  return (
    <div className="min-h-screen text-white" style={{ backgroundColor: "#0D0D0D" }}>
      {/* initialGymName/City/State: whatever completeOnboarding already saved.
          Passed as props rather than fetched inside the wizard so the values
          arrive with the FIRST render — a client-side query would paint empty
          fields first, which is the exact "nothing saved" impression this
          exists to remove. */}
      <OnboardingWizard
        initialPlan={initialPlan}
        priceIdByPlan={priceIdByPlan}
        repairMode={needsSetupRepair}
        initialGymName={subscription.gymName ?? ""}
        initialCity={subscription.city ?? ""}
        initialState={subscription.state ?? ""}
        initialFoundingCode={initialFoundingCode}
        foundingPriceUsd={foundingPriceUsd}
      />
    </div>
  );
}
