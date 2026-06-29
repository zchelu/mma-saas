"use client";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";

type Props = {
  memberId: Id<"members">;
  memberName: string;
  onClose: () => void;
};

function formatCheckIn(timestamp: number): string {
  const d = new Date(timestamp);
  return (
    d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }) +
    " — " +
    d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
  );
}

export default function CheckInHistoryDrawer({ memberId, memberName, onClose }: Props) {
  const history = useQuery(api.members.getCheckInHistory, { memberId });

  return (
    <>
      <div
        className="fixed inset-0 z-40"
        style={{ backgroundColor: "rgba(0,0,0,0.6)" }}
        onClick={onClose}
      />
      <div
        className="fixed right-0 top-0 h-full z-50 flex flex-col"
        style={{ width: 380, backgroundColor: "#111111", borderLeft: "1px solid #333333" }}
      >
        <div
          className="flex items-center justify-between px-6 py-5"
          style={{ borderBottom: "1px solid #333333" }}
        >
          <div>
            <p className="text-xs uppercase tracking-widest mb-1" style={{ color: "#555555" }}>
              Check-in History
            </p>
            <h2 className="text-lg font-semibold" style={{ color: "#FFFFFF" }}>{memberName}</h2>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors text-sm"
            style={{ color: "#888888", backgroundColor: "#1A1A1A" }}
            onMouseEnter={e => (e.currentTarget.style.color = "#FFFFFF")}
            onMouseLeave={e => (e.currentTarget.style.color = "#888888")}
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {history === undefined ? (
            <p className="text-sm" style={{ color: "#555555" }}>Loading…</p>
          ) : history.length === 0 ? (
            <p className="text-sm" style={{ color: "#555555" }}>No check-ins recorded yet</p>
          ) : (
            <ul className="space-y-3">
              {history.map((entry) => (
                <li
                  key={entry._id}
                  className="text-sm py-3 px-4 rounded-lg"
                  style={{
                    backgroundColor: "#1A1A1A",
                    color: "#CCCCCC",
                    borderLeft: "3px solid #E02020",
                  }}
                >
                  {formatCheckIn(entry.timestamp)}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
