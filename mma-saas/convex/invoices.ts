import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

const invoiceFields = {
  memberName: v.string(),
  amount: v.number(),
  status: v.union(v.literal("paid"), v.literal("unpaid")),
  dueDate: v.string(),
};

export const getAll = query({
  args: {},
  handler: async (ctx) => ctx.db.query("invoices").collect(),
});

export const getUnpaidCount = query({
  args: {},
  handler: async (ctx) => {
    const unpaid = await ctx.db
      .query("invoices")
      .filter((q) => q.eq(q.field("status"), "unpaid"))
      .collect();
    return unpaid.length;
  },
});

export const add = mutation({
  args: invoiceFields,
  handler: async (ctx, args) => ctx.db.insert("invoices", args),
});

export const update = mutation({
  args: { id: v.id("invoices"), ...invoiceFields },
  handler: async (ctx, { id, ...fields }) => ctx.db.patch(id, fields),
});

export const remove = mutation({
  args: { id: v.id("invoices") },
  handler: async (ctx, { id }) => ctx.db.delete(id),
});
