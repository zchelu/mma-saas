"use client";
import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";

type Member = {
  _id: Id<"members">;
  name: string;
  plan: string;
  status: "active" | "inactive";
  beltRank?: string;
};

type Stage =
  | { type: "idle" }
  | { type: "selected"; member: Member }
  | { type: "success"; firstName: string };

import { getInitials, getAvatarColor } from "../lib/avatar";

export default function CheckInPage() {
  const members = useQuery(api.members.getAll);
  const checkIn = useMutation(api.members.checkIn);

  const [search, setSearch] = useState("");
  const [stage, setStage] = useState<Stage>({ type: "idle" });

  useEffect(() => {
    if (stage.type !== "success") return;
    const t = setTimeout(() => {
      setStage({ type: "idle" });
      setSearch("");
    }, 2500);
    return () => clearTimeout(t);
  }, [stage]);

  const results = useMemo(() => {
    if (!members || search.trim().length === 0) return [];
    const q = search.toLowerCase();
    return (members as Member[])
      .filter((m) => m.status === "active" && m.name.toLowerCase().includes(q))
      .slice(0, 6);
  }, [members, search]);

  async function confirmCheckIn(member: Member) {
    await checkIn({ id: member._id });
    setStage({ type: "success", firstName: member.name.trim().split(/\s+/)[0] });
  }

  if (stage.type === "success") {
    return (
      <div className="h-screen flex flex-col items-center justify-center text-center px-8" style={{ backgroundColor: "#0D0D0D" }}>
        <div className="w-28 h-28 rounded-full flex items-center justify-center mb-8" style={{ backgroundColor: "rgba(74,222,128,0.1)" }}>
          <svg className="w-14 h-14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} style={{ color: "#4ADE80" }}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h1 className="text-6xl font-extrabold mb-4 tracking-tight" style={{ color: "#FFFFFF" }}>
          Welcome, {stage.firstName}!
        </h1>
        <p className="text-2xl" style={{ color: "#888888" }}>Enjoy your training session.</p>
      </div>
    );
  }

  if (stage.type === "selected") {
    const m = stage.member;
    return (
      <div className="h-screen flex flex-col items-center justify-center text-center px-8" style={{ backgroundColor: "#0D0D0D" }}>
        <button
          onClick={() => setStage({ type: "idle" })}
          className="absolute top-8 left-8 text-xl flex items-center gap-2 transition-colors py-3 px-4 rounded-xl"
          style={{ color: "#888888" }}
          onMouseEnter={e => {
            e.currentTarget.style.color = "#FFFFFF";
            e.currentTarget.style.backgroundColor = "#1A1A1A";
          }}
          onMouseLeave={e => {
            e.currentTarget.style.color = "#888888";
            e.currentTarget.style.backgroundColor = "transparent";
          }}
        >
          ← Back
        </button>
        <div className={`w-28 h-28 rounded-full flex items-center justify-center text-4xl font-extrabold mb-6 ${getAvatarColor(m.name)}`}>
          {getInitials(m.name)}
        </div>
        <h2 className="text-5xl font-extrabold mb-3 tracking-tight" style={{ color: "#FFFFFF" }}>{m.name}</h2>
        <p className="text-xl mb-14" style={{ color: "#888888" }}>
          {m.plan}{m.beltRank ? ` · ${m.beltRank}` : ""}
        </p>
        <button
          onClick={() => confirmCheckIn(m)}
          className="w-full max-w-sm rounded-2xl text-white text-2xl font-bold py-6 transition-all active:scale-95"
          style={{ backgroundColor: "#E02020" }}
          onMouseEnter={e => (e.currentTarget.style.backgroundColor = "#B91C1C")}
          onMouseLeave={e => (e.currentTarget.style.backgroundColor = "#E02020")}
        >
          Check In
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen text-white" style={{ backgroundColor: "#0D0D0D" }}>
      <div className="max-w-lg mx-auto px-6 pt-20 pb-10">
        <div className="text-center mb-14">
          <p className="text-sm font-semibold uppercase tracking-widest mb-3" style={{ color: "#E02020" }}>
            KombatDesk
          </p>
          <h1 className="text-5xl font-extrabold tracking-tight" style={{ color: "#FFFFFF" }}>Check In</h1>
        </div>

        <input
          type="text"
          placeholder="Search your name..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
          className="w-full rounded-2xl px-6 py-5 text-2xl text-white focus:outline-none"
          style={{
            backgroundColor: "#222222",
            border: "1px solid #333333",
            color: "#FFFFFF",
          }}
        />

        {results.length > 0 && (
          <div className="mt-4 flex flex-col gap-2">
            {results.map((m) => (
              <button
                key={m._id}
                onClick={() => setStage({ type: "selected", member: m })}
                className="flex items-center gap-5 w-full rounded-2xl px-6 py-5 active:scale-[0.99] transition-all text-left"
                style={{ backgroundColor: "#222222", border: "1px solid #333333" }}
                onMouseEnter={e => {
                  e.currentTarget.style.backgroundColor = "#1A1A1A";
                  e.currentTarget.style.borderColor = "#555555";
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.backgroundColor = "#222222";
                  e.currentTarget.style.borderColor = "#333333";
                }}
              >
                <div className={`w-14 h-14 rounded-full flex items-center justify-center text-lg font-bold shrink-0 ${getAvatarColor(m.name)}`}>
                  {getInitials(m.name)}
                </div>
                <div>
                  <p className="text-xl font-semibold leading-tight" style={{ color: "#FFFFFF" }}>{m.name}</p>
                  <p className="text-base mt-0.5" style={{ color: "#555555" }}>
                    {m.plan}{m.beltRank ? ` · ${m.beltRank}` : ""}
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}

        {search.trim().length > 0 && results.length === 0 && members !== undefined && (
          <p className="text-center mt-10 text-xl" style={{ color: "#555555" }}>No active members found.</p>
        )}
      </div>
    </div>
  );
}
