import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const getByClassAndDate = query({
  args: { classId: v.id("classes"), date: v.string() },
  handler: async (ctx, { classId, date }) => {
    return await ctx.db
      .query("attendance")
      .withIndex("by_class_date", (q) => q.eq("classId", classId).eq("date", date))
      .collect();
  },
});

export const getSessionDates = query({
  args: { classId: v.id("classes") },
  handler: async (ctx, { classId }) => {
    const records = await ctx.db
      .query("attendance")
      .withIndex("by_class", (q) => q.eq("classId", classId))
      .collect();
    const dateCounts: Record<string, number> = {};
    for (const r of records) {
      dateCounts[r.date] = (dateCounts[r.date] ?? 0) + 1;
    }
    return Object.entries(dateCounts)
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 10);
  },
});

export const getByMember = query({
  args: { memberId: v.id("members") },
  handler: async (ctx, { memberId }) => {
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
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
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
