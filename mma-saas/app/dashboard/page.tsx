import { currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import AppHeader from "../components/app-header";
import StatsGrid from "./stats";

export default async function DashboardPage() {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  return (
    <div className="min-h-screen text-white" style={{ backgroundColor: "#0D0D0D" }}>
      <AppHeader />
      <main className="max-w-5xl mx-auto px-8 py-16">
        <h1 className="text-3xl mb-2" style={{ color: "#FFFFFF", fontWeight: 500 }}>
          Welcome back, {user.firstName ?? "Coach"}
        </h1>
        <p className="mb-12" style={{ color: "#888888" }}>Here&apos;s your gym at a glance.</p>
        <StatsGrid />
      </main>
    </div>
  );
}
