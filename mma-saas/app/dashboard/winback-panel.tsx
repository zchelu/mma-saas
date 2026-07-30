"use client";
import { useEffect, useState } from "react";
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
  // Null until mounted, then filled in on the client. Both defaults depend on
  // "today", and today is not the same on both sides of the render: Vercel runs
  // UTC, a Colorado gym is UTC-6. Computed during render (which includes SSR
  // and useState lazy initializers), any load between 6pm and midnight Mountain
  // produced HTML carrying TOMORROW's date, then hydrated to today's — a
  // mismatch on both inputs and a wrong default range during exactly the
  // evening hours a gym owner is at the desk. Same class of bug as the trial
  // confirmation email's dates. Deferring to an effect means one clock, the
  // user's.
  const [startDate, setStartDate] = useState<string | null>(null);
  const [endDate, setEndDate] = useState<string | null>(null);

  useEffect(() => {
    // Deliberate, and the one case set-state-in-effect is wrong about:
    // deferring a value that MUST NOT be computed during SSR. Deriving these in
    // render is precisely what caused the hydration mismatch above. Block form
    // rather than -next-line because two calls need covering, and because a
    // -next-line directive only suppresses the literal next line — putting
    // explanatory prose between the directive and the statement silently
    // disables nothing, which is how this shipped broken the first time.
    /* eslint-disable react-hooks/set-state-in-effect */
    setStartDate(toDateInputValue(gymCreatedAt ?? Date.now() - 90 * MS_PER_DAY));
    setEndDate(toDateInputValue(Date.now()));
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [gymCreatedAt]);

  const ready = startDate !== null && endDate !== null;
  const startMs = ready ? startOfDayMs(startDate) : 0;
  const endMs = ready ? endOfDayMs(endDate) : 0;

  const report = useQuery(
    api.winbackReport.getWinbackRecoveries,
    gymId && ready ? { gymId, startMs, endMs } : "skip"
  );

  return (
    <div className="rounded-xl p-6 mt-8" style={{ backgroundColor: "#222222", border: "1px solid #333333" }}>
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <h2 className="text-xl font-bold" style={{ color: "#FFFFFF" }}>Members Brought Back</h2>
        <div className="flex items-center gap-2 text-sm" style={{ color: "#888888" }}>
          <input
            type="date"
            value={startDate ?? ""}
            onChange={(e) => setStartDate(e.target.value)}
            className="rounded px-2 py-1"
            style={{ backgroundColor: "#111111", border: "1px solid #333333", color: "#FFFFFF" }}
          />
          <span>to</span>
          <input
            type="date"
            value={endDate ?? ""}
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
