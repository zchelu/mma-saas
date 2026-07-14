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
      stripeCustomerId: gym?.stripeCustomerId ?? null,
      stripeSubscriptionId: gym?.stripeSubscriptionId ?? null,
    };
  },
});

export const updatePlanStatusByCustomer = mutation({
  args: { stripeCustomerId: v.string(), planStatus: v.string() },
  handler: async (ctx, { stripeCustomerId, planStatus }) => {
    const gym = await ctx.db
      .query("gyms")
      .withIndex("by_stripe_customer", (q) => q.eq("stripeCustomerId", stripeCustomerId))
      .unique();
    if (gym) {
      await ctx.db.patch(gym._id, { planStatus });
    }
  },
});

export function isProPlan(gym: { plan?: string; planStatus?: string } | null): boolean {
  return (
    !!gym &&
    (gym.plan === "pro" || gym.plan === "elite") &&
    gym.planStatus === "active"
  );
}

export const getGymById = internalQuery({
  args: { gymId: v.id("gyms") },
  handler: async (ctx, { gymId }) => {
    return await ctx.db.get(gymId);
  },
});

// Used by the retention-text cron dispatcher to fan out per gym instead of
// treating "any gym anywhere is Pro" as license to text every gym's members.
export const listProGyms = internalQuery({
  args: {},
  handler: async (ctx) => {
    const gyms = await ctx.db.query("gyms").collect();
    return gyms.filter(isProPlan);
  },
});
