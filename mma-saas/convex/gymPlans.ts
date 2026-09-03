// Gym-defined membership plans — the database half. Stage 3 of the Connect
// member-billing build (spec §5.3).
//
// The Stripe calls live in convex/gymPlansStripe.ts, which must be a "use node"
// module for the Stripe SDK. Convex allows only ACTIONS in a "use node" file,
// so every query and mutation lives here in the default runtime — the same
// split as convex/connect.ts / convex/connectOnboarding.ts, for the same
// reason.
//
// A PLAN IS A PRICE, NOT A LABEL. `members.plan` is free text and stays that
// way (schema comment on members.plan): it is display copy, it cannot carry a
// price, and nothing may try to parse one out of it. `gymPlans` is the money
// object, and `members.planId` will point at it in stage 4.
//
// THE NAMING RULE (spec §2): anything belonging to a gym's CONNECTED account is
// stripeConnect*, locals included. `gymPlans.stripeConnectPriceId` is a Price on
// the GYM's account, never on the platform account that bills the gym for
// KombatDesk itself.
import { query, mutation, internalQuery, internalMutation } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { requireGym, requireWriteAccess, tryGetGym } from "./gyms";
import { MAX_PLAN_AMOUNT_CENTS, MIN_PLAN_AMOUNT_CENTS } from "../lib/money";

// The interval validator.
//
// NOT exported, and duplicated verbatim in convex/gymPlansStripe.ts on purpose.
// A Convex module's exports are its public function surface; exporting a bare
// validator from one puts a non-function in that surface for a one-line saving.
// The two copies and convex/schema.ts:gymPlans.interval must agree — if you add
// a third interval, grep for "week" here and change all three.
const planInterval = v.union(v.literal("month"), v.literal("year"));

// Bounds re-checked HERE and not only in lib/money.ts, because the browser
// parses a typed string and this receives a number. A client that skips the
// form entirely — or a future caller that does its own parsing — must not be
// able to write a plan the form could never have produced.
//
// Throws rather than returning a result: every caller is a mutation whose only
// correct response to a bad amount is to refuse the write.
function assertValidAmountCents(amountCents: number): void {
  if (!Number.isInteger(amountCents)) {
    // The single most important assertion in this file. `amountCents` is the
    // integer-cents side of an app whose other money field is a dollars float
    // (see lib/money.ts). A float arriving here means someone passed dollars,
    // and storing it would bill 1/100th of the intended amount.
    throw new ConvexError("Plan price must be a whole number of cents.");
  }
  if (amountCents < MIN_PLAN_AMOUNT_CENTS) {
    throw new ConvexError("Plans have to be at least $1.00.");
  }
  if (amountCents > MAX_PLAN_AMOUNT_CENTS) {
    throw new ConvexError("That looks like a typo — plans cap at $10,000.");
  }
}

function normalizePlanName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

// What the owner's plans card renders.
//
// tryGetGym, not requireGym — this is read through useQuery from a "use client"
// component, so it fires before Clerk's session has hydrated. requireGym throws
// a plain Error there, production redacts it to "Server Error", and with no
// error boundary that took the whole dashboard down once already (518ad18).
// Null means "not ready or no gym" and the card renders nothing.
//
// NARROWED FIELD MAP, deliberately. `stripeConnectPriceId` does not go over the
// wire — the browser has no use for a connected-account identifier, and the
// discipline that keeps checkInToken out of getAtRiskMembers' return
// (convex/members.ts) applies to Stripe ids too (convex/connect.ts:
// getConnectStatus says the same). The UI needs to know only WHETHER a Price
// exists, which is what `billable` carries.
export const listPlans = query({
  args: {},
  handler: async (ctx) => {
    const gym = await tryGetGym(ctx);
    if (!gym) return null;
    const plans = await ctx.db
      .query("gymPlans")
      .withIndex("by_gym", (q) => q.eq("gymId", gym._id))
      .collect();
    return plans
      .filter((plan) => plan.active)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((plan) => ({
        _id: plan._id,
        name: plan.name,
        amountCents: plan.amountCents,
        interval: plan.interval,
        // A plan whose Stripe Price creation failed is deliberately KEPT (see
        // the schema comment on stripeConnectPriceId) so it stays visible and
        // fixable rather than vanishing. This is the flag that lets the card
        // say so instead of showing it as if it were ready to bill.
        billable: !!plan.stripeConnectPriceId,
      }));
  },
});

// Reads one plan back for the action, which cannot touch ctx.db.
//
// Takes the gymId the action already resolved and checks it against the row,
// rather than trusting the planId alone. A plan id is not a capability: it
// arrives from a browser, and without this check any signed-in owner could name
// another gym's plan id and act on it.
export const getPlanForGym = internalQuery({
  args: { gymId: v.id("gyms"), planId: v.id("gymPlans") },
  handler: async (ctx, { gymId, planId }) => {
    const plan = await ctx.db.get(planId);
    if (!plan || plan.gymId !== gymId) return null;
    return plan;
  },
});

// Inserts the plan row BEFORE the Stripe Price exists, and that ordering is the
// point.
//
// Creating a Stripe Price and storing its id cannot be one transaction — the
// first half is an HTTP call from an action. If the row were written second, a
// Stripe success followed by a Convex failure would leave a Price the gym is
// paying to keep and no record of it anywhere in our database. Written first,
// the worst case is a plan the owner can see, name and delete, which is the
// failure a human can actually resolve.
//
// Rejects a duplicate active name because the realistic double-submit produces
// two identical plans, and a gym with two "Adult Unlimited" rows will enroll
// members against both.
export const createPlanRow = internalMutation({
  args: {
    gymId: v.id("gyms"),
    name: v.string(),
    amountCents: v.number(),
    interval: planInterval,
  },
  handler: async (ctx, { gymId, name, amountCents, interval }) => {
    assertValidAmountCents(amountCents);
    const normalized = normalizePlanName(name);
    if (!normalized) throw new ConvexError("Give the plan a name.");
    if (normalized.length > 80) throw new ConvexError("Plan names cap at 80 characters.");

    const existing = await ctx.db
      .query("gymPlans")
      .withIndex("by_gym", (q) => q.eq("gymId", gymId))
      .collect();
    const clash = existing.find(
      (plan) => plan.active && plan.name.toLowerCase() === normalized.toLowerCase()
    );
    if (clash) {
      throw new ConvexError(`You already have a plan called "${clash.name}".`);
    }

    return await ctx.db.insert("gymPlans", {
      gymId,
      name: normalized,
      amountCents,
      interval,
      active: true,
    });
  },
});

// Stamps the Price id after Stripe confirms it.
//
// Re-checks gym ownership for the same reason getPlanForGym does, and refuses to
// overwrite an id that is already there: a Price is immutable at Stripe and a
// member may already be subscribed to it, so a second write means two Prices
// exist and only one is reachable. Report it loudly rather than silently
// picking the newer one.
export const setPlanStripeConnectPriceId = internalMutation({
  args: {
    gymId: v.id("gyms"),
    planId: v.id("gymPlans"),
    stripeConnectPriceId: v.string(),
  },
  handler: async (ctx, { gymId, planId, stripeConnectPriceId }) => {
    const plan = await ctx.db.get(planId);
    if (!plan || plan.gymId !== gymId) {
      throw new Error(`No plan ${planId} for gym ${gymId}`);
    }
    if (plan.stripeConnectPriceId && plan.stripeConnectPriceId !== stripeConnectPriceId) {
      console.error(
        `gymPlans: plan ${planId} already has Price ${plan.stripeConnectPriceId}; ` +
          `refusing to overwrite with ${stripeConnectPriceId}. The second Price is now ` +
          `orphaned at Stripe and should be archived by hand.`
      );
      return { stored: false as const, stripeConnectPriceId: plan.stripeConnectPriceId };
    }
    await ctx.db.patch(planId, { stripeConnectPriceId });
    return { stored: true as const, stripeConnectPriceId };
  },
});

// Archives a plan. Soft, never a delete.
//
// `duesInvoices` rows and, from stage 4, `members.planId` reference this row.
// Deleting it would break the join that tells an owner what a past charge was
// for. Archiving hides it from the picker and leaves history readable.
//
// The Stripe Price is deliberately left alone — Prices are immutable and
// deactivating one at Stripe would break any live subscription already billing
// against it. Stage 4 is where cancelling those subscriptions gets handled; it
// is not this mutation's job to do it silently.
export const archivePlan = mutation({
  args: { planId: v.id("gymPlans") },
  handler: async (ctx, { planId }) => {
    const gym = await requireGym(ctx);
    requireWriteAccess(gym);
    const plan = await ctx.db.get(planId);
    // Same message for "does not exist" and "belongs to another gym", on
    // purpose: a distinct error would confirm that some other gym's plan id is
    // real.
    if (!plan || plan.gymId !== gym._id) {
      throw new ConvexError("That plan no longer exists.");
    }
    await ctx.db.patch(planId, { active: false });
  },
});
