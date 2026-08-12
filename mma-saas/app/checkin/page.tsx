"use client";
import { useState, useEffect, useMemo, Suspense } from "react";
import { useSearchParams } from "next/navigation";
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
  // The documents gate. A member whose gym has a waiver they haven't signed
  // is stopped here BEFORE the check-in is recorded — that ordering is the
  // point. Letting them train first and chase the signature later is exactly
  // the state a liability claim is about, and it is also how a gym rolls the
  // feature out and never gets its existing roster signed.
  | { type: "waiver"; member: Member }
  | { type: "success"; firstName: string };

import { getInitials, getAvatarColor } from "../lib/avatar";
import WaiverStep from "../components/waiver-step";
import { useLocalDate } from "../components/use-local-date";
// The tablet's own clock, never the server's — see lib/localDate.ts for the
// four times this has gone wrong in this codebase.
import { localDateString, localDayPrefix } from "@/lib/localDate";

export default function CheckInPage() {
  return (
    <Suspense fallback={null}>
      <CheckInPageInner />
    </Suspense>
  );
}

// Shape gate on the kiosk token in the URL, so an obviously-malformed bookmark
// fails soft here rather than as a server-side ArgumentValidationError that
// crashes the tablet. 24 hex characters — convex/gyms.ts:generateKioskToken.
//
// The URL used to carry the gym's raw document id. It no longer does: that made
// a bookmarked kiosk link sufficient to enumerate the roster and, through the
// documents endpoints, read every member's date of birth and home address. See
// the schema comment on gyms.kioskToken.
const KIOSK_TOKEN_SHAPE = /^[a-f0-9]{24}$/;

function CheckInPageInner() {
  const searchParams = useSearchParams();
  const rawToken = searchParams.get("k");
  const kioskToken = rawToken && KIOSK_TOKEN_SHAPE.test(rawToken) ? rawToken : null;

  const members = useQuery(
    api.members.getActiveForGym,
    kioskToken ? { kioskToken } : "skip"
  );
  const classes = useQuery(
    api.classes.listForKiosk,
    kioskToken ? { kioskToken } : "skip"
  );
  const checkIn = useMutation(api.members.checkIn);

  const [search, setSearch] = useState("");
  const [checkInError, setCheckInError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>({ type: "idle" });
  // What the front desk tapped. Sticky on purpose: set once when the 6pm class
  // starts, and every member arriving for it then taps only their own name.
  // Making each member pick a class would double the taps at the busiest
  // moment of the day and get ignored within a week.
  const [selectedClassId, setSelectedClassId] = useState<Id<"classes"> | null>(null);

  // dayOfWeek is free text the owner typed ("Monday", "Mon", "Mon/Wed",
  // "Tuesday & Thursday"), so match loosely on the three-letter prefix rather
  // than parsing. Structured scheduling is what automatic current-class
  // detection needs and is deliberately not part of this change.
  const todaysClasses = useMemo(() => {
    if (!classes) return [];
    const today = localDayPrefix();
    return classes
      .filter((c) => c.dayOfWeek.toLowerCase().includes(today))
      .sort((a, b) => a.time.localeCompare(b.time));
  }, [classes]);

  // DERIVED, NEVER STORED — same pattern as `checked` in
  // app/classes/[id]/page.tsx, and for the same reason.
  //
  // A tablet left running overnight, or an owner editing the schedule
  // mid-session, can leave a selection pointing at a class that is no longer
  // on today's list. Attributing tomorrow's check-ins to yesterday's class
  // would be silent and wrong.
  //
  // The obvious version of this — an effect that watches the selection and
  // resets it — is the react-hooks/set-state-in-effect anti-pattern, and this
  // is the case the rule is actually about: storing something that can simply
  // be computed. Deriving it also removes a render where the stale id is
  // still live. The eslint-disable in classes/[id]/page.tsx is NOT precedent
  // for suppressing it here; that one defers a value that must not be
  // computed during SSR, which is a different problem.
  const classId = useMemo(
    () =>
      selectedClassId && todaysClasses.some((c) => c._id === selectedClassId)
        ? selectedClassId
        : null,
    [selectedClassId, todaysClasses]
  );

  // The tablet's own calendar date — null during SSR, where "local" would be
  // the deployment's UTC. See lib/localDate.ts and use-local-date.ts.
  const today = useLocalDate();

  // Does the selected member still owe a signature? Queried only while a
  // member is selected, so the idle kiosk isn't polling anything. Skipped
  // entirely until `today` exists, because the answer depends on the date
  // (a member turning 18 today may need a different signer).
  const pendingDocs = useQuery(
    api.documents.getUnsignedRequiredDocs,
    stage.type === "selected" && kioskToken && today
      ? { kioskToken, memberId: stage.member._id, todayLocalDate: today }
      : "skip"
  );
  // `undefined` is "still loading", `null` is "member not found", and a gym
  // with no waiver configured returns an empty list — all three mean "don't
  // block the door". Only a non-empty list gates.
  const needsSignature = (pendingDocs?.documents.length ?? 0) > 0;

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
    if (!kioskToken) return;
    await checkIn({
      id: member._id,
      kioskToken,
      // Both optional server-side. A gym with no schedule, an open mat, or a
      // member arriving outside class hours all check in with neither.
      ...(classId ? { classId } : {}),
      localDate: localDateString(),
    });
    setStage({ type: "success", firstName: member.name.trim().split(/\s+/)[0] });
  }

  if (!kioskToken) {
    return (
      <div className="h-screen flex flex-col items-center justify-center text-center px-8" style={{ backgroundColor: "#0D0D0D" }}>
        <h1 className="text-3xl font-bold mb-3" style={{ color: "#FFFFFF" }}>Kiosk not configured</h1>
        <p className="text-lg max-w-md" style={{ color: "#888888" }}>
          This check-in page has no valid kiosk link. Get the current one from your
          dashboard under &ldquo;Your gym&apos;s links&rdquo; and bookmark this device to it —
          an old link stops working once the kiosk code is regenerated.
        </p>
      </div>
    );
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

  if (stage.type === "waiver") {
    const m = stage.member;
    return (
      <WaiverStep
        kioskToken={kioskToken}
        memberId={m._id}
        cancelLabel="Not now"
        // The door gates on REQUIRED documents only — the waiver. A photo
        // release must not stop a paying member mid-check-in; those are
        // collected at signup (app/kiosk/signup) instead.
        includeOptional={false}
        // Signed — now record the check-in that was blocked. Ordering matters:
        // the signature exists before the visit does. If the check-in itself
        // fails we fall back to the confirm screen with a message rather than
        // leaving the kiosk on "Finishing up…" forever with a signature saved
        // and no visit logged.
        onDone={() => {
          confirmCheckIn(m).catch(() => {
            setCheckInError(
              "Signature saved, but the check-in didn't go through. Tap Check In again."
            );
            setStage({ type: "selected", member: m });
          });
        }}
        onCancel={() => setStage({ type: "selected", member: m })}
      />
    );
  }

  if (stage.type === "selected") {
    const m = stage.member;
    return (
      <div className="h-screen flex flex-col items-center justify-center text-center px-8" style={{ backgroundColor: "#0D0D0D" }}>
        <button
          onClick={() => {
            setCheckInError(null);
            setStage({ type: "idle" });
          }}
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
        {checkInError && (
          <p
            className="text-lg mb-6 max-w-md px-4 py-3 rounded-xl"
            style={{ backgroundColor: "#2A0A0A", border: "1px solid #F87171", color: "#F87171" }}
          >
            {checkInError}
          </p>
        )}
        {needsSignature && (
          <p className="text-lg mb-6 max-w-md" style={{ color: "#FBBF24" }}>
            {m.name.trim().split(/\s+/)[0]} still needs to sign the {pendingDocs?.documents[0]?.title ?? "waiver"}.
          </p>
        )}
        <button
          onClick={() => {
            setCheckInError(null);
            if (needsSignature) {
              setStage({ type: "waiver", member: m });
              return;
            }
            confirmCheckIn(m).catch(() =>
              setCheckInError("That didn't go through — check the connection and try again.")
            );
          }}
          // Disabled only while the gate's answer is genuinely unknown. A
          // member must not be able to tap through the waiver check by being
          // faster than the query.
          disabled={pendingDocs === undefined}
          className="w-full max-w-sm rounded-2xl text-white text-2xl font-bold py-6 transition-all active:scale-95 disabled:opacity-50"
          style={{ backgroundColor: "#E02020" }}
          onMouseEnter={e => (e.currentTarget.style.backgroundColor = "#B91C1C")}
          onMouseLeave={e => (e.currentTarget.style.backgroundColor = "#E02020")}
        >
          {pendingDocs === undefined
            ? "Checking…"
            : needsSignature
            ? "Read & sign to check in"
            : "Check In"}
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

        {/* Set once by the front desk when a class starts; every member
            arriving for it then taps only their own name. Hidden entirely when
            nothing is scheduled today, so a gym that doesn't run a timetable
            never sees it. */}
        {todaysClasses.length > 0 && (
          <div className="mb-8">
            <p className="text-sm font-semibold uppercase tracking-widest mb-3" style={{ color: "#555555" }}>
              Class in session
            </p>
            <div className="flex flex-wrap gap-2">
              <ClassChip
                label="No class"
                selected={classId === null}
                onClick={() => setSelectedClassId(null)}
              />
              {todaysClasses.map((c) => (
                <ClassChip
                  key={c._id}
                  label={`${c.time} · ${c.name}`}
                  selected={classId === c._id}
                  onClick={() => setSelectedClassId(c._id)}
                />
              ))}
            </div>
          </div>
        )}

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

        {/* The other half of the kiosk. Same gym id, carried over so the
            tablet only ever has to be bookmarked once. */}
        <div className="mt-14 text-center">
          <a
            href={`/kiosk/signup?k=${kioskToken}`}
            className="inline-block rounded-2xl px-8 py-5 text-lg font-semibold"
            style={{ backgroundColor: "#222222", border: "1px solid #333333", color: "#888888" }}
          >
            New here? Sign up →
          </a>
        </div>
      </div>
    </div>
  );
}

function ClassChip({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      // Generous tap target: this is a tablet at a door, used by people with
      // gym bags in one hand.
      className="rounded-xl px-5 py-3 text-base font-semibold transition-all active:scale-95"
      style={{
        backgroundColor: selected ? "#E02020" : "#222222",
        border: `1px solid ${selected ? "#E02020" : "#333333"}`,
        color: selected ? "#FFFFFF" : "#888888",
      }}
    >
      {label}
    </button>
  );
}
