import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireGym, requireOwnMember, requireWriteAccess, tryGetGym } from "./gyms";
import { assertMaxLength, assertInRange } from "./validate";

const invoiceFields = {
  memberId: v.id("members"),
  amount: v.number(),
  status: v.union(v.literal("paid"), v.literal("unpaid")),
  dueDate: v.string(),
};

function validateInvoiceFields(fields: { amount: number; dueDate: string }) {
  assertInRange(fields.amount, 0, 1_000_000, "Amount");
  assertMaxLength(fields.dueDate, 40, "Due date");
}

export const getAll = query({
  args: {},
  handler: async (ctx) => {
    const gym = await requireGym(ctx);
    const invoices = await ctx.db
      .query("invoices")
      .withIndex("by_gym", (q) => q.eq("gymId", gym._id))
      .collect();
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
    const gym = await tryGetGym(ctx);
    if (!gym) return 0;
    const unpaid = await ctx.db
      .query("invoices")
      .withIndex("by_gym", (q) => q.eq("gymId", gym._id))
      .filter((q) => q.eq(q.field("status"), "unpaid"))
      .collect();
    return unpaid.length;
  },
});

export const add = mutation({
  args: invoiceFields,
  handler: async (ctx, args) => {
    const gym = await requireGym(ctx);
    requireWriteAccess(gym);
    validateInvoiceFields(args);
    await requireOwnMember(ctx, gym._id, args.memberId);
    return ctx.db.insert("invoices", { ...args, gymId: gym._id });
  },
});

export const update = mutation({
  args: { id: v.id("invoices"), ...invoiceFields },
  handler: async (ctx, { id, ...fields }) => {
    const gym = await requireGym(ctx);
    requireWriteAccess(gym);
    validateInvoiceFields(fields);
    const [existing] = await Promise.all([
      ctx.db.get(id),
      requireOwnMember(ctx, gym._id, fields.memberId),
    ]);
    if (!existing || existing.gymId !== gym._id) throw new Error("Invoice not found");
    return ctx.db.patch(id, fields);
  },
});

export const remove = mutation({
  args: { id: v.id("invoices") },
  handler: async (ctx, { id }) => {
    const gym = await requireGym(ctx);
    requireWriteAccess(gym);
    const existing = await ctx.db.get(id);
    if (!existing || existing.gymId !== gym._id) throw new Error("Invoice not found");
    return ctx.db.delete(id);
  },
});
