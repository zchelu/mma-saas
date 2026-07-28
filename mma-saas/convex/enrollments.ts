import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireGym, requireOwnClass, requireOwnMember, requireWriteAccess, tryGetReadableGym } from "./gyms";

export const getByClass = query({
  args: { classId: v.id("classes") },
  handler: async (ctx, { classId }) => {
    const gym = await tryGetReadableGym(ctx);
    if (!gym) return [];
    const cls = await ctx.db.get(classId);
    if (!cls || cls.gymId !== gym._id) return [];
    const enrollments = await ctx.db
      .query("enrollments")
      .withIndex("by_class", (q) => q.eq("classId", classId))
      .collect();
    const members = await Promise.all(
      enrollments.map(async (e) => {
        const member = await ctx.db.get(e.memberId);
        // Archived members (members.ts:archiveMember) drop out of the roster the
        // same way a deleted one does. The enrollment row is deliberately left
        // in place — archival is not a cascade delete — so this read is what
        // keeps a removed member off the class page, and with it out of the
        // attendance-logging UI that's driven by this list.
        return member && !member.archived ? { ...member, enrollmentId: e._id } : null;
      })
    );
    return members.filter((m): m is NonNullable<typeof m> => m !== null);
  },
});

export const getEnrollmentCounts = query({
  args: {},
  handler: async (ctx) => {
    const gym = await tryGetReadableGym(ctx);
    if (!gym) return {};
    const classes = await ctx.db
      .query("classes")
      .withIndex("by_gym", (q) => q.eq("gymId", gym._id))
      .collect();
    const classIds = new Set(classes.map((c) => c._id));
    // Archived members are excluded here for the same reason getByClass excludes
    // them, and it has to be both: this count is rendered on the classes list
    // while getByClass backs the roster on the class detail page, so filtering
    // only one of them would show "12 enrolled" above a list of 11 people.
    // Loaded as one set rather than a per-enrollment ctx.db.get to keep this off
    // an N+1 path.
    const archivedMemberIds = new Set(
      (
        await ctx.db
          .query("members")
          .withIndex("by_gym", (q) => q.eq("gymId", gym._id))
          .filter((q) => q.eq(q.field("archived"), true))
          .collect()
      ).map((m) => m._id)
    );
    const enrollments = await ctx.db.query("enrollments").collect();
    const counts: Record<string, number> = {};
    for (const e of enrollments) {
      if (classIds.has(e.classId) && !archivedMemberIds.has(e.memberId)) {
        counts[e.classId] = (counts[e.classId] ?? 0) + 1;
      }
    }
    return counts;
  },
});

export const enroll = mutation({
  args: { memberId: v.id("members"), classId: v.id("classes") },
  handler: async (ctx, { memberId, classId }) => {
    const gym = await requireGym(ctx);
    requireWriteAccess(gym);
    await Promise.all([
      requireOwnClass(ctx, gym._id, classId),
      requireOwnMember(ctx, gym._id, memberId),
    ]);
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
    const gym = await requireGym(ctx);
    requireWriteAccess(gym);
    await Promise.all([
      requireOwnClass(ctx, gym._id, classId),
      requireOwnMember(ctx, gym._id, memberId),
    ]);
    const enrollment = await ctx.db
      .query("enrollments")
      .withIndex("by_class", (q) => q.eq("classId", classId))
      .filter((q) => q.eq(q.field("memberId"), memberId))
      .first();
    if (enrollment) await ctx.db.delete(enrollment._id);
  },
});
