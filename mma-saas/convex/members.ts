import { query, mutation, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { requireGym, tryGetGym } from "./gyms";

export const getAll = query({
  args: {},
  handler: async (ctx) => {
    const gym = await requireGym(ctx);
    return await ctx.db
      .query("members")
      .withIndex("by_gym", (q) => q.eq("gymId", gym._id))
      .order("desc")
      .collect();
  },
});

export const getActiveCount = query({
  args: {},
  handler: async (ctx) => {
    const gym = await tryGetGym(ctx);
    if (!gym) return 0;
    const active = await ctx.db
      .query("members")
      .withIndex("by_gym", (q) => q.eq("gymId", gym._id))
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
  smsConsentConfirmed: v.optional(v.boolean()),
  smsConsentConfirmedAt: v.optional(v.number()),
};

function assertSmsConsent(fields: { phone?: string; smsConsentConfirmed?: boolean }) {
  if (fields.phone && !fields.smsConsentConfirmed) {
    throw new Error("SMS consent must be confirmed before saving a phone number");
  }
}

export const add = mutation({
  args: memberFields,
  handler: async (ctx, args) => {
    const gym = await requireGym(ctx);
    assertSmsConsent(args);
    return await ctx.db.insert("members", { ...args, gymId: gym._id });
  },
});

export const update = mutation({
  args: { id: v.id("members"), ...memberFields },
  handler: async (ctx, { id, ...fields }) => {
    const gym = await requireGym(ctx);
    const existing = await ctx.db.get(id);
    if (!existing || existing.gymId !== gym._id) throw new Error("Member not found");
    assertSmsConsent(fields);
    await ctx.db.patch(id, fields);
  },
});

export const remove = mutation({
  args: { id: v.id("members") },
  handler: async (ctx, { id }) => {
    const gym = await requireGym(ctx);
    const existing = await ctx.db.get(id);
    if (!existing || existing.gymId !== gym._id) throw new Error("Member not found");
    const enrollments = await ctx.db.query("enrollments").withIndex("by_member", (q) => q.eq("memberId", id)).collect();
    for (const e of enrollments) await ctx.db.delete(e._id);
    const attendance = await ctx.db.query("attendance").withIndex("by_member", (q) => q.eq("memberId", id)).collect();
    for (const a of attendance) await ctx.db.delete(a._id);
    await ctx.db.delete(id);
  },
});

// No auth — public kiosk search, scoped by the gymId the kiosk page passes in.
export const getActiveForGym = query({
  args: { gymId: v.id("gyms") },
  handler: async (ctx, { gymId }) => {
    return await ctx.db
      .query("members")
      .withIndex("by_gym", (q) => q.eq("gymId", gymId))
      .filter((q) => q.eq(q.field("status"), "active"))
      .collect();
  },
});

// No auth — intentionally public for the kiosk check-in screen.
// gymId is required so a stale/spoofed member id from another gym can't be checked in
// through this gym's kiosk.
export const checkIn = mutation({
  args: { id: v.id("members"), gymId: v.id("gyms") },
  handler: async (ctx, { id, gymId }) => {
    const member = await ctx.db.get(id);
    if (!member || member.gymId !== gymId) throw new Error("Member not found");
    const now = Date.now();
    await ctx.db.patch(id, { lastVisit: new Date(now).toISOString(), status: "active", lastRetentionTextAt: undefined });
    await ctx.db.insert("checkIns", { memberId: id, timestamp: now });
  },
});

export const getCheckInHistory = query({
  args: { memberId: v.id("members") },
  handler: async (ctx, { memberId }) => {
    const gym = await requireGym(ctx);
    const member = await ctx.db.get(memberId);
    if (!member || member.gymId !== gym._id) throw new Error("Member not found");
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
    const gym = await tryGetGym(ctx);
    if (!gym) return [];
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const threshold = sevenDaysAgo.toISOString();
    const all = await ctx.db
      .query("members")
      .withIndex("by_gym", (q) => q.eq("gymId", gym._id))
      .collect();
    return all.filter(
      (m) => m.status === "active" && (!m.lastVisit || m.lastVisit < threshold)
    );
  },
});

// Global admin sweep across all gyms — safe unscoped: it only patches each
// member's own status based on their own lastVisit, never returns or compares
// data across gyms.
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
