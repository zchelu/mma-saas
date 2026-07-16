import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
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

// Called from the webhook for subscription events with no clerkUserId in
// metadata — a guest checkout. Creates or updates a gym row keyed only by
// stripeCustomerId; clerkUserId is attached later by claimGymByCustomer.
// Never touches clerkUserId on an existing row, since a claim may have
// already landed before this event does.
export const upsertUnclaimedSubscription = mutation({
  args: {
    stripeCustomerId: v.string(),
    stripeSubscriptionId: v.string(),
    plan: v.string(),
    planStatus: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("gyms")
      .withIndex("by_stripe_customer", (q) => q.eq("stripeCustomerId", args.stripeCustomerId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        stripeSubscriptionId: args.stripeSubscriptionId,
        plan: args.plan,
        planStatus: args.planStatus,
      });
    } else {
      await ctx.db.insert("gyms", {
        stripeCustomerId: args.stripeCustomerId,
        stripeSubscriptionId: args.stripeSubscriptionId,
        plan: args.plan,
        planStatus: args.planStatus,
        createdAt: Date.now(),
      });
    }
  },
});

// Public entry point for linking a guest checkout's paid subscription to the
// Clerk account created right after payment. Never trusts a client-supplied
// Stripe customer id — re-verifies the checkout session against Stripe
// itself server-side, so the caller can't hijack someone else's subscription
// by guessing/reusing an id. Called from app/welcome/page.tsx.
export const claimGymBySessionId = action({
  args: { sessionId: v.string() },
  handler: async (ctx, { sessionId }): Promise<{ gymId: string }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");

    const res = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
      { headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` } }
    );
    if (!res.ok) throw new Error("Could not verify checkout session");
    const session = await res.json();

    if (session.mode !== "subscription" || session.payment_status !== "paid") {
      throw new Error("Checkout session is not a completed subscription payment");
    }
    const stripeCustomerId =
      typeof session.customer === "string" ? session.customer : session.customer?.id;
    if (!stripeCustomerId) throw new Error("Checkout session has no customer");

    return await ctx.runMutation(internal.subscriptions.claimGymByCustomer, {
      clerkUserId: identity.subject,
      stripeCustomerId,
    });
  },
});

// Internal — unreachable from any client, only from claimGymBySessionId
// above, which has already verified the caller owns this checkout session.
export const claimGymByCustomer = internalMutation({
  args: { clerkUserId: v.string(), stripeCustomerId: v.string() },
  handler: async (ctx, { clerkUserId, stripeCustomerId }) => {
    const [gymByCustomer, gymByUser] = await Promise.all([
      ctx.db
        .query("gyms")
        .withIndex("by_stripe_customer", (q) => q.eq("stripeCustomerId", stripeCustomerId))
        .unique(),
      ctx.db
        .query("gyms")
        .withIndex("by_clerk_user", (q) => q.eq("clerkUserId", clerkUserId))
        .unique(),
    ]);

    if (gymByCustomer?.clerkUserId && gymByCustomer.clerkUserId !== clerkUserId) {
      throw new Error("This subscription is already linked to a different account.");
    }

    if (gymByUser) {
      // gymByUser is canonical — it may already own gymId-scoped members/
      // classes/invoices (e.g. from the getOrCreateGym dashboard-load race).
      // Fold Stripe fields onto it rather than the reverse. gymByCustomer,
      // if present, is guaranteed a bare billing shell (unclaimed rows never
      // get gym-scoped data written to them), so deleting it is safe.
      if (gymByCustomer && gymByCustomer._id !== gymByUser._id) {
        await ctx.db.patch(gymByUser._id, {
          stripeCustomerId: gymByCustomer.stripeCustomerId,
          stripeSubscriptionId: gymByCustomer.stripeSubscriptionId,
          plan: gymByCustomer.plan,
          planStatus: gymByCustomer.planStatus,
        });
        await ctx.db.delete(gymByCustomer._id);
      } else if (!gymByUser.stripeCustomerId) {
        await ctx.db.patch(gymByUser._id, { stripeCustomerId });
      }
      return { gymId: gymByUser._id };
    }

    if (gymByCustomer) {
      await ctx.db.patch(gymByCustomer._id, { clerkUserId });
      return { gymId: gymByCustomer._id };
    }

    // Webhook hasn't landed yet — create a placeholder; upsertUnclaimedSubscription
    // will find it by stripeCustomerId shortly and fill in plan/status without
    // touching clerkUserId.
    const gymId = await ctx.db.insert("gyms", {
      clerkUserId,
      stripeCustomerId,
      plan: "starter",
      planStatus: "inactive",
      createdAt: Date.now(),
    });
    return { gymId };
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
