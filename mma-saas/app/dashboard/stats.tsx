"use client";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

export default function StatsGrid() {
  const activeMembers = useQuery(api.members.getActiveCount);
  const classCount = useQuery(api.classes.getCount);
  const openInvoices = useQuery(api.invoices.getUnpaidCount);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
      <StatCard label="Active Members" value={activeMembers} />
      <StatCard label="Classes Scheduled" value={classCount} />
      <StatCard label="Open Invoices" value={openInvoices} />
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div className="rounded-xl p-6" style={{ backgroundColor: "#222222", border: "1px solid #333333" }}>
      <p className="text-sm mb-1" style={{ color: "#888888" }}>{label}</p>
      <p className="text-4xl font-bold" style={{ color: "#FFFFFF" }}>{value === undefined ? "…" : value}</p>
    </div>
  );
}
