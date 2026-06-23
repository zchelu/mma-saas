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
  handler: async (ctx, args) => ctx.db.insert("classes", args),
});

export const update = mutation({
  args: { id: v.id("classes"), ...classFields },
  handler: async (ctx, { id, ...fields }) => ctx.db.patch(id, fields),
});

export const remove = mutation({
  args: { id: v.id("classes") },
  handler: async (ctx, { id }) => ctx.db.delete(id),
});
