import { internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const upsertSubscription = mutation({
  args: {
    clerkUserId: v.string(),
    stripeCustomerId: v.string(),
    stripeSubscriptionId: v.string(),
    plan: v.string(),
    planStatus: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("gyms")
      .withIndex("by_clerk_user", (q) => q.eq("clerkUserId", args.clerkUserId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        stripeCustomerId: args.stripeCustomerId,
        stripeSubscriptionId: args.stripeSubscriptionId,
        plan: args.plan,
        planStatus: args.planStatus,
      });
    } else {
      await ctx.db.insert("gyms", {
        clerkUserId: args.clerkUserId,
        stripeCustomerId: args.stripeCustomerId,
        stripeSubscriptionId: args.stripeSubscriptionId,
        plan: args.plan,
        planStatus: args.planStatus,
      });
    }
  },
});

export const getSubscription = query({
  args: { clerkUserId: v.string() },
  handler: async (ctx, { clerkUserId }) => {
    const gym = await ctx.db
      .query("gyms")
      .withIndex("by_clerk_user", (q) => q.eq("clerkUserId", clerkUserId))
      .unique();
    return {
      plan: gym?.plan ?? null,
      planStatus: gym?.planStatus ?? null,
    };
  },
});

export const hasProGym = internalQuery({
  args: {},
  handler: async (ctx) => {
    const gym = await ctx.db
      .query("gyms")
      .filter((q) =>
        q.and(
          q.or(q.eq(q.field("plan"), "pro"), q.eq(q.field("plan"), "elite")),
          q.eq(q.field("planStatus"), "active")
        )
      )
      .first();
    return gym !== null;
  },
});
