"use client";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

export default function StatsGrid() {
  const activeMembers = useQuery(api.members.getActiveCount);
  const classCount = useQuery(api.classes.getCount);
  const textableCount = useQuery(api.members.getTextableCount);

  // "Open Invoices" was removed here alongside the /invoices nav entry — see
  // the comment in app/components/app-header.tsx. It read
  // api.invoices.getUnpaidCount, a count of hand-entered rows nobody
  // maintains, and it linked the dashboard to a surface that cannot take a
  // payment. api.invoices.getUnpaidCount is left in place, uncalled, for the
  // Stripe Connect work that revives it.
  //
  // Grid is sm:grid-cols-3 to match the three remaining cards. Restore it to
  // 4 when a real billing stat returns.
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
      <StatCard label="Active Members" value={activeMembers} />
      <StatCard label="Classes Scheduled" value={classCount} />
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
