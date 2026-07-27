"use client";
import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// <input type="date"> wants/returns "YYYY-MM-DD" in the browser's own local
// time zone — using Date's numeric (year, month, day) constructor for both
// directions, never string-parsing with a "Z"/UTC offset, is what keeps an
// evening check-in on a boundary day in the right bucket for a Colorado gym.
function toDateInputValue(ms: number): string {
  const d = new Date(ms);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function startOfDayMs(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

function endOfDayMs(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
}

// daysToReturn is stored unrounded on purpose (see winbackRecoveries schema
// comment) — round only here, for display. Under one full day is called out
// as "same day" rather than "0 days": a member back in a few hours is the
// best possible outcome and "0 days" reads like a bug, not a win.
function formatDaysToReturn(days: number): string {
  if (days < 1) return "same day";
  const rounded = Math.round(days);
  return `${rounded} day${rounded === 1 ? "" : "s"}`;
}

export default function WinbackPanel({
  gymId,
  gymCreatedAt,
}: {
  gymId: Id<"gyms"> | null;
  gymCreatedAt: number | null;
}) {
  const defaultStart = gymCreatedAt ?? Date.now() - 90 * MS_PER_DAY;
  const [startDate, setStartDate] = useState(() => toDateInputValue(defaultStart));
  const [endDate, setEndDate] = useState(() => toDateInputValue(Date.now()));

  const startMs = startOfDayMs(startDate);
  const endMs = endOfDayMs(endDate);

  const report = useQuery(
    api.winbackReport.getWinbackRecoveries,
    gymId ? { gymId, startMs, endMs } : "skip"
  );

  return (
    <div className="rounded-xl p-6 mt-8" style={{ backgroundColor: "#222222", border: "1px solid #333333" }}>
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <h2 className="text-xl font-bold" style={{ color: "#FFFFFF" }}>Members Brought Back</h2>
        <div className="flex items-center gap-2 text-sm" style={{ color: "#888888" }}>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="rounded px-2 py-1"
            style={{ backgroundColor: "#111111", border: "1px solid #333333", color: "#FFFFFF" }}
          />
          <span>to</span>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="rounded px-2 py-1"
            style={{ backgroundColor: "#111111", border: "1px solid #333333", color: "#FFFFFF" }}
          />
        </div>
      </div>

      {report === undefined ? (
        <p style={{ color: "#888888" }}>Loading…</p>
      ) : (
        <>
          <p className="text-4xl font-bold mb-4" style={{ color: "#FFFFFF" }}>
            {report.count} {report.count === 1 ? "member" : "members"} brought back in this range
          </p>

          {report.recoveries.length > 0 && (
            <div className="flex flex-col gap-2">
              {report.recoveries.map((r) => (
                <div
                  key={r.memberId}
                  className="flex items-center justify-between rounded-lg px-4 py-3"
                  style={{ backgroundColor: "#1A1A1A" }}
                >
                  <span style={{ color: "#FFFFFF" }}>{r.name}</span>
                  <span style={{ color: "#888888" }}>
                    back {formatDaysToReturn(r.daysToReturn)} after text {r.attemptsUsed}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
