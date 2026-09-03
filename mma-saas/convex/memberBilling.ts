// Member dues — the database half. Stage 4 of the Connect member-billing build
// (spec §5.4).
//
// The Stripe calls live in convex/memberBillingStripe.ts, which must be a
// "use node" module for the SDK. Convex allows only ACTIONS there, so every
// query and mutation lives here. Same split as connect.ts / connectOnboarding.ts
// and gymPlans.ts / gymPlansStripe.ts.
//
// THE NAMING RULE (spec §2): every identifier belonging to a gym's CONNECTED
// account is stripeConnect*, locals included. `gyms.stripeCustomerId` is the
// PLATFORM account — this gym's own KombatDesk subscription — and
// `gyms.by_stripe_customer` backs subscriptions.updatePlanStatusByCustomer. A
// bare `stripeCustomerId` on members would sit one table away from a lookup
// that could flip a gym's SaaS plan status from a member's dues event. That is
// the cross-contamination this whole spec exists to prevent.
//
// NOTHING HERE TALKS TO STRIPE, and that is deliberate: every mutation below is
// a mirror of a fact Stripe already confirmed, never the origin of one. The one
// exception is planId, which is ours.
import { query, internalQuery, internalMutation } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { requireGym, tryGetGym } from "./gyms";

// Stripe's subscription vocabulary, narrowed to the states we act on. Must
// agree with schema.ts:members.duesStatus.
export const duesStatus = v.union(
  v.literal("active"),
  v.literal("past_due"),
  v.literal("canceled"),
  v.literal("unpaid")
);

// Resolves a member for a billing operation, or null.
//
// TWO checks, not one. `members.gymId` is OPTIONAL — the optional-until-
// backfilled pattern (see the schema comment on members.gymId and
// convex/migrations.ts) — so a row predating the backfill has no gym at all.
// `member.gymId !== gymId` already rejects undefined, but the distinction
// matters to the caller: an unbackfilled member is not someone else's member,
// it is a member nobody can bill until migrations run. The action turns that
// into a message an owner can act on rather than "not found".
//
// A member id is NOT a capability. It arrives from a browser, so every function
// taking one re-checks it against the caller's own gym — the same reasoning as
// gymPlans.getPlanForGym, and the property convex/gymPlans.test.ts pins.
export const getMemberForBilling = internalQuery({
  args: { gymId: v.id("gyms"), memberId: v.id("members") },
  handler: async (ctx, { gymId, memberId }) => {
    const member = await ctx.db.get(memberId);
    if (!member) return null;
    if (!member.gymId) return null;
    if (member.gymId !== gymId) return null;
    return member;
  },
});

// The plan a member is on, read back for the action. Returns null if the plan
// was archived or belongs to another gym — the action must not create a
// subscription against either.
export const getMemberPlan = internalQuery({
  args: { gymId: v.id("gyms"), memberId: v.id("members") },
  handler: async (ctx, { gymId, memberId }) => {
    const member = await ctx.db.get(memberId);
    if (!member || member.gymId !== gymId || !member.planId) return null;
    const plan = await ctx.db.get(member.planId);
    if (!plan || plan.gymId !== gymId || !plan.active) return null;
    return plan;
  },
});

// What the member's billing drawer renders.
//
// tryGetGym, not requireGym — read through useQuery from a "use client"
// component, so it fires before Clerk hydrates. Null means "not ready, no gym,
// or not your member" and the drawer renders its empty state.
//
// NARROWED FIELD MAP. No stripeConnect* identifier goes over the wire; the
// browser needs to know only WHETHER a customer and a subscription exist, which
// is what the two booleans carry. Same discipline as gymPlans.listPlans and
// members.getAtRiskMembers.
//
// `hasCustomer && !hasSubscription` IS the "payment link sent, no card yet"
// state. It is derived rather than stored on purpose — a stored flag would be a
// third source of truth about a fact Stripe already owns, and it would go stale
// the moment a member completes checkout while nobody is looking.
export const getMemberBillingState = query({
  args: { memberId: v.id("members") },
  handler: async (ctx, { memberId }) => {
    const gym = await tryGetGym(ctx);
    if (!gym) return null;
    const member = await ctx.db.get(memberId);
    if (!member || member.gymId !== gym._id) return null;

    const plan = member.planId ? await ctx.db.get(member.planId) : null;
    const planIsOurs = plan && plan.gymId === gym._id ? plan : null;

    return {
      // Whether the gym can bill at all. The drawer uses this to explain WHY
      // the actions are unavailable instead of showing dead buttons.
      connectReady: !!gym.stripeConnectAccountId && (gym.connectChargesEnabled ?? false),
      // Unbackfilled members cannot be billed — see getMemberForBilling.
      billable: !!member.gymId,
      planId: planIsOurs?._id ?? null,
      planName: planIsOurs?.name ?? null,
      planAmountCents: planIsOurs?.amountCents ?? null,
      planInterval: planIsOurs?.interval ?? null,
      planBillable: !!planIsOurs?.stripeConnectPriceId,
      hasCustomer: !!member.stripeConnectCustomerId,
      hasSubscription: !!member.stripeConnectSubscriptionId,
      duesStatus: member.duesStatus ?? null,
      duesFailedAt: member.duesFailedAt ?? null,
      duesFailureCount: member.duesFailureCount ?? 0,
    };
  },
});

// Assigns the plan. Ours to decide, so this one IS an origin of fact.
//
// Refuses while a subscription is live. Changing planId under a running
// subscription would leave the row claiming one price and Stripe billing
// another, and the owner would have no way to see the disagreement. The
// subscription has to be moved at Stripe first, which is
// memberBillingStripe.changeMemberPlan's job; it calls this afterwards.
export const setMemberPlanId = internalMutation({
  args: {
    gymId: v.id("gyms"),
    memberId: v.id("members"),
    planId: v.union(v.id("gymPlans"), v.null()),
    // Set by changeMemberPlan once Stripe has confirmed the move.
    allowWhileSubscribed: v.optional(v.boolean()),
  },
  handler: async (ctx, { gymId, memberId, planId, allowWhileSubscribed }) => {
    const member = await ctx.db.get(memberId);
    if (!member || member.gymId !== gymId) {
      throw new Error(`No member ${memberId} for gym ${gymId}`);
    }
    if (member.stripeConnectSubscriptionId && !allowWhileSubscribed) {
      throw new ConvexError(
        "This member already has dues running. Change the plan from the billing panel so Stripe is updated too."
      );
    }
    if (planId !== null) {
      const plan = await ctx.db.get(planId);
      if (!plan || plan.gymId !== gymId || !plan.active) {
        throw new ConvexError("That plan no longer exists.");
      }
    }
    await ctx.db.patch(memberId, { planId: planId ?? undefined });
  },
});

// Records the connected-account Customer id, first write wins, and reports
// which way it went.
//
// Exactly the shape of connect.ts:claimStripeConnectAccountId, for exactly the
// same reason: creating the Customer at Stripe and storing its id cannot be one
// transaction, so two rapid clicks can both create one. Making the STORE the
// point of resolution means the loser is told it lost and gets back the id that
// actually stuck, and the orphaned Customer is logged rather than overwriting a
// member's real one — which would strand any card already attached to it.
export const claimMemberStripeConnectCustomerId = internalMutation({
  args: {
    gymId: v.id("gyms"),
    memberId: v.id("members"),
    stripeConnectCustomerId: v.string(),
  },
  handler: async (ctx, { gymId, memberId, stripeConnectCustomerId }) => {
    const member = await ctx.db.get(memberId);
    if (!member || member.gymId !== gymId) {
      throw new Error(`No member ${memberId} for gym ${gymId}`);
    }
    if (member.stripeConnectCustomerId) {
      return {
        stored: false as const,
        stripeConnectCustomerId: member.stripeConnectCustomerId,
      };
    }
    await ctx.db.patch(memberId, { stripeConnectCustomerId });
    return { stored: true as const, stripeConnectCustomerId };
  },
});

// Mirrors a subscription Stripe has confirmed.
//
// Called from the connected-account webhook and from the action that creates
// the subscription. Idempotent by construction: the same event delivered twice
// writes the same row, which matters because Stripe retries and
// stripeConnectWebhookEvents only dedupes for 30 days.
//
// duesFailureCount is CLEARED on an active status, not decremented. It counts
// consecutive failures — that is what makes it a ranking signal worth trusting
// in getAtRiskMembers (spec §6) rather than a lifetime tally that only ever
// grows.
export const setMemberDuesSubscription = internalMutation({
  args: {
    gymId: v.id("gyms"),
    memberId: v.id("members"),
    stripeConnectSubscriptionId: v.string(),
    status: duesStatus,
  },
  handler: async (ctx, { gymId, memberId, stripeConnectSubscriptionId, status }) => {
    const member = await ctx.db.get(memberId);
    if (!member || member.gymId !== gymId) {
      throw new Error(`No member ${memberId} for gym ${gymId}`);
    }
    await ctx.db.patch(memberId, {
      stripeConnectSubscriptionId,
      duesStatus: status,
      ...(status === "active" ? { duesFailedAt: undefined, duesFailureCount: 0 } : {}),
    });
  },
});

// Records a failed dues payment.
//
// RANKING INPUT ONLY. Read by getAtRiskMembers to order and explain the at-risk
// list — a member who missed class AND bounced a payment ranks above either
// alone. Deliberately NOT part of lib/memberEligibility.ts:isTextEligibleMember,
// which answers "may we lawfully text this person" and feeds getTextableCount,
// the "Can be texted" tile and the /members Texts column. Those numbers are what
// gets quoted against the frozen "Up to 5 automated msgs/month" disclosure.
// Eligibility and priority must not be the same predicate (spec §6).
export const recordDuesFailure = internalMutation({
  args: {
    gymId: v.id("gyms"),
    memberId: v.id("members"),
    failedAt: v.number(),
    status: duesStatus,
  },
  handler: async (ctx, { gymId, memberId, failedAt, status }) => {
    const member = await ctx.db.get(memberId);
    if (!member || member.gymId !== gymId) {
      throw new Error(`No member ${memberId} for gym ${gymId}`);
    }
    await ctx.db.patch(memberId, {
      duesFailedAt: failedAt,
      duesFailureCount: (member.duesFailureCount ?? 0) + 1,
      duesStatus: status,
    });
  },
});

// Clears dues state after a cancellation Stripe has confirmed.
//
// The Customer id SURVIVES on purpose. It holds the member's saved card, and a
// member who pauses over the summer and comes back in September should not have
// to re-enter it — re-entry is where the whole migration objection lives
// (spec §9). planId survives too, so the roster still shows what they were on.
export const clearMemberDuesSubscription = internalMutation({
  args: { gymId: v.id("gyms"), memberId: v.id("members") },
  handler: async (ctx, { gymId, memberId }) => {
    const member = await ctx.db.get(memberId);
    if (!member || member.gymId !== gymId) {
      throw new Error(`No member ${memberId} for gym ${gymId}`);
    }
    await ctx.db.patch(memberId, {
      stripeConnectSubscriptionId: undefined,
      duesStatus: "canceled",
    });
  },
});

// Resolves a member from a connected-account Customer id, for the webhook.
//
// The webhook is unauthenticated by nature — Stripe calls it — so there is no
// identity to derive a gym from. Same reasoning as
// connect.ts:getGymByStripeConnectAccountId, including returning null rather
// than throwing: Stripe will deliver events for customers we no longer have a
// member for, and a throw would fail the event, burn Stripe's retries on
// something that can never succeed, and bury the real events behind it.
//
// No index on members.stripeConnectCustomerId, so this scans the gym's roster
// by_gym. A gym has 40-300 members and the webhook already knows which gym the
// event came from, so the scan is bounded by one gym, not the fleet. Add an
// index if a gym ever gets large enough for that to matter.
export const getMemberByStripeConnectCustomerId = internalQuery({
  args: { gymId: v.id("gyms"), stripeConnectCustomerId: v.string() },
  handler: async (ctx, { gymId, stripeConnectCustomerId }) => {
    const members = await ctx.db
      .query("members")
      .withIndex("by_gym", (q) => q.eq("gymId", gymId))
      .collect();
    return members.find((m) => m.stripeConnectCustomerId === stripeConnectCustomerId) ?? null;
  },
});

// How many live members hold a plan. Backs the archive guard in gymPlans.ts.
export const countMembersOnPlan = internalQuery({
  args: { gymId: v.id("gyms"), planId: v.id("gymPlans") },
  handler: async (ctx, { gymId, planId }) => {
    const members = await ctx.db
      .query("members")
      .withIndex("by_gym", (q) => q.eq("gymId", gymId))
      .collect();
    return members.filter((m) => m.planId === planId && !!m.stripeConnectSubscriptionId).length;
  },
});

// The owner-facing guard for "is anyone actually on this plan right now".
// Public because the drawer and the plans card both want to warn before an
// owner removes something people are paying against.
export const membersOnPlanCount = query({
  args: { planId: v.id("gymPlans") },
  handler: async (ctx, { planId }) => {
    const gym = await requireGym(ctx);
    const plan = await ctx.db.get(planId);
    if (!plan || plan.gymId !== gym._id) return 0;
    const members = await ctx.db
      .query("members")
      .withIndex("by_gym", (q) => q.eq("gymId", gym._id))
      .collect();
    return members.filter((m) => m.planId === planId && !!m.stripeConnectSubscriptionId).length;
  },
});
