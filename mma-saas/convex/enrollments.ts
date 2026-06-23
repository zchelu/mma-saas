import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const getByClass = query({
  args: { classId: v.id("classes") },
  handler: async (ctx, { classId }) => {
    const enrollments = await ctx.db
      .query("enrollments")
      .withIndex("by_class", (q) => q.eq("classId", classId))
      .collect();
    const members = await Promise.all(
      enrollments.map(async (e) => {
        const member = await ctx.db.get(e.memberId);
        return member ? { ...member, enrollmentId: e._id } : null;
      })
    );
    return members.filter((m): m is NonNullable<typeof m> => m !== null);
  },
});

export const getEnrollmentCounts = query({
  args: {},
  handler: async (ctx) => {
    const enrollments = await ctx.db.query("enrollments").collect();
    const counts: Record<string, number> = {};
    for (const e of enrollments) {
      counts[e.classId] = (counts[e.classId] ?? 0) + 1;
    }
    return counts;
  },
});

export const enroll = mutation({
  args: { memberId: v.id("members"), classId: v.id("classes") },
  handler: async (ctx, { memberId, classId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const existing = await ctx.db
      .query("enrollments")
      .withIndex("by_class", (q) => q.eq("classId", classId))
      .filter((q) => q.eq(q.field("memberId"), memberId))
      .first();
    if (existing) return existing._id;
    return await ctx.db.insert("enrollments", { memberId, classId });
  },
});

export const unenroll = mutation({
  args: { memberId: v.id("members"), classId: v.id("classes") },
  handler: async (ctx, { memberId, classId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const enrollment = await ctx.db
      .query("enrollments")
      .withIndex("by_class", (q) => q.eq("classId", classId))
      .filter((q) => q.eq(q.field("memberId"), memberId))
      .first();
    if (enrollment) await ctx.db.delete(enrollment._id);
  },
});
