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

import { getInitials, getAvatarColor } from "../lib/avatar";

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
  if (sortCol !== col) return <span className="ml-1 text-xs" style={{ color: "#555555" }}>↕</span>;
  return <span className="ml-1 text-xs" style={{ color: "#FFFFFF" }}>{sortDir === "asc" ? "↑" : "↓"}</span>;
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
    <div className="min-h-screen text-white" style={{ backgroundColor: "#0D0D0D" }}>
      <AppHeader />
      <main className="max-w-5xl mx-auto px-8 py-12">

        <div className="flex items-center justify-between mb-6">
          <h1 className="text-3xl" style={{ color: "#FFFFFF", fontWeight: 500 }}>Members</h1>
          <button
            onClick={() => setModal("add")}
            className="rounded-lg text-sm font-semibold px-4 py-2 transition-colors"
            style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
            onMouseEnter={e => (e.currentTarget.style.backgroundColor = "#B91C1C")}
            onMouseLeave={e => (e.currentTarget.style.backgroundColor = "#E02020")}
          >
            + Add Member
          </button>
        </div>

        {members !== undefined && (
          <div className="flex gap-6 mb-6 pb-6" style={{ borderBottom: "1px solid #333333" }}>
            <SummaryBadge value={total} label="Total" color="#FFFFFF" />
            <SummaryBadge value={activeCount} label="Active" color="#4ADE80" />
            <SummaryBadge value={inactiveCount} label="Inactive" color="#F87171" />
          </div>
        )}

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
            <option value="all">All Status</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </div>

        <div className="rounded-xl overflow-hidden" style={{ border: "1px solid #333333" }}>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wider" style={{ borderBottom: "1px solid #333333", backgroundColor: "#1A1A1A", color: "#555555" }}>
                <th
                  className="text-left px-6 py-3 cursor-pointer select-none hover:text-white transition-colors"
                  onClick={() => handleSort("name")}
                >
                  Name <SortIcon col="name" sortCol={sortCol} sortDir={sortDir} />
                </th>
                <th className="text-left px-6 py-3">Email</th>
                <th
                  className="text-left px-6 py-3 cursor-pointer select-none hover:text-white transition-colors"
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
                  <td colSpan={7} className="px-6 py-10 text-center" style={{ color: "#555555" }}>
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
                  <td colSpan={7} className="px-6 py-10 text-center" style={{ color: "#555555" }}>
                    No members match your search.
                  </td>
                </tr>
              ) : (
                filtered.map((m) => (
                  <tr
                    key={m._id}
                    className="transition-colors"
                    style={{ borderBottom: "1px solid #333333" }}
                    onMouseEnter={e => (e.currentTarget.style.backgroundColor = "#1A1A1A")}
                    onMouseLeave={e => (e.currentTarget.style.backgroundColor = "transparent")}
                  >
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${getAvatarColor(m.name)}`}>
                          {getInitials(m.name)}
                        </div>
                        <span className="font-medium" style={{ color: "#FFFFFF" }}>{m.name}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4" style={{ color: "#888888" }}>{m.email || "—"}</td>
                    <td className="px-6 py-4" style={{ color: "#888888" }}>{m.plan}</td>
                    <td className="px-6 py-4" style={{ color: "#888888" }}>{m.beltRank || "—"}</td>
                    <td className="px-6 py-4">
                      <span
                        className="inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold"
                        style={
                          m.status === "active"
                            ? { backgroundColor: "#0A2A14", color: "#4ADE80" }
                            : { backgroundColor: "#2A0A0A", color: "#F87171" }
                        }
                      >
                        {m.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-xs" style={{ color: "#888888" }}>
                      {m.lastVisit ? formatVisit(m.lastVisit) : "—"}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex gap-3 justify-end">
                        <button
                          onClick={() => setModal(m)}
                          className="text-xs transition-colors hover:text-white"
                          style={{ color: "#888888" }}
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDelete(m._id)}
                          className="text-xs transition-colors"
                          style={{ color: "#F87171" }}
                          onMouseEnter={e => (e.currentTarget.style.color = "#FCA5A5")}
                          onMouseLeave={e => (e.currentTarget.style.color = "#F87171")}
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

function SummaryBadge({ value, label, color }: { value: number; label: string; color: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-2xl font-bold" style={{ color }}>{value}</span>
      <span className="text-sm" style={{ color: "#555555" }}>{label}</span>
    </div>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center gap-4 py-20 text-center">
      <div className="w-14 h-14 rounded-full flex items-center justify-center" style={{ backgroundColor: "#222222" }}>
        <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} style={{ color: "#555555" }}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
        </svg>
      </div>
      <div>
        <p className="font-medium text-lg" style={{ color: "#FFFFFF" }}>No members yet</p>
        <p className="text-sm mt-1" style={{ color: "#555555" }}>Add your first member to get started</p>
      </div>
      <button
        onClick={onAdd}
        className="rounded-lg text-sm font-semibold px-4 py-2 transition-colors"
        style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
        onMouseEnter={e => (e.currentTarget.style.backgroundColor = "#B91C1C")}
        onMouseLeave={e => (e.currentTarget.style.backgroundColor = "#E02020")}
      >
        + Add Member
      </button>
    </div>
  );
}
