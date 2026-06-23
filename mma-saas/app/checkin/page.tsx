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

const AVATAR_COLORS = [
  "bg-blue-700", "bg-purple-700", "bg-emerald-700",
  "bg-rose-700", "bg-amber-700", "bg-cyan-700",
];

function getInitials(name: string) {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return (parts[0][0] ?? "?").toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function getAvatarColor(name: string) {
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffff;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

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

  // Success screen
  if (stage.type === "success") {
    return (
      <div className="h-screen bg-zinc-950 flex flex-col items-center justify-center text-center px-8">
        <div className="w-28 h-28 rounded-full bg-green-500/20 flex items-center justify-center mb-8">
          <svg
            className="w-14 h-14 text-green-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2.5}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h1 className="text-6xl font-extrabold text-white mb-4 tracking-tight">
          Welcome, {stage.firstName}!
        </h1>
        <p className="text-2xl text-zinc-400">Enjoy your training session.</p>
      </div>
    );
  }

  // Confirmation screen
  if (stage.type === "selected") {
    const m = stage.member;
    return (
      <div className="h-screen bg-zinc-950 flex flex-col items-center justify-center text-center px-8">
        <button
          onClick={() => setStage({ type: "idle" })}
          className="absolute top-8 left-8 text-zinc-400 hover:text-white text-xl flex items-center gap-2 transition-colors py-3 px-4 rounded-xl hover:bg-zinc-800"
        >
          ← Back
        </button>
        <div
          className={`w-28 h-28 rounded-full flex items-center justify-center text-4xl font-extrabold mb-6 ${getAvatarColor(m.name)}`}
        >
          {getInitials(m.name)}
        </div>
        <h2 className="text-5xl font-extrabold text-white mb-3 tracking-tight">{m.name}</h2>
        <p className="text-xl text-zinc-400 mb-14">
          {m.plan}{m.beltRank ? ` · ${m.beltRank}` : ""}
        </p>
        <button
          onClick={() => confirmCheckIn(m)}
          className="w-full max-w-sm rounded-2xl bg-green-500 hover:bg-green-400 active:scale-95 text-white text-2xl font-bold py-6 transition-all"
        >
          Check In
        </button>
      </div>
    );
  }

  // Idle / search screen
  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <div className="max-w-lg mx-auto px-6 pt-20 pb-10">
        <div className="text-center mb-14">
          <p className="text-zinc-500 text-sm font-semibold uppercase tracking-widest mb-3">
            MatFlow
          </p>
          <h1 className="text-5xl font-extrabold tracking-tight">Check In</h1>
        </div>

        <input
          type="text"
          placeholder="Search your name..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
          className="w-full rounded-2xl border border-zinc-700 bg-zinc-900 px-6 py-5 text-2xl text-white placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-white/20"
        />

        {results.length > 0 && (
          <div className="mt-4 flex flex-col gap-2">
            {results.map((m) => (
              <button
                key={m._id}
                onClick={() => setStage({ type: "selected", member: m })}
                className="flex items-center gap-5 w-full rounded-2xl border border-zinc-800 bg-zinc-900 px-6 py-5 hover:bg-zinc-800 hover:border-zinc-600 active:scale-[0.99] transition-all text-left"
              >
                <div
                  className={`w-14 h-14 rounded-full flex items-center justify-center text-lg font-bold shrink-0 ${getAvatarColor(m.name)}`}
                >
                  {getInitials(m.name)}
                </div>
                <div>
                  <p className="text-white text-xl font-semibold leading-tight">{m.name}</p>
                  <p className="text-zinc-500 text-base mt-0.5">
                    {m.plan}{m.beltRank ? ` · ${m.beltRank}` : ""}
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}

        {search.trim().length > 0 && results.length === 0 && members !== undefined && (
          <p className="text-center text-zinc-500 mt-10 text-xl">No active members found.</p>
        )}
      </div>
    </div>
  );
}
