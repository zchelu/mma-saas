"use client";
import { useState, useMemo, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import AppHeader from "../../components/app-header";

import { getInitials, getAvatarColor } from "../../lib/avatar";

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

  useEffect(() => {
    if (!enrolled) return;
    setChecked(new Set(
      enrolled
        .filter((m) => !alreadyLoggedIds.has(m._id))
        .map((m) => m._id as string)
    ));
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
    if (newIds.length === 0) return;
    setSavingAttendance(true);
    try {
      await logAttendance({ classId, date: attendanceDate, memberIds: newIds });
    } finally {
      setSavingAttendance(false);
    }
  }

  if (gymClass === undefined || enrolled === undefined) {
    return (
      <div className="min-h-screen text-white" style={{ backgroundColor: "#0D0D0D" }}>
        <AppHeader />
        <main className="max-w-3xl mx-auto px-8 py-12">
          <p style={{ color: "#555555" }}>Loading...</p>
        </main>
      </div>
    );
  }

  if (gymClass === null) {
    return (
      <div className="min-h-screen text-white" style={{ backgroundColor: "#0D0D0D" }}>
        <AppHeader />
        <main className="max-w-3xl mx-auto px-8 py-12">
          <p style={{ color: "#555555" }}>Class not found.</p>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen text-white" style={{ backgroundColor: "#0D0D0D" }}>
      <AppHeader />
      <main className="max-w-3xl mx-auto px-8 py-10">

        <button
          onClick={() => router.push("/classes")}
          className="text-sm mb-6 flex items-center gap-1 transition-colors hover:text-white"
          style={{ color: "#555555" }}
        >
          ← Classes
        </button>

        <div className="mb-10">
          <h1 className="text-3xl mb-1" style={{ color: "#FFFFFF", fontWeight: 500 }}>{gymClass.name}</h1>
          <p style={{ color: "#888888" }}>
            {gymClass.dayOfWeek} at {gymClass.time} · {gymClass.instructor}
          </p>
        </div>

        <Section title={`Enrolled Members (${enrolled.length})`}>
          {enrolled.length === 0 ? (
            <p className="text-sm py-4" style={{ color: "#555555" }}>No members enrolled yet.</p>
          ) : (
            <ul style={{ borderColor: "#333333" }} className="divide-y divide-[#333333]">
              {enrolled.map((m) => (
                <li key={m._id} className="flex items-center justify-between py-3">
                  <div className="flex items-center gap-3">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${getAvatarColor(m.name)}`}>
                      {getInitials(m.name)}
                    </div>
                    <div>
                      <p className="font-medium text-sm" style={{ color: "#FFFFFF" }}>{m.name}</p>
                      <p className="text-xs" style={{ color: "#555555" }}>{m.plan}{m.beltRank ? ` · ${m.beltRank}` : ""}</p>
                    </div>
                  </div>
                  <button
                    onClick={() => handleUnenroll(m._id as Id<"members">)}
                    className="text-xs transition-colors"
                    style={{ color: "#F87171" }}
                    onMouseEnter={e => (e.currentTarget.style.color = "#FCA5A5")}
                    onMouseLeave={e => (e.currentTarget.style.color = "#F87171")}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}

          {unenrolledMembers.length > 0 && (
            <div className="flex gap-2 mt-4 pt-4" style={{ borderTop: "1px solid #333333" }}>
              <select
                value={addMemberId}
                onChange={(e) => setAddMemberId(e.target.value)}
                className="input flex-1 text-sm"
              >
                <option value="">Select a member to add...</option>
                {unenrolledMembers.map((m) => (
                  <option key={m._id} value={m._id}>{m.name}</option>
                ))}
              </select>
              <button
                onClick={handleEnroll}
                disabled={!addMemberId}
                className="rounded-lg text-sm font-semibold px-4 py-2 transition-colors disabled:opacity-40"
                style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
                onMouseEnter={e => { if (addMemberId) e.currentTarget.style.backgroundColor = "#B91C1C"; }}
                onMouseLeave={e => (e.currentTarget.style.backgroundColor = "#E02020")}
              >
                Add
              </button>
            </div>
          )}
        </Section>

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
              className="text-xs transition-colors hover:text-white"
              style={{ color: "#888888" }}
            >
              Today
            </button>
          </div>

          {enrolled.length === 0 ? (
            <p className="text-sm" style={{ color: "#555555" }}>Enroll members first to log attendance.</p>
          ) : (
            <>
              <ul className="mb-5" style={{ borderColor: "#333333" }}>
                {enrolled.map((m) => {
                  const alreadyDone = alreadyLoggedIds.has(m._id as Id<"members">);
                  const isChecked = checked.has(m._id as string);
                  return (
                    <li
                      key={m._id}
                      className="flex items-center justify-between py-3 cursor-pointer"
                      style={{ borderBottom: "1px solid #333333" }}
                      onClick={() => !alreadyDone && toggleCheck(m._id as string)}
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className="w-5 h-5 rounded flex items-center justify-center"
                          style={{
                            border: alreadyDone
                              ? "1px solid #4ADE80"
                              : isChecked
                              ? "1px solid #E02020"
                              : "1px solid #555555",
                            backgroundColor: alreadyDone
                              ? "#0A2A14"
                              : isChecked
                              ? "#E02020"
                              : "transparent",
                          }}
                        >
                          {(alreadyDone || isChecked) && (
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3} style={{ color: alreadyDone ? "#4ADE80" : "#FFFFFF" }}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </div>
                        <span className="text-sm font-medium" style={{ color: "#FFFFFF" }}>{m.name}</span>
                      </div>
                      {alreadyDone && (
                        <span className="text-xs" style={{ color: "#4ADE80" }}>Logged</span>
                      )}
                    </li>
                  );
                })}
              </ul>

              <button
                onClick={handleLogAttendance}
                disabled={savingAttendance || [...checked].filter((id) => !alreadyLoggedIds.has(id as Id<"members">)).length === 0}
                className="w-full rounded-lg font-semibold py-2.5 text-sm transition-colors disabled:opacity-40"
                style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
                onMouseEnter={e => { if (!e.currentTarget.disabled) e.currentTarget.style.backgroundColor = "#B91C1C"; }}
                onMouseLeave={e => (e.currentTarget.style.backgroundColor = "#E02020")}
              >
                {savingAttendance ? "Saving..." : `Save Attendance (${checked.size} present)`}
              </button>
            </>
          )}
        </Section>

        <Section title="Session History">
          {!sessionDates || sessionDates.length === 0 ? (
            <p className="text-sm py-4" style={{ color: "#555555" }}>No sessions logged yet.</p>
          ) : (
            <ul>
              {sessionDates.map(({ date, count }) => (
                <li key={date} className="flex items-center justify-between py-3" style={{ borderBottom: "1px solid #333333" }}>
                  <span className="text-sm" style={{ color: "#FFFFFF" }}>{formatDate(date)}</span>
                  <span className="text-sm" style={{ color: "#888888" }}>{count} attended</span>
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
    <div className="mb-8 rounded-xl p-6" style={{ backgroundColor: "#222222", border: "1px solid #333333" }}>
      <h2 className="text-sm font-semibold uppercase tracking-wider mb-4" style={{ color: "#555555" }}>{title}</h2>
      {children}
    </div>
  );
}
