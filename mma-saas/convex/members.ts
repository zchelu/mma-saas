import { query, mutation, internalMutation } from "./_generated/server";
import { v } from "convex/values";

export const getAll = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("members").order("desc").collect();
  },
});

export const getActiveCount = query({
  args: {},
  handler: async (ctx) => {
    const active = await ctx.db
      .query("members")
      .filter((q) => q.eq(q.field("status"), "active"))
      .collect();
    return active.length;
  },
});

const memberFields = {
  name: v.string(),
  plan: v.string(),
  status: v.union(v.literal("active"), v.literal("inactive")),
  email: v.optional(v.string()),
  phone: v.optional(v.string()),
  beltRank: v.optional(v.string()),
};

export const add = mutation({
  args: memberFields,
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    return await ctx.db.insert("members", args);
  },
});

export const update = mutation({
  args: { id: v.id("members"), ...memberFields },
  handler: async (ctx, { id, ...fields }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    await ctx.db.patch(id, fields);
  },
});

export const remove = mutation({
  args: { id: v.id("members") },
  handler: async (ctx, { id }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const enrollments = await ctx.db.query("enrollments").withIndex("by_member", (q) => q.eq("memberId", id)).collect();
    for (const e of enrollments) await ctx.db.delete(e._id);
    const attendance = await ctx.db.query("attendance").withIndex("by_member", (q) => q.eq("memberId", id)).collect();
    for (const a of attendance) await ctx.db.delete(a._id);
    await ctx.db.delete(id);
  },
});

// No auth — intentionally public for the kiosk check-in screen
export const checkIn = mutation({
  args: { id: v.id("members") },
  handler: async (ctx, { id }) => {
    const now = Date.now();
    await ctx.db.patch(id, { lastVisit: new Date(now).toISOString(), status: "active", lastRetentionTextAt: undefined });
    await ctx.db.insert("checkIns", { memberId: id, timestamp: now });
  },
});

export const getCheckInHistory = query({
  args: { memberId: v.id("members") },
  handler: async (ctx, { memberId }) => {
    const rows = await ctx.db
      .query("checkIns")
      .withIndex("by_member", (q) => q.eq("memberId", memberId))
      .collect();
    return rows.sort((a, b) => b.timestamp - a.timestamp);
  },
});

export const getAtRiskMembers = query({
  args: {},
  handler: async (ctx) => {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const threshold = sevenDaysAgo.toISOString();
    const all = await ctx.db.query("members").collect();
    return all.filter(
      (m) => m.status === "active" && (!m.lastVisit || m.lastVisit < threshold)
    );
  },
});

export const markInactiveMembers = internalMutation({
  args: {},
  handler: async (ctx) => {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const threshold = thirtyDaysAgo.toISOString();
    const members = await ctx.db.query("members").collect();
    for (const member of members) {
      if (member.status === "active" && (!member.lastVisit || member.lastVisit < threshold)) {
        await ctx.db.patch(member._id, { status: "inactive" });
      }
    }
  },
});
