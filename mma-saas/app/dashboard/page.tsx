import { currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { fetchQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import AppHeader from "../components/app-header";
import StatsGrid from "./stats";
import RetentionButton from "./retention-button";
import AtRiskPanel from "./at-risk";

export default async function DashboardPage() {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const subscription = await fetchQuery(api.subscriptions.getSubscription, { clerkUserId: user.id });
  if (!subscription.plan || subscription.planStatus !== "active") redirect("/pricing");

  return (
    <div className="min-h-screen text-white" style={{ backgroundColor: "#0D0D0D" }}>
      <AppHeader />
      <main className="max-w-5xl mx-auto px-8 py-16">
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-3xl" style={{ color: "#FFFFFF", fontWeight: 500 }}>
            Welcome back, {user.firstName ?? "Coach"}
          </h1>
          <RetentionButton />
        </div>
        <p className="mb-12" style={{ color: "#888888" }}>Here&apos;s your gym at a glance.</p>
        <StatsGrid />
        <AtRiskPanel />
      </main>
    </div>
  );
}
