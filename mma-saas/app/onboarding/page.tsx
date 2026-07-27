import { currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { fetchQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { getConvexToken } from "@/lib/convex-auth";
import { resolvePriceId, PlanSlug } from "@/lib/plans";
import OnboardingWizard from "./onboarding-wizard";

const VALID_PLANS = new Set(["academy", "fightteam", "blackbelt"]);

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string }>;
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
  if ((subscription.onboardingCompleted || subscription.stripeCustomerId) && hasActivePlan) {
    redirect("/dashboard");
  }

  const { plan } = await searchParams;
  const initialPlan = plan && VALID_PLANS.has(plan) ? plan : "academy";

  // Resolved server-side so raw Stripe price IDs never need a NEXT_PUBLIC_
  // env var / never ship to the client bundle — the wizard only ever holds
  // the plan slug in its own state and gets the matching priceId as a prop.
  const priceIdByPlan: Record<string, string | undefined> = Object.fromEntries(
    [...VALID_PLANS].map((p) => [p, resolvePriceId(p as PlanSlug)])
  );

  return (
    <div className="min-h-screen text-white" style={{ backgroundColor: "#0D0D0D" }}>
      <OnboardingWizard initialPlan={initialPlan} priceIdByPlan={priceIdByPlan} />
    </div>
  );
}
