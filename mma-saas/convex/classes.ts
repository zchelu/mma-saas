import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

const classFields = {
  name: v.string(),
  instructor: v.string(),
  dayOfWeek: v.string(),
  time: v.string(),
};

export const getAll = query({
  args: {},
  handler: async (ctx) => ctx.db.query("classes").collect(),
});

export const getById = query({
  args: { id: v.id("classes") },
  handler: async (ctx, { id }) => ctx.db.get(id),
});

export const getCount = query({
  args: {},
  handler: async (ctx) => (await ctx.db.query("classes").collect()).length,
});

export const add = mutation({
  args: classFields,
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    return ctx.db.insert("classes", args);
  },
});

export const update = mutation({
  args: { id: v.id("classes"), ...classFields },
  handler: async (ctx, { id, ...fields }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    return ctx.db.patch(id, fields);
  },
});

export const remove = mutation({
  args: { id: v.id("classes") },
  handler: async (ctx, { id }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const enrollments = await ctx.db.query("enrollments").withIndex("by_class", (q) => q.eq("classId", id)).collect();
    for (const e of enrollments) await ctx.db.delete(e._id);
    const attendance = await ctx.db.query("attendance").withIndex("by_class", (q) => q.eq("classId", id)).collect();
    for (const a of attendance) await ctx.db.delete(a._id);
    await ctx.db.delete(id);
  },
});
