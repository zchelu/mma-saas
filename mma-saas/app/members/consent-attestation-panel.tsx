"use client";
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { ErrorToast, getErrorMessage } from "../components/error-toast";

type UnconfirmedMember = {
  _id: Id<"members">;
  name: string;
  phone: string;
  importBatchId?: string;
};

// Members imported before this field existed all share this bucket key —
// they're still attestable, just not attributable to a specific CSV run.
const NO_BATCH_KEY = "__no_batch__";

function groupByBatch(members: UnconfirmedMember[]): Map<string, UnconfirmedMember[]> {
  const groups = new Map<string, UnconfirmedMember[]>();
  for (const m of members) {
    const key = m.importBatchId ?? NO_BATCH_KEY;
    const existing = groups.get(key);
    if (existing) existing.push(m);
    else groups.set(key, [m]);
  }
  return groups;
}

export default function ConsentAttestationPanel() {
  const unconfirmed = useQuery(api.members.getUnconfirmedImportedMembers);
  const memberList = useMemo(() => (unconfirmed ?? []) as UnconfirmedMember[], [unconfirmed]);
  const groups = useMemo(() => groupByBatch(memberList), [memberList]);

  if (unconfirmed === undefined || memberList.length === 0) return null;

  return (
    <div
      className="rounded-xl mb-6 p-5"
      style={{ border: "1px solid #7A5B0A", backgroundColor: "#1A1400" }}
    >
      <p className="font-medium" style={{ color: "#FBBF24" }}>
        {memberList.length} imported member{memberList.length === 1 ? "" : "s"} need consent
        confirmed before they can be texted
      </p>
      <p className="text-xs mt-1 mb-4" style={{ color: "#A88A3A" }}>
        Imported members are never texted automatically — confirm, per import, that consent was
        actually obtained before enabling texting for them.
      </p>
      <div className="flex flex-col gap-4">
        {Array.from(groups.entries()).map(([key, members]) => (
          <ConsentBatchGroup
            key={key}
            batchId={key === NO_BATCH_KEY ? undefined : key}
            members={members}
          />
        ))}
      </div>
    </div>
  );
}

function ConsentBatchGroup({
  batchId,
  members,
}: {
  batchId?: string;
  members: UnconfirmedMember[];
}) {
  const attestBulkConsent = useMutation(api.members.attestBulkConsent);
  const [checked, setChecked] = useState(false);
  const [needsCheck, setNeedsCheck] = useState(false);
  const [saving, setSaving] = useState(false);
  const [attestError, setAttestError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    confirmed: number;
    skippedNoPhone: number;
    skippedAlreadyConfirmed: number;
  } | null>(null);

  const label = batchId ? "Import batch" : "Imported before batch tracking";

  async function handleConfirm() {
    if (!checked) {
      setNeedsCheck(true);
      return;
    }
    setSaving(true);
    setAttestError(null);
    try {
      const res = await attestBulkConsent({
        memberIds: members.map((m) => m._id),
        attested: true,
      });
      setResult(res);
    } catch (err) {
      setAttestError(getErrorMessage(err, "Couldn't confirm consent — try refreshing the page."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg p-4" style={{ backgroundColor: "#111111", border: "1px solid #333333" }}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium" style={{ color: "#FFFFFF" }}>
          {label} — {members.length} member{members.length === 1 ? "" : "s"}
        </span>
      </div>

      <ul
        className="text-xs mb-3 pl-0"
        style={{ color: "#888888", maxHeight: "8rem", overflowY: "auto", listStyle: "none" }}
      >
        {members.map((m) => (
          <li key={m._id}>
            {m.name} — {m.phone}
          </li>
        ))}
      </ul>

      {result ? (
        <p className="text-xs" style={{ color: "#4ADE80" }}>
          Confirmed consent for {result.confirmed} member{result.confirmed === 1 ? "" : "s"}.
          {result.skippedNoPhone > 0 && ` ${result.skippedNoPhone} skipped (no phone).`}
          {result.skippedAlreadyConfirmed > 0 &&
            ` ${result.skippedAlreadyConfirmed} were already confirmed.`}
        </p>
      ) : (
        <>
          <label
            className="flex items-start gap-2 text-xs mb-3"
            style={{ color: needsCheck && !checked ? "#F87171" : "#AAAAAA" }}
          >
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => {
                setChecked(e.target.checked);
                if (e.target.checked) setNeedsCheck(false);
              }}
              className="mt-0.5"
            />
            <span>
              I attest that each of these {members.length} members gave prior express written
              consent to receive automated SMS about their membership and attendance.
            </span>
          </label>

          {attestError && (
            <div className="mb-3">
              <ErrorToast message={attestError} />
            </div>
          )}

          <button
            onClick={handleConfirm}
            disabled={saving}
            className="rounded-lg text-xs font-semibold px-3 py-1.5 transition-colors"
            style={{ backgroundColor: "#E02020", color: "#FFFFFF", opacity: saving ? 0.6 : 1 }}
          >
            {saving ? "Confirming…" : `Confirm consent for ${members.length} member${members.length === 1 ? "" : "s"}`}
          </button>
        </>
      )}
    </div>
  );
}
