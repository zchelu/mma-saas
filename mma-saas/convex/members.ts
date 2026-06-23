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
    return await ctx.db.insert("members", args);
  },
});

export const update = mutation({
  args: { id: v.id("members"), ...memberFields },
  handler: async (ctx, { id, ...fields }) => {
    await ctx.db.patch(id, fields);
  },
});

export const remove = mutation({
  args: { id: v.id("members") },
  handler: async (ctx, { id }) => {
    await ctx.db.delete(id);
  },
});

export const checkIn = mutation({
  args: { id: v.id("members") },
  handler: async (ctx, { id }) => {
    await ctx.db.patch(id, { lastVisit: new Date().toISOString(), status: "active" });
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
