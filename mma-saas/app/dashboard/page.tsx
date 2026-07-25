import { currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { fetchQuery, fetchMutation } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { getConvexToken } from "@/lib/convex-auth";
import AppHeader from "../components/app-header";
import StatsGrid from "./stats";
import RetentionButton from "./retention-button";
import AtRiskPanel from "./at-risk";
import SettlingGate from "./settling-gate";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const { checkout } = await searchParams;
  const token = await getConvexToken();

  // First authenticated page a new sign-up ever reaches — provisions this
  // owner's gyms row if one doesn't exist yet. No-op for existing owners.
  // clerkUserId is identity-derived inside the mutation from this token, not
  // passed as an argument — see convex/subscriptions.ts.
  await fetchMutation(
    api.subscriptions.getOrCreateGym,
    { defaultName: user.firstName ? `${user.firstName}'s Gym` : undefined },
    { token }
  );

  const subscription = await fetchQuery(api.subscriptions.getSubscription, {}, { token });

  // Auth-first signup: onboarding runs before any checkout, so a gym that
  // hasn't finished it yet has no stripeCustomerId either. A gym that DOES
  // have a stripeCustomerId already got here via the old guest-checkout/
  // recovery fallback (onboardingCompleted is undefined for those, and
  // that's fine — they never needed the wizard) so it's excluded here to
  // avoid forcing already-paying accounts through onboarding retroactively.
  if (!subscription.onboardingCompleted && !subscription.stripeCustomerId) {
    redirect("/onboarding");
  }

  // Mirrors requireGym's read-access gate (convex/gyms.ts): only "inactive"/
  // no plan at all is blocked here. canceled/past_due gyms keep a read-only
  // grace period and should reach the real dashboard, not bounce to
  // /pricing — SettlingGate used to gate on active/trialing only, which
  // meant a canceled or past_due gym got stuck "finalizing" for 8s and then
  // got hard-redirected to /pricing despite requireGym allowing it through.
  // A checkout may still be settling too (claimGymBySessionId / webhook
  // write racing this request) — SettlingGate itself handles that case,
  // waiting on the reactive query before deciding there's genuinely no plan.
  if (!subscription.planStatus || subscription.planStatus === "inactive") {
    // checkout=success (set by the auth-first success_url — see
    // app/api/stripe/checkout/route.ts) means stripeCustomerId is NOT known
    // yet by design: unlike the old /welcome path, nothing synchronously
    // claimed the subscription before landing here, so SettlingGate must
    // wait out the webhook instead of bouncing on "no stripeCustomerId yet".
    return <SettlingGate awaitingCheckout={checkout === "success"} />;
  }

  // Members moved out of the onboarding wizard (now gym info + SMS consent
  // only) — this is where that first roster entry actually happens instead,
  // via the existing /members add-member UI.
  const memberCount = await fetchQuery(api.members.getActiveCount, {}, { token });

  return (
    <div className="min-h-screen text-white" style={{ backgroundColor: "#0D0D0D" }}>
      <AppHeader />
      <main className="max-w-5xl mx-auto px-8 py-16">
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-3xl" style={{ color: "#FFFFFF", fontWeight: 500 }}>
            Welcome back, {user.firstName ?? "Coach"}
          </h1>
          {subscription.plan === "blackbelt" && <RetentionButton />}
        </div>
        <p className="mb-12" style={{ color: "#888888" }}>Here&apos;s your gym at a glance.</p>
        {memberCount === 0 && (
          <Link
            href="/members"
            className="flex items-center justify-between rounded-lg px-6 py-4 mb-12"
            style={{ border: "1px solid #E02020", backgroundColor: "#1A1A1A" }}
          >
            <span style={{ color: "#FFFFFF" }}>Add your first members to start tracking attendance</span>
            <span style={{ color: "#E02020" }}>Add members →</span>
          </Link>
        )}
        <StatsGrid />
        <AtRiskPanel />
      </main>
    </div>
  );
}
