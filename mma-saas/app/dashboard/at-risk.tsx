"use client";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

function daysAgo(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

export default function AtRiskPanel() {
  const atRisk = useQuery(api.members.getAtRiskMembers);

  if (atRisk === undefined) return null;

  return (
    <div
      className="mt-10 rounded-xl"
      style={{ border: "1px solid #333333", backgroundColor: "#111111" }}
    >
      <div
        className="flex items-center gap-3 px-6 py-4"
        style={{ borderBottom: "1px solid #333333" }}
      >
        <h2 className="text-base font-semibold" style={{ color: "#FFFFFF" }}>At Risk</h2>
        {atRisk.length > 0 && (
          <span
            className="text-xs font-bold px-2 py-0.5 rounded-full"
            style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
          >
            {atRisk.length}
          </span>
        )}
      </div>

      <div className="px-6 py-4">
        {atRisk.length === 0 ? (
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full inline-block" style={{ backgroundColor: "#4ADE80" }} />
            <p className="text-sm" style={{ color: "#4ADE80" }}>All members active</p>
          </div>
        ) : (
          <ul className="space-y-3">
            {atRisk.map((m) => (
              <li
                key={m._id}
                className="flex items-center justify-between py-3 px-4 rounded-lg"
                style={{ backgroundColor: "#1A1A1A", borderLeft: "3px solid #E02020" }}
              >
                <span className="text-sm font-medium" style={{ color: "#FFFFFF" }}>{m.name}</span>
                <span className="text-xs" style={{ color: "#888888" }}>
                  {m.lastVisit ? `${daysAgo(m.lastVisit)} days ago` : "Never checked in"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
