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

// Called from the dashboard the moment a Clerk-authenticated user reaches an
// authenticated page. Ensures every gym owner has a gyms row before any
// gymId-scoped query runs, independent of whether they've ever completed
// Stripe checkout — decouples multi-tenant scoping from billing state.
// Safe to call on every load: existing rows (matched by clerkUserId) are
// returned as-is, never duplicated or overwritten.
export const getOrCreateGym = mutation({
  args: { clerkUserId: v.string(), defaultName: v.optional(v.string()) },
  handler: async (ctx, { clerkUserId, defaultName }) => {
    const existing = await ctx.db
      .query("gyms")
      .withIndex("by_clerk_user", (q) => q.eq("clerkUserId", clerkUserId))
      .unique();
    if (existing) return existing;

    const gymId = await ctx.db.insert("gyms", {
      clerkUserId,
      name: defaultName ?? "My Gym",
      plan: "starter",
      planStatus: "inactive",
      createdAt: Date.now(),
    });
    return await ctx.db.get(gymId);
  },
});

// Identity-derived, not client-supplied — a plain clerkUserId arg here would
// let any authenticated caller read another gym's plan/Stripe IDs by calling
// this function directly with an arbitrary id.
export const getSubscription = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return { plan: null, planStatus: null, stripeCustomerId: null, stripeSubscriptionId: null };
    }
    const gym = await ctx.db
      .query("gyms")
      .withIndex("by_clerk_user", (q) => q.eq("clerkUserId", identity.subject))
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

export function isElitePlan(gym: { plan?: string; planStatus?: string } | null): boolean {
  return !!gym && gym.plan === "elite" && gym.planStatus === "active";
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
