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

// Public entry point for linking a checkout's paid subscription to the
// Clerk account — called from app/welcome/page.tsx for BOTH the guest path
// (account created right after payment) and an already-signed-in buyer
// (success_url now routes everyone through here, not straight to
// /dashboard). Never trusts a client-supplied Stripe customer id —
// re-verifies the checkout session against Stripe itself server-side, so
// the caller can't hijack someone else's subscription by guessing/reusing
// an id. Also expands the subscription on that same call and activates
// plan/planStatus immediately from it, rather than waiting on the
// customer.subscription.created webhook to land — that webhook is a
// separate async delivery from Stripe and can arrive after this request
// finishes, which was previously bouncing paying customers back to
// /pricing (dashboard requires planStatus === "active"). The webhook
// remains the source of truth for everything after this moment (renewals,
// cancellations, failed payments).
export const claimGymBySessionId = action({
  args: { sessionId: v.string() },
  handler: async (ctx, { sessionId }): Promise<{ gymId: string }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");

    const res = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=subscription`,
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

    const sub = session.subscription as
      | { id: string; status: string; items: { data: { price: { id: string } }[] } }
      | null;
    const proPriceId = process.env.STRIPE_PRO_PRICE_ID!;
    const elitePriceId = process.env.STRIPE_ELITE_PRICE_ID!;
    const priceId = sub?.items?.data?.[0]?.price?.id;
    const plan = priceId === elitePriceId ? "elite" : priceId === proPriceId ? "pro" : "starter";

    return await ctx.runMutation(internal.subscriptions.claimGymByCustomer, {
      clerkUserId: identity.subject,
      stripeCustomerId,
      stripeSubscriptionId: sub?.id,
      plan: sub ? plan : undefined,
      planStatus: sub?.status,
    });
  },
});

// Internal — unreachable from any client, only from claimGymBySessionId and
// claimGymByRecoveryToken above, which have already verified the caller owns
// this checkout/subscription. stripeSubscriptionId/plan/planStatus are
// optional: claimGymBySessionId always has them (freshly verified from
// Stripe on the same call); claimGymByRecoveryToken doesn't re-verify them
// and relies on whatever the webhook already wrote to gymByCustomer instead.
export const claimGymByCustomer = internalMutation({
  args: {
    clerkUserId: v.string(),
    stripeCustomerId: v.string(),
    stripeSubscriptionId: v.optional(v.string()),
    plan: v.optional(v.string()),
    planStatus: v.optional(v.string()),
  },
  handler: async (ctx, { clerkUserId, stripeCustomerId, stripeSubscriptionId, plan, planStatus }) => {
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

    // Freshly Stripe-verified fields (when present) always win over whatever
    // upsertUnclaimedSubscription may or may not have written yet.
    const billingFields = {
      stripeCustomerId,
      ...(stripeSubscriptionId ? { stripeSubscriptionId } : {}),
      ...(plan ? { plan } : {}),
      ...(planStatus ? { planStatus } : {}),
    };

    if (gymByUser) {
      // gymByUser is canonical — it may already own gymId-scoped members/
      // classes/invoices (e.g. from the getOrCreateGym dashboard-load race).
      // Fold Stripe fields onto it rather than the reverse. gymByCustomer,
      // if present, is guaranteed a bare billing shell (unclaimed rows never
      // get gym-scoped data written to them), so deleting it is safe.
      if (gymByCustomer && gymByCustomer._id !== gymByUser._id) {
        await ctx.db.patch(gymByUser._id, {
          stripeCustomerId,
          stripeSubscriptionId: stripeSubscriptionId ?? gymByCustomer.stripeSubscriptionId,
          plan: plan ?? gymByCustomer.plan,
          planStatus: planStatus ?? gymByCustomer.planStatus,
        });
        await ctx.db.delete(gymByCustomer._id);
      } else {
        await ctx.db.patch(gymByUser._id, billingFields);
      }
      return { gymId: gymByUser._id };
    }

    if (gymByCustomer) {
      await ctx.db.patch(gymByCustomer._id, { clerkUserId, ...billingFields });
      return { gymId: gymByCustomer._id };
    }

    // Neither row exists yet (webhook hasn't landed and, for the recovery-token
    // path, no fresh Stripe data was passed in either) — create a placeholder;
    // upsertUnclaimedSubscription will find it by stripeCustomerId shortly and
    // fill in plan/status without touching clerkUserId. billingFields' plan/
    // planStatus (when claimGymBySessionId already verified them) take priority.
    const gymId = await ctx.db.insert("gyms", {
      clerkUserId,
      stripeCustomerId,
      ...(stripeSubscriptionId ? { stripeSubscriptionId } : {}),
      plan: plan ?? "starter",
      planStatus: planStatus ?? "inactive",
      createdAt: Date.now(),
    });
    return { gymId };
  },
});

// Called from app/api/recover/route.ts after it has independently verified
// via the Stripe API that this email belongs to a paying customer. Storing
// the mapping here (rather than trusting a customerId embedded in the emailed
// link itself) means the token is opaque and single-use-checkable server-side.
export const createRecoveryToken = mutation({
  args: { token: v.string(), stripeCustomerId: v.string(), expiresAt: v.number() },
  handler: async (ctx, args) => {
    await ctx.db.insert("recoveryTokens", args);
  },
});

export const getRecoveryToken = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    return await ctx.db
      .query("recoveryTokens")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
  },
});

export const markRecoveryTokenUsed = internalMutation({
  args: { tokenId: v.id("recoveryTokens") },
  handler: async (ctx, { tokenId }) => {
    await ctx.db.patch(tokenId, { usedAt: Date.now() });
  },
});

// Public entry point for the "recover my purchase" flow (app/welcome/page.tsx
// with a ?token= param instead of ?session_id=). Mirrors claimGymBySessionId's
// trust model — the caller can't supply a stripeCustomerId directly, only an
// opaque single-use token that was emailed to the address on file with Stripe.
export const claimGymByRecoveryToken = action({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<{ gymId: string }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");

    const record = await ctx.runQuery(internal.subscriptions.getRecoveryToken, { token });
    if (!record) throw new Error("This recovery link is invalid.");
    if (record.usedAt) throw new Error("This recovery link has already been used.");
    if (record.expiresAt < Date.now()) throw new Error("This recovery link has expired.");

    // Claim first, only mark the token used once the claim actually succeeds
    // — otherwise a failure here (or two racing clicks) permanently burns a
    // single-use link without ever linking the account.
    const result = await ctx.runMutation(internal.subscriptions.claimGymByCustomer, {
      clerkUserId: identity.subject,
      stripeCustomerId: record.stripeCustomerId,
    });

    await ctx.runMutation(internal.subscriptions.markRecoveryTokenUsed, { tokenId: record._id });

    return result;
  },
});

// Called from the dashboard the moment a Clerk-authenticated user reaches an
// authenticated page. Ensures every gym owner has a gyms row before any
// gymId-scoped query runs, independent of whether they've ever completed
// Stripe checkout — decouples multi-tenant scoping from billing state.
// Safe to call on every load: existing rows (matched by clerkUserId) are
// returned as-is, never duplicated or overwritten.
//
// clerkUserId is identity-derived, not a client-supplied argument — a plain
// clerkUserId arg here would let any authenticated caller create or read
// another user's gym row by calling this function directly with an arbitrary
// id. Callers must pass a Convex auth token (see lib/convex-auth.ts) for
// ctx.auth.getUserIdentity() to resolve.
export const getOrCreateGym = mutation({
  args: { defaultName: v.optional(v.string()) },
  handler: async (ctx, { defaultName }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const clerkUserId = identity.subject;

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
