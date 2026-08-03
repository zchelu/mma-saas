import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireGym, requireOwnClass, requireOwnMember, requireWriteAccess, tryGetReadableGym } from "./gyms";
import { assertMaxArrayLength } from "./validate";

// Well above any real class roster — bounds the Promise.all fan-out below
// against a payload of thousands of ids in one call.
const MAX_ATTENDANCE_MEMBERS = 500;

// Who attended this class on this date — from BOTH paths.
//
// Two things record the same physical event and neither used to know about the
// other: a coach hitting "mark all present" writes attendance rows, and the
// front-desk kiosk writes checkIns. Only the first carried a classId, so a gym
// running the kiosk at the door — which is what we tell them to do — saw every
// class report zero attendance forever, no matter how full it was.
//
// Kiosk rows are matched on classId + localDate, the tablet's own calendar
// date, for the reason spelled out on checkIns.localDate in schema.ts: this
// deployment runs in UTC and an evening check-in would otherwise bucket onto
// the following day.
//
// Deduped by memberId, roll-call winning, because both paths firing for one
// person is normal — a member taps in at the door and the coach also marks the
// register. Counting them twice would inflate the one number a gym owner uses
// to judge whether a class is worth keeping on the timetable.
export const getByClassAndDate = query({
  args: { classId: v.id("classes"), date: v.string() },
  handler: async (ctx, { classId, date }) => {
    const gym = await tryGetReadableGym(ctx);
    if (!gym) return [];
    const cls = await ctx.db.get(classId);
    if (!cls || cls.gymId !== gym._id) return [];

    const rollCall = await ctx.db
      .query("attendance")
      .withIndex("by_class_date", (q) => q.eq("classId", classId).eq("date", date))
      .collect();

    const kiosk = await ctx.db
      .query("checkIns")
      .withIndex("by_class", (q) => q.eq("classId", classId))
      .collect();

    // Seeded with the roll-call members so those win, then added to as kiosk
    // rows are accepted — which also collapses a member who tapped in twice.
    const seen = new Set(rollCall.map((r) => r.memberId));
    const fromKiosk = kiosk
      .filter((c) => {
        if (c.localDate !== date || seen.has(c.memberId)) return false;
        seen.add(c.memberId);
        return true;
      })
      .map((c) => ({
        _id: c._id,
        _creationTime: c._creationTime,
        classId,
        memberId: c.memberId,
        date,
        checkedInAt: new Date(c.clientScannedAt ?? c.timestamp).toISOString(),
        source: "kiosk" as const,
      }));

    return [
      ...rollCall.map((r) => ({ ...r, source: "roll-call" as const })),
      ...fromKiosk,
    ];
  },
});

// Session History — counts both sources, for the same reason
// getByClassAndDate does. A gym running the kiosk at the door and never
// touching the roll-call screen would otherwise have an empty history for a
// class that has been full every week.
//
// Deduped per date by memberId so a member who taps in AND gets marked present
// counts once. Doing this per date rather than globally matters: the same
// member attending three weeks running is three sessions of one, not one.
export const getSessionDates = query({
  args: { classId: v.id("classes") },
  handler: async (ctx, { classId }) => {
    const gym = await tryGetReadableGym(ctx);
    if (!gym) return [];
    const cls = await ctx.db.get(classId);
    if (!cls || cls.gymId !== gym._id) return [];

    const [rollCall, kiosk] = await Promise.all([
      ctx.db
        .query("attendance")
        .withIndex("by_class", (q) => q.eq("classId", classId))
        .collect(),
      ctx.db
        .query("checkIns")
        .withIndex("by_class", (q) => q.eq("classId", classId))
        .collect(),
    ]);

    const byDate = new Map<string, Set<string>>();
    const add = (date: string | undefined, memberId: string) => {
      if (!date) return;
      const set = byDate.get(date) ?? new Set<string>();
      set.add(memberId);
      byDate.set(date, set);
    };
    for (const r of rollCall) add(r.date, r.memberId);
    // localDate, never a date derived from `timestamp` — this deployment runs
    // in UTC and an evening check-in would land on the following day, which is
    // the exact bug the comment at the top of app/classes/[id]/page.tsx
    // documents having already been fixed once on the roll-call side.
    for (const c of kiosk) add(c.localDate, c.memberId);

    return [...byDate.entries()]
      .map(([date, members]) => ({ date, count: members.size }))
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 10);
  },
});

export const getByMember = query({
  args: { memberId: v.id("members") },
  handler: async (ctx, { memberId }) => {
    const gym = await requireGym(ctx);
    await requireOwnMember(ctx, gym._id, memberId);
    return await ctx.db
      .query("attendance")
      .withIndex("by_member", (q) => q.eq("memberId", memberId))
      .order("desc")
      .collect();
  },
});

export const logAttendance = mutation({
  args: {
    classId: v.id("classes"),
    date: v.string(),
    memberIds: v.array(v.id("members")),
  },
  handler: async (ctx, { classId, date, memberIds }) => {
    const gym = await requireGym(ctx);
    requireWriteAccess(gym);
    assertMaxArrayLength(memberIds, MAX_ATTENDANCE_MEMBERS, "Member list");
    await requireOwnClass(ctx, gym._id, classId);
    await Promise.all(memberIds.map((memberId) => requireOwnMember(ctx, gym._id, memberId)));
    const checkedInAt = new Date().toISOString();
    for (const memberId of memberIds) {
      const existing = await ctx.db
        .query("attendance")
        .withIndex("by_class_date", (q) => q.eq("classId", classId).eq("date", date))
        .filter((q) => q.eq(q.field("memberId"), memberId))
        .first();
      if (!existing) {
        await ctx.db.insert("attendance", { classId, memberId, date, checkedInAt });
      }
      await ctx.db.patch(memberId, { lastVisit: checkedInAt, status: "active" });
    }
  },
});
