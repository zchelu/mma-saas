"use client";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

export default function StatsGrid() {
  const activeMembers = useQuery(api.members.getActiveCount);
  const classCount = useQuery(api.classes.getCount);
  const openInvoices = useQuery(api.invoices.getUnpaidCount);
  const textableCount = useQuery(api.members.getTextableCount);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-4 gap-6">
      <StatCard label="Active Members" value={activeMembers} />
      <StatCard label="Classes Scheduled" value={classCount} />
      <StatCard label="Open Invoices" value={openInvoices} />
      {/* Same label and same number as the "Can be texted" badge on /members
          (both read members.ts:getTextableCount's isTextEligibleMember over
          the caller's roster) — deliberately not consent.ts:getConsentStats,
          which only counts public /consent/[gymSlug] form submissions and
          doesn't move when consent is recorded through the member modal or
          the bulk attestation panel, nor does it drop a submission that
          matched no roster member. See getConsentStats for why that number
          still exists as an audit trail. */}
      <StatCard label="Can be texted" value={textableCount} />
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
