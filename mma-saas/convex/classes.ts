import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireGym, requireOwnClass, tryGetGym } from "./gyms";

const classFields = {
  name: v.string(),
  instructor: v.string(),
  dayOfWeek: v.string(),
  time: v.string(),
};

export const getAll = query({
  args: {},
  handler: async (ctx) => {
    const gym = await requireGym(ctx);
    return await ctx.db
      .query("classes")
      .withIndex("by_gym", (q) => q.eq("gymId", gym._id))
      .collect();
  },
});

export const getById = query({
  args: { id: v.id("classes") },
  handler: async (ctx, { id }) => {
    const gym = await requireGym(ctx);
    const cls = await ctx.db.get(id);
    if (!cls || cls.gymId !== gym._id) return null;
    return cls;
  },
});

export const getCount = query({
  args: {},
  handler: async (ctx) => {
    const gym = await tryGetGym(ctx);
    if (!gym) return 0;
    const classes = await ctx.db
      .query("classes")
      .withIndex("by_gym", (q) => q.eq("gymId", gym._id))
      .collect();
    return classes.length;
  },
});

export const add = mutation({
  args: classFields,
  handler: async (ctx, args) => {
    const gym = await requireGym(ctx);
    return ctx.db.insert("classes", { ...args, gymId: gym._id });
  },
});

export const update = mutation({
  args: { id: v.id("classes"), ...classFields },
  handler: async (ctx, { id, ...fields }) => {
    const gym = await requireGym(ctx);
    await requireOwnClass(ctx, gym._id, id);
    return ctx.db.patch(id, fields);
  },
});

export const remove = mutation({
  args: { id: v.id("classes") },
  handler: async (ctx, { id }) => {
    const gym = await requireGym(ctx);
    await requireOwnClass(ctx, gym._id, id);
    const enrollments = await ctx.db.query("enrollments").withIndex("by_class", (q) => q.eq("classId", id)).collect();
    for (const e of enrollments) await ctx.db.delete(e._id);
    const attendance = await ctx.db.query("attendance").withIndex("by_class", (q) => q.eq("classId", id)).collect();
    for (const a of attendance) await ctx.db.delete(a._id);
    await ctx.db.delete(id);
  },
});
