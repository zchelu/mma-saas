import { currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { fetchQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { getConvexToken } from "@/lib/convex-auth";
import OnboardingWizard from "./onboarding-wizard";

const VALID_PLANS = new Set(["starter", "pro", "elite"]);

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
  // but onboardingCompleted is undefined; either signal alone is enough to
  // skip straight to the real dashboard).
  if (subscription.onboardingCompleted || subscription.stripeCustomerId) {
    redirect("/dashboard");
  }

  const { plan } = await searchParams;
  const initialPlan = plan && VALID_PLANS.has(plan) ? plan : "starter";

  // Resolved server-side so raw Stripe price IDs never need a NEXT_PUBLIC_
  // env var / never ship to the client bundle — the wizard only ever holds
  // the plan slug in its own state and gets the matching priceId as a prop.
  const priceIdByPlan: Record<string, string | undefined> = {
    starter: process.env.STRIPE_STARTER_PRICE_ID,
    pro: process.env.STRIPE_PRO_PRICE_ID,
    elite: process.env.STRIPE_ELITE_PRICE_ID,
  };

  return (
    <div className="min-h-screen text-white" style={{ backgroundColor: "#0D0D0D" }}>
      <OnboardingWizard initialPlan={initialPlan} priceIdByPlan={priceIdByPlan} />
    </div>
  );
}
