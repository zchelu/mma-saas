import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

const invoiceFields = {
  memberId: v.id("members"),
  amount: v.number(),
  status: v.union(v.literal("paid"), v.literal("unpaid")),
  dueDate: v.string(),
};

export const getAll = query({
  args: {},
  handler: async (ctx) => {
    const invoices = await ctx.db.query("invoices").collect();
    return await Promise.all(
      invoices.map(async (inv) => {
        const member = await ctx.db.get(inv.memberId);
        return { ...inv, memberName: member?.name ?? "Unknown Member" };
      })
    );
  },
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
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    return ctx.db.insert("invoices", args);
  },
});

export const update = mutation({
  args: { id: v.id("invoices"), ...invoiceFields },
  handler: async (ctx, { id, ...fields }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    return ctx.db.patch(id, fields);
  },
});

export const remove = mutation({
  args: { id: v.id("invoices") },
  handler: async (ctx, { id }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    return ctx.db.delete(id);
  },
});
