"use client";
import { useState, useMemo } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import AppHeader from "../components/app-header";
import MemberModal from "./member-modal";

type Member = {
  _id: Id<"members">;
  name: string;
  plan: string;
  status: "active" | "inactive";
  email?: string;
  phone?: string;
  beltRank?: string;
  lastVisit?: string;
};

type SortCol = "name" | "plan" | null;
type SortDir = "asc" | "desc";

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


function formatVisit(iso: string) {
  const d = new Date(iso);
  return (
    d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) +
    " at " +
    d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
  );
}

type ActiveSortCol = "name" | "plan";

function SortIcon({ col, sortCol, sortDir }: { col: ActiveSortCol; sortCol: SortCol; sortDir: SortDir }) {
  if (sortCol !== col) return <span className="text-zinc-600 ml-1 text-xs">↕</span>;
  return <span className="text-white ml-1 text-xs">{sortDir === "asc" ? "↑" : "↓"}</span>;
}

export default function MembersPage() {
  const members = useQuery(api.members.getAll);
  const remove = useMutation(api.members.remove);

  const [modal, setModal] = useState<null | "add" | Member>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");
  const [sortCol, setSortCol] = useState<SortCol>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  function handleSort(col: ActiveSortCol) {
    if (sortCol === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortCol(col);
      setSortDir("asc");
    }
  }

  const memberList = useMemo(() => (members ?? []) as Member[], [members]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return memberList
      .filter((m) => {
        const matchSearch =
          !q ||
          m.name.toLowerCase().includes(q) ||
          (m.email ?? "").toLowerCase().includes(q);
        const matchStatus = statusFilter === "all" || m.status === statusFilter;
        return matchSearch && matchStatus;
      })
      .sort((a, b) => {
        if (!sortCol) return 0;
        const aVal = (a[sortCol] ?? "").toLowerCase();
        const bVal = (b[sortCol] ?? "").toLowerCase();
        return aVal.localeCompare(bVal) * (sortDir === "asc" ? 1 : -1);
      });
  }, [memberList, search, statusFilter, sortCol, sortDir]);

  const total = memberList.length;
  const activeCount = memberList.filter((m) => m.status === "active").length;
  const inactiveCount = total - activeCount;

  async function handleDelete(id: Id<"members">) {
    if (!confirm("Delete this member?")) return;
    await remove({ id });
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <AppHeader />
      <main className="max-w-5xl mx-auto px-8 py-12">

        {/* Header row */}
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-3xl font-bold">Members</h1>
          <button
            onClick={() => setModal("add")}
            className="rounded-lg bg-white text-black text-sm font-semibold px-4 py-2 hover:bg-zinc-200 transition-colors"
          >
            + Add Member
          </button>
        </div>

        {/* Summary strip */}
        {members !== undefined && (
          <div className="flex gap-6 mb-6 border-b border-zinc-800 pb-6">
            <SummaryBadge value={total} label="Total" />
            <SummaryBadge value={activeCount} label="Active" color="text-green-400" />
            <SummaryBadge value={inactiveCount} label="Inactive" color="text-red-400" />
          </div>
        )}

        {/* Toolbar */}
        <div className="flex gap-3 mb-4">
          <input
            type="text"
            placeholder="Search by name or email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input flex-1 max-w-xs"
          />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
            className="input w-36"
          >
            <option value="all" style={{ background: "#27272a", color: "#fff" }}>All Status</option>
            <option value="active" style={{ background: "#27272a", color: "#fff" }}>Active</option>
            <option value="inactive" style={{ background: "#27272a", color: "#fff" }}>Inactive</option>
          </select>
        </div>

        {/* Table */}
        <div className="rounded-xl border border-zinc-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900 text-zinc-400 uppercase text-xs tracking-wider">
                <th
                  className="text-left px-6 py-3 cursor-pointer hover:text-white select-none"
                  onClick={() => handleSort("name")}
                >
                  Name <SortIcon col="name" sortCol={sortCol} sortDir={sortDir} />
                </th>
                <th className="text-left px-6 py-3">Email</th>
                <th
                  className="text-left px-6 py-3 cursor-pointer hover:text-white select-none"
                  onClick={() => handleSort("plan")}
                >
                  Plan <SortIcon col="plan" sortCol={sortCol} sortDir={sortDir} />
                </th>
                <th className="text-left px-6 py-3">Belt</th>
                <th className="text-left px-6 py-3">Status</th>
                <th className="text-left px-6 py-3">Last Visit</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody>
              {members === undefined ? (
                <tr>
                  <td colSpan={7} className="px-6 py-10 text-center text-zinc-500">
                    Loading…
                  </td>
                </tr>
              ) : memberList.length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    <EmptyState onAdd={() => setModal("add")} />
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-10 text-center text-zinc-500">
                    No members match your search.
                  </td>
                </tr>
              ) : (
                filtered.map((m) => (
                  <tr
                    key={m._id}
                    className="border-b border-zinc-800 last:border-0 hover:bg-zinc-900/50 transition-colors"
                  >
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div
                          className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${getAvatarColor(m.name)}`}
                        >
                          {getInitials(m.name)}
                        </div>
                        <span className="font-medium">{m.name}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-zinc-400">{m.email || "—"}</td>
                    <td className="px-6 py-4 text-zinc-400">{m.plan}</td>
                    <td className="px-6 py-4 text-zinc-400">{m.beltRank || "—"}</td>
                    <td className="px-6 py-4">
                      <span
                        className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                          m.status === "active"
                            ? "bg-green-900 text-green-400"
                            : "bg-red-900 text-red-400"
                        }`}
                      >
                        {m.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-zinc-400 text-xs">
                      {m.lastVisit ? formatVisit(m.lastVisit) : "—"}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex gap-3 justify-end">
                        <button
                          onClick={() => setModal(m)}
                          className="text-xs text-zinc-400 hover:text-white transition-colors"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDelete(m._id)}
                          className="text-xs text-red-500 hover:text-red-400 transition-colors"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </main>

      {modal !== null && (
        <MemberModal
          member={modal === "add" ? undefined : modal}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

function SummaryBadge({
  value,
  label,
  color = "text-white",
}: {
  value: number;
  label: string;
  color?: string;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className={`text-2xl font-bold ${color}`}>{value}</span>
      <span className="text-zinc-500 text-sm">{label}</span>
    </div>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center gap-4 py-20 text-center">
      <div className="w-14 h-14 rounded-full bg-zinc-800 flex items-center justify-center">
        <svg
          className="w-7 h-7 text-zinc-500"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z"
          />
        </svg>
      </div>
      <div>
        <p className="text-zinc-300 font-medium text-lg">No members yet</p>
        <p className="text-zinc-500 text-sm mt-1">Add your first member to get started</p>
      </div>
      <button
        onClick={onAdd}
        className="rounded-lg bg-white text-black text-sm font-semibold px-4 py-2 hover:bg-zinc-200 transition-colors"
      >
        + Add Member
      </button>
    </div>
  );
}
