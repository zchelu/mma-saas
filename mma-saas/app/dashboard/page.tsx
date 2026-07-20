import { currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { fetchQuery, fetchMutation } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { getConvexToken } from "@/lib/convex-auth";
import AppHeader from "../components/app-header";
import StatsGrid from "./stats";
import RetentionButton from "./retention-button";
import AtRiskPanel from "./at-risk";
import SettlingGate from "./settling-gate";

export default async function DashboardPage() {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

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
  // Not active yet doesn't necessarily mean no plan exists — a checkout may
  // still be settling (claimGymBySessionId / webhook write racing this
  // request). Let the client reactively wait rather than hard-bouncing a
  // paying customer to /pricing; SettlingGate itself redirects to /pricing
  // once it can tell there's genuinely no plan, or after a timeout.
  if (!subscription.plan || (subscription.planStatus !== "active" && subscription.planStatus !== "trialing")) {
    return <SettlingGate />;
  }

  return (
    <div className="min-h-screen text-white" style={{ backgroundColor: "#0D0D0D" }}>
      <AppHeader />
      <main className="max-w-5xl mx-auto px-8 py-16">
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-3xl" style={{ color: "#FFFFFF", fontWeight: 500 }}>
            Welcome back, {user.firstName ?? "Coach"}
          </h1>
          {subscription.plan === "elite" && <RetentionButton />}
        </div>
        <p className="mb-12" style={{ color: "#888888" }}>Here&apos;s your gym at a glance.</p>
        <StatsGrid />
        <AtRiskPanel />
      </main>
    </div>
  );
}
