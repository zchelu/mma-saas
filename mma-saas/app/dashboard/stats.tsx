"use client";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

export default function StatsGrid() {
  const activeMembers = useQuery(api.members.getActiveCount);
  const classCount = useQuery(api.classes.getCount);
  const openInvoices = useQuery(api.invoices.getUnpaidCount);
  const consentStats = useQuery(api.consent.getConsentStats);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-4 gap-6">
      <StatCard label="Active Members" value={activeMembers} />
      <StatCard label="Classes Scheduled" value={classCount} />
      <StatCard label="Open Invoices" value={openInvoices} />
      {/* Deliberately the MATCHED count, not the total. The old card showed
          every submission, including the ones that matched no roster member
          and therefore made nobody textable — so the number an owner read as
          "people I can now text" was inflated by exactly the failures they
          most needed to see. The gap gets its own callout in owner-links.tsx;
          this card now only counts opt-ins that actually took effect. */}
      <StatCard
        label="Members Opted In"
        value={consentStats?.matchedSubmissions}
        note={
          consentStats && consentStats.unmatchedSubmissions > 0
            ? `${consentStats.unmatchedSubmissions} didn't match a member`
            : undefined
        }
      />
    </div>
  );
}

function StatCard({
  label,
  value,
  note,
}: {
  label: string;
  value: number | undefined;
  note?: string;
}) {
  return (
    <div className="rounded-xl p-6" style={{ backgroundColor: "#222222", border: "1px solid #333333" }}>
      <p className="text-sm mb-1" style={{ color: "#888888" }}>{label}</p>
      <p className="text-4xl font-bold" style={{ color: "#FFFFFF" }}>{value === undefined ? "…" : value}</p>
      {note && <p className="text-xs mt-2" style={{ color: "#E02020" }}>{note}</p>}
    </div>
  );
}
