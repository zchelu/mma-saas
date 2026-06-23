import { currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import AppHeader from "../components/app-header";
import StatsGrid from "./stats";

export default async function DashboardPage() {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <AppHeader />
      <main className="max-w-5xl mx-auto px-8 py-16">
        <h1 className="text-3xl font-bold mb-2">
          Welcome back, {user.firstName ?? "Coach"}
        </h1>
        <p className="text-zinc-400 mb-12">Here&apos;s your gym at a glance.</p>
        <StatsGrid />
      </main>
    </div>
  );
}
