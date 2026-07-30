"use client";
import { useState, useMemo, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import AppHeader from "../../components/app-header";
import { ErrorToast, getErrorMessage } from "../../components/error-toast";

import { getInitials, getAvatarColor } from "../../lib/avatar";

// Local calendar date, NOT toISOString(). toISOString() is UTC, so for a
// Colorado gym every class after 6pm resolved to TOMORROW: a Monday 6:00 PM
// session logged itself under Tuesday. That silently corrupted Session History,
// and because getByClassAndDate keys on the date string, the real day always
// came back empty — so a coach could log the same session twice and see no
// "Logged" markers telling them they already had.
//
// Caught 2026-07-29 with the date field reading 07/30/2026 at 9pm Mountain.
// formatDate below already parses correctly, and winback-panel.tsx carries a
// comment warning against exactly this. Do not reintroduce a "Z"/UTC path here.
function today() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
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
  // Null until mounted. today() now reads the LOCAL calendar date, which the
  // server (UTC) and the browser (Mountain) disagree about all evening — so
  // computing it during render would swap a wrong-date bug for a hydration
  // mismatch. Deferring to the effect below means one clock, the coach's.
  const [attendanceDate, setAttendanceDate] = useState<string | null>(null);

  useEffect(() => {
    // Deliberate, same as the effect in dashboard/winback-panel.tsx: this is
    // the one case set-state-in-effect is wrong about, deferring a value that
    // MUST NOT be computed during SSR. The rule flags any direct setState in an
    // effect body — an empty dependency array is not an exemption. Block form,
    // because a -next-line directive only suppresses the literal next line and
    // putting rationale between it and the statement silences nothing.
    /* eslint-disable react-hooks/set-state-in-effect */
    setAttendanceDate(today());
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  const alreadyLogged = useQuery(
    api.attendance.getByClassAndDate,
    attendanceDate ? { classId, date: attendanceDate } : "skip"
  );
  const sessionDates = useQuery(api.attendance.getSessionDates, { classId });

  const enroll = useMutation(api.enrollments.enroll);
  const unenroll = useMutation(api.enrollments.unenroll);
  const logAttendance = useMutation(api.attendance.logAttendance);

  const alreadyLoggedIds = useMemo(
    () => new Set((alreadyLogged ?? []).map((r) => r.memberId)),
    [alreadyLogged]
  );

  // Who the coach has explicitly marked present. Starts EMPTY, deliberately.
  //
  // This used to seed to "every enrolled member who isn't already logged",
  // i.e. everyone pre-checked. That made the reflex action — open the class,
  // hit Save — mark the entire roster as having trained. logAttendance patches
  // lastVisit and status:"active" on each one, so every absentee got their
  // at-risk clock reset and never went cold. The retention engine this whole
  // product is built around would quietly never fire, and the dashboard would
  // look healthy the entire time. Checking people in matches what a coach
  // actually does (look at the mats and count); unchecking ghosts does not.
  // "Mark all present" below keeps the everyone-showed case to one tap.
  const [present, setPresent] = useState<Set<string>>(new Set());
  const [addMemberId, setAddMemberId] = useState("");
  const [savingAttendance, setSavingAttendance] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const enrolledIds = useMemo(
    () => new Set((enrolled ?? []).map((m) => m._id)),
    [enrolled]
  );

  const unenrolledMembers = useMemo(
    () => (allMembers ?? []).filter((m) => !enrolledIds.has(m._id)),
    [allMembers, enrolledIds]
  );

  // Enrolled members still awaiting a log for this date.
  const pending = useMemo(
    () => (enrolled ?? []).filter((m) => !alreadyLoggedIds.has(m._id)),
    [enrolled, alreadyLoggedIds]
  );

  // Derived, never stored. `enrolled` and `alreadyLogged` are live Convex
  // queries and the front-desk kiosk at /checkin writes attendance for this
  // same class and date — so a member badging in mid-session used to re-run a
  // seeding effect that replaced the whole selection and wiped every box the
  // coach had ticked. Keeping the coach's intent in `present` and subtracting
  // whatever has since been logged means an external write just quietly drops
  // that person off the pending list instead of resetting the screen.
  const checked = useMemo(() => {
    const s = new Set<string>();
    for (const id of present) {
      if (!alreadyLoggedIds.has(id as Id<"members">)) s.add(id);
    }
    return s;
  }, [present, alreadyLoggedIds]);

  const allPendingChecked = pending.length > 0 && pending.every((m) => checked.has(m._id as string));

  function toggleCheck(memberId: string) {
    setPresent((prev) => {
      const next = new Set(prev);
      if (next.has(memberId)) next.delete(memberId);
      else next.add(memberId);
      return next;
    });
  }

  function toggleAllPending() {
    setPresent(allPendingChecked ? new Set() : new Set(pending.map((m) => m._id as string)));
  }

  // Changing the date changes which session is being logged, so the coach's
  // in-progress selection is meaningless against the new one. Cleared here, in
  // the handler where the intent actually happens, rather than in an effect
  // watching the date — that is what kept this component honest and effect-free.
  function changeDate(next: string) {
    setAttendanceDate(next);
    setPresent(new Set());
  }

  async function handleEnroll() {
    if (!addMemberId) return;
    setActionError(null);
    try {
      await enroll({ memberId: addMemberId as Id<"members">, classId });
      setAddMemberId("");
    } catch (err) {
      setActionError(getErrorMessage(err, "Couldn't add that member — try refreshing the page."));
    }
  }

  async function handleUnenroll(memberId: Id<"members">) {
    if (!confirm("Remove this member from the class?")) return;
    setActionError(null);
    try {
      await unenroll({ memberId, classId });
    } catch (err) {
      setActionError(getErrorMessage(err, "Couldn't remove that member — try refreshing the page."));
    }
  }

  async function handleLogAttendance() {
    // Declared above the render guard, so attendanceDate is still string|null
    // here as far as the compiler is concerned. Unreachable in practice: the
    // Save button only exists after that guard has passed.
    if (attendanceDate === null) return;
    // `checked` already excludes anything logged since the coach ticked it.
    const newIds = [...checked] as Id<"members">[];
    if (newIds.length === 0) return;
    setSavingAttendance(true);
    setActionError(null);
    try {
      await logAttendance({ classId, date: attendanceDate, memberIds: newIds });
      // Those members are now "Logged" and render from alreadyLoggedIds, so
      // holding them in `present` would only let a later date change resurrect
      // a stale selection.
      setPresent(new Set());
    } catch (err) {
      setActionError(getErrorMessage(err, "Couldn't save attendance — try refreshing the page."));
    } finally {
      setSavingAttendance(false);
    }
  }

  // attendanceDate is null for the first paint only (see the effect above), so
  // everything below can treat it as a string.
  if (gymClass === undefined || enrolled === undefined || attendanceDate === null) {
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

        {actionError && <div className="mb-8"><ErrorToast message={actionError} /></div>}

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
              onChange={(e) => changeDate(e.target.value)}
              className="input w-44"
            />
            <button
              onClick={() => changeDate(today())}
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
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs" style={{ color: "#888888" }}>
                  Tap each member who trained.
                </span>
                {pending.length > 0 && (
                  <button
                    onClick={toggleAllPending}
                    className="text-xs transition-colors hover:text-white"
                    style={{ color: "#888888" }}
                  >
                    {allPendingChecked ? "Clear all" : "Mark all present"}
                  </button>
                )}
              </div>

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
                disabled={savingAttendance || checked.size === 0}
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
