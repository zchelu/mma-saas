"use client";
import { useState, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import AppHeader from "../../components/app-header";

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

function today() {
  return new Date().toISOString().split("T")[0];
}

function formatDate(s: string) {
  const d = new Date(s + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

export default function ClassDetailPage() {
  const { id } = useParams<{ id: string }>();
  const classId = id as Id<"classes">;
  const router = useRouter();

  const gymClass = useQuery(api.classes.getById, { id: classId });
  const enrolled = useQuery(api.enrollments.getByClass, { classId });
  const allMembers = useQuery(api.members.getAll);
  const [attendanceDate, setAttendanceDate] = useState(today());
  const alreadyLogged = useQuery(api.attendance.getByClassAndDate, { classId, date: attendanceDate });
  const sessionDates = useQuery(api.attendance.getSessionDates, { classId });

  const enroll = useMutation(api.enrollments.enroll);
  const unenroll = useMutation(api.enrollments.unenroll);
  const logAttendance = useMutation(api.attendance.logAttendance);

  const alreadyLoggedIds = useMemo(
    () => new Set((alreadyLogged ?? []).map((r) => r.memberId)),
    [alreadyLogged]
  );

  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [addMemberId, setAddMemberId] = useState("");
  const [savingAttendance, setSavingAttendance] = useState(false);

  const enrolledIds = useMemo(
    () => new Set((enrolled ?? []).map((m) => m._id)),
    [enrolled]
  );

  const unenrolledMembers = useMemo(
    () => (allMembers ?? []).filter((m) => !enrolledIds.has(m._id)),
    [allMembers, enrolledIds]
  );

  // When enrolled list loads, pre-check everyone not already logged
  useMemo(() => {
    if (!enrolled) return;
    const preChecked = new Set(
      enrolled
        .filter((m) => !alreadyLoggedIds.has(m._id))
        .map((m) => m._id as string)
    );
    setChecked(preChecked);
  }, [enrolled, alreadyLoggedIds]);

  function toggleCheck(memberId: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(memberId)) next.delete(memberId);
      else next.add(memberId);
      return next;
    });
  }

  async function handleEnroll() {
    if (!addMemberId) return;
    await enroll({ memberId: addMemberId as Id<"members">, classId });
    setAddMemberId("");
  }

  async function handleUnenroll(memberId: Id<"members">) {
    if (!confirm("Remove this member from the class?")) return;
    await unenroll({ memberId, classId });
  }

  async function handleLogAttendance() {
    const newIds = [...checked].filter((id) => !alreadyLoggedIds.has(id as Id<"members">)) as Id<"members">[];
    if (newIds.length === 0 && checked.size === 0) return;
    setSavingAttendance(true);
    try {
      await logAttendance({
        classId,
        date: attendanceDate,
        memberIds: [...checked] as Id<"members">[],
      });
    } finally {
      setSavingAttendance(false);
    }
  }

  if (gymClass === undefined || enrolled === undefined) {
    return (
      <div className="min-h-screen bg-zinc-950 text-white">
        <AppHeader />
        <main className="max-w-3xl mx-auto px-8 py-12">
          <p className="text-zinc-500">Loading...</p>
        </main>
      </div>
    );
  }

  if (gymClass === null) {
    return (
      <div className="min-h-screen bg-zinc-950 text-white">
        <AppHeader />
        <main className="max-w-3xl mx-auto px-8 py-12">
          <p className="text-zinc-500">Class not found.</p>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <AppHeader />
      <main className="max-w-3xl mx-auto px-8 py-10">

        {/* Back + Header */}
        <button
          onClick={() => router.push("/classes")}
          className="text-zinc-500 hover:text-white text-sm mb-6 flex items-center gap-1 transition-colors"
        >
          ← Classes
        </button>

        <div className="mb-10">
          <h1 className="text-3xl font-bold mb-1">{gymClass.name}</h1>
          <p className="text-zinc-400">
            {gymClass.dayOfWeek} at {gymClass.time} · {gymClass.instructor}
          </p>
        </div>

        {/* Enrolled Members */}
        <Section title={`Enrolled Members (${enrolled.length})`}>
          {enrolled.length === 0 ? (
            <p className="text-zinc-500 text-sm py-4">No members enrolled yet.</p>
          ) : (
            <ul className="divide-y divide-zinc-800">
              {enrolled.map((m) => (
                <li key={m._id} className="flex items-center justify-between py-3">
                  <div className="flex items-center gap-3">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${getAvatarColor(m.name)}`}>
                      {getInitials(m.name)}
                    </div>
                    <div>
                      <p className="font-medium text-sm">{m.name}</p>
                      <p className="text-zinc-500 text-xs">{m.plan}{m.beltRank ? ` · ${m.beltRank}` : ""}</p>
                    </div>
                  </div>
                  <button
                    onClick={() => handleUnenroll(m._id as Id<"members">)}
                    className="text-xs text-red-500 hover:text-red-400 transition-colors"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Add member */}
          {unenrolledMembers.length > 0 && (
            <div className="flex gap-2 mt-4 pt-4 border-t border-zinc-800">
              <select
                value={addMemberId}
                onChange={(e) => setAddMemberId(e.target.value)}
                className="input flex-1 text-sm"
              >
                <option value="" style={{ background: "#27272a", color: "#fff" }}>Select a member to add...</option>
                {unenrolledMembers.map((m) => (
                  <option key={m._id} value={m._id} style={{ background: "#27272a", color: "#fff" }}>
                    {m.name}
                  </option>
                ))}
              </select>
              <button
                onClick={handleEnroll}
                disabled={!addMemberId}
                className="rounded-lg bg-white text-black text-sm font-semibold px-4 py-2 hover:bg-zinc-200 transition-colors disabled:opacity-40"
              >
                Add
              </button>
            </div>
          )}
        </Section>

        {/* Log Attendance */}
        <Section title="Log Attendance">
          <div className="flex items-center gap-3 mb-5">
            <input
              type="date"
              value={attendanceDate}
              onChange={(e) => setAttendanceDate(e.target.value)}
              className="input w-44"
            />
            <button
              onClick={() => setAttendanceDate(today())}
              className="text-xs text-zinc-400 hover:text-white transition-colors"
            >
              Today
            </button>
          </div>

          {enrolled.length === 0 ? (
            <p className="text-zinc-500 text-sm">Enroll members first to log attendance.</p>
          ) : (
            <>
              <ul className="divide-y divide-zinc-800 mb-5">
                {enrolled.map((m) => {
                  const alreadyDone = alreadyLoggedIds.has(m._id as Id<"members">);
                  const isChecked = checked.has(m._id as string);
                  return (
                    <li
                      key={m._id}
                      className="flex items-center justify-between py-3 cursor-pointer"
                      onClick={() => !alreadyDone && toggleCheck(m._id as string)}
                    >
                      <div className="flex items-center gap-3">
                        <div className={`w-5 h-5 rounded flex items-center justify-center border ${
                          alreadyDone
                            ? "bg-green-600 border-green-600"
                            : isChecked
                            ? "bg-white border-white"
                            : "border-zinc-600"
                        }`}>
                          {(alreadyDone || isChecked) && (
                            <svg className={`w-3 h-3 ${alreadyDone ? "text-white" : "text-black"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </div>
                        <span className="text-sm font-medium">{m.name}</span>
                      </div>
                      {alreadyDone && (
                        <span className="text-xs text-green-500">Logged</span>
                      )}
                    </li>
                  );
                })}
              </ul>

              <button
                onClick={handleLogAttendance}
                disabled={savingAttendance || checked.size === 0}
                className="w-full rounded-lg bg-white text-black font-semibold py-2.5 text-sm hover:bg-zinc-200 transition-colors disabled:opacity-40"
              >
                {savingAttendance ? "Saving..." : `Save Attendance (${checked.size} present)`}
              </button>
            </>
          )}
        </Section>

        {/* Session History */}
        <Section title="Session History">
          {!sessionDates || sessionDates.length === 0 ? (
            <p className="text-zinc-500 text-sm py-4">No sessions logged yet.</p>
          ) : (
            <ul className="divide-y divide-zinc-800">
              {sessionDates.map(({ date, count }) => (
                <li key={date} className="flex items-center justify-between py-3">
                  <span className="text-sm text-zinc-300">{formatDate(date)}</span>
                  <span className="text-sm text-zinc-400">{count} attended</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

      </main>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-8 rounded-xl border border-zinc-800 bg-zinc-900 p-6">
      <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-4">{title}</h2>
      {children}
    </div>
  );
}
