"use node";

// Gym-defined membership plans — the Stripe half. Stage 3 of the Connect
// member-billing build (spec §5.3).
//
// Convex allows only ACTIONS in a "use node" module, so every query and
// mutation this flow needs lives in convex/gymPlans.ts on the default runtime.
// Same split as connectOnboarding.ts / connect.ts.
//
// THIS IS THE FIRST CODE IN THE REPO THAT PASSES A `stripeAccount` HEADER.
// Everything Connect has shipped so far acts on the platform account: creating
// the gym's account, minting session secrets, reading status. A Product and a
// Price belong to the GYM, and without that header they would be created on
// KombatDesk's own account — invisible to the gym, unusable for a direct charge,
// and sitting in the same account that holds our SaaS Prices. Every call below
// carries it. If you add one that does not, it is wrong.
import Stripe from "stripe";
import { action, ActionCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { ConvexError, v } from "convex/values";
import { MAX_PLAN_AMOUNT_CENTS, MIN_PLAN_AMOUNT_CENTS } from "../lib/money";

// Duplicated verbatim from convex/gymPlans.ts rather than imported — see the
// comment there. Must agree with convex/schema.ts:gymPlans.interval.
const planInterval = v.union(v.literal("month"), v.literal("year"));

// Pinned explicitly, never inherited from the SDK default — same value and same
// reasoning as convex/connectOnboarding.ts. Variant 7 is generally available.
const STRIPE_API_VERSION = "2026-06-24.dahlia";

// AGENTS.md §7: read into a variable, branch, construct after. `new
// Stripe(undefined!)` throws SYNCHRONOUSLY, so constructing above the guard puts
// the throw above every catch in the caller.
//
// A CONVEX environment variable, set in the Convex dashboard. Vercel having
// STRIPE_SECRET_KEY says nothing about whether Convex does.
function readStripeClient(): Stripe | null {
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    console.error(
      "Gym plans: STRIPE_SECRET_KEY is missing from the CONVEX environment " +
        "(set it in the Convex dashboard — NOT Vercel). Plan creation is unavailable."
    );
    return null;
  }
  return new Stripe(stripeSecretKey);
}

// Verifies the caller and resolves their gym. Identity is read here, in the
// action, and the verified subject passed down explicitly — see
// convex/connect.ts:getGymForConnect for why that beats relying on auth
// propagating through ctx.runQuery.
//
// getGymForConnect also applies the write-access gate, which is the right one
// here: a lapsed gym keeps its front door (gyms.rotateKioskToken deliberately
// has no gate) but does not get to create new billing objects on a merchant
// account.
async function requireOwnerGym(ctx: ActionCtx): Promise<Doc<"gyms">> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError("You need to be signed in to manage plans.");
  return await ctx.runQuery(internal.connect.getGymForConnect, { clerkUserId: identity.subject });
}

// The connected account, or a message the owner can act on.
//
// Note what is NOT required here: `connectChargesEnabled`. Stripe accepts
// Products and Prices on an account that is still in review, and a gym waiting
// on KYC should be able to set its plans up in the meantime — that wait is
// days. The charges gate belongs on the call that actually charges a member
// (stage 4), which is where spec §5.2's "nothing downstream may create a charge
// until chargesEnabled is true" applies.
function requireConnectedAccount(gym: Doc<"gyms">): string {
  const stripeConnectAccountId = gym.stripeConnectAccountId;
  if (!stripeConnectAccountId) {
    throw new ConvexError(
      "Set up member billing first — plans are created on your own Stripe account."
    );
  }
  return stripeConnectAccountId;
}

// Turns a Stripe failure into something an owner can read, without inventing
// certainty about which failure it was.
//
// Deliberately does NOT surface err.message verbatim to the browser: Stripe's
// messages are written for developers and some carry account identifiers. The
// full error goes to the Convex log, where it can be read against the plan id.
function planPriceFailure(err: unknown, planId: Id<"gymPlans">): ConvexError<string> {
  console.error(`gymPlansStripe: failed to create a Stripe Price for plan ${planId}:`, err);
  if (err instanceof Stripe.errors.StripeConnectionError || err instanceof Stripe.errors.StripeAPIError) {
    return new ConvexError(
      "Saved the plan, but couldn't reach Stripe to price it. Open the plan and retry in a moment."
    );
  }
  return new ConvexError(
    "Saved the plan, but Stripe rejected the price. Check your member billing setup, then retry."
  );
}

// Creates the Product and the Price on the GYM's account and stamps the id.
//
// Split out because two callers need exactly this: creating a new plan, and
// retrying one whose Price creation failed the first time. Both must produce the
// SAME Stripe objects rather than a second pair, which is what the idempotency
// keys below are for — they are derived from the Convex row id, so a retry after
// a network timeout that Stripe actually processed returns the original object
// instead of creating a duplicate the gym would be double-charged to keep.
async function createPriceForPlan(
  ctx: ActionCtx,
  stripe: Stripe,
  gym: Doc<"gyms">,
  stripeConnectAccountId: string,
  plan: Doc<"gymPlans">
): Promise<string> {
  try {
    const stripeConnectProduct = await stripe.products.create(
      {
        name: plan.name,
        // The gym is the merchant of record on a direct charge, so this is what
        // shows up on the gym's own Stripe surfaces and on the member's invoice.
        // Keep it the plan name and nothing else — no "KombatDesk" anywhere near
        // it. A member who sees our name against a charge they believe came from
        // their jiu-jitsu gym calls their bank, which is a manufactured
        // chargeback (spec §1).
        metadata: {
          kombatdesk_gym_id: gym._id,
          kombatdesk_plan_id: plan._id,
        },
      },
      {
        stripeAccount: stripeConnectAccountId,
        apiVersion: STRIPE_API_VERSION,
        idempotencyKey: `kd_plan_product_${plan._id}`,
      }
    );

    const stripeConnectPrice = await stripe.prices.create(
      {
        product: stripeConnectProduct.id,
        // INTEGER CENTS, straight from the row. Stripe's unit_amount is cents
        // too, so there is no conversion here on purpose — the one place
        // dollars become cents is lib/money.ts, on the way in.
        unit_amount: plan.amountCents,
        currency: "usd",
        recurring: { interval: plan.interval },
        metadata: {
          kombatdesk_gym_id: gym._id,
          kombatdesk_plan_id: plan._id,
        },
      },
      {
        stripeAccount: stripeConnectAccountId,
        apiVersion: STRIPE_API_VERSION,
        idempotencyKey: `kd_plan_price_${plan._id}`,
      }
    );

    const stored = await ctx.runMutation(internal.gymPlans.setPlanStripeConnectPriceId, {
      gymId: gym._id,
      planId: plan._id,
      stripeConnectPriceId: stripeConnectPrice.id,
    });
    return stored.stripeConnectPriceId;
  } catch (err) {
    throw planPriceFailure(err, plan._id);
  }
}

// Owner defines a membership plan.
//
// Order is row first, Stripe second — see the comment on createPlanRow for why
// the reverse would lose a Price nobody can find. A failure after the insert
// leaves a visible, un-priced plan and an error telling the owner to retry,
// which retryPlanPrice below then completes.
export const createPlan = action({
  args: {
    name: v.string(),
    // INTEGER CENTS. The browser parses the typed dollars with
    // lib/money.ts:parseDollarsToCents; this re-validates rather than trusting
    // it, because an action is reachable without the form.
    amountCents: v.number(),
    interval: planInterval,
  },
  handler: async (ctx, { name, amountCents, interval }): Promise<{ planId: Id<"gymPlans"> }> => {
    const gym = await requireOwnerGym(ctx);
    const stripeConnectAccountId = requireConnectedAccount(gym);

    // Cheap guards before anything is written or any HTTP call is made. The
    // authoritative copies live in convex/gymPlans.ts:createPlanRow, which runs
    // inside the transaction; these exist so the common mistake fails before a
    // row is inserted rather than after.
    if (!Number.isInteger(amountCents)) {
      throw new ConvexError("Plan price must be a whole number of cents.");
    }
    if (amountCents < MIN_PLAN_AMOUNT_CENTS || amountCents > MAX_PLAN_AMOUNT_CENTS) {
      throw new ConvexError("Plan prices run from $1.00 to $10,000.");
    }

    const stripe = readStripeClient();
    if (!stripe) {
      throw new ConvexError("Member billing is unavailable right now. Nothing was changed.");
    }

    const planId = await ctx.runMutation(internal.gymPlans.createPlanRow, {
      gymId: gym._id,
      name,
      amountCents,
      interval,
    });

    const plan = await ctx.runQuery(internal.gymPlans.getPlanForGym, { gymId: gym._id, planId });
    if (!plan) throw new Error(`Plan ${planId} vanished immediately after insert`);

    await createPriceForPlan(ctx, stripe, gym, stripeConnectAccountId, plan);
    return { planId };
  },
});

// Finishes a plan whose Price creation failed.
//
// This is the other half of the promise the schema makes when it says a plan
// with no stripeConnectPriceId "must still be visible and fixable rather than
// lost". Without this, "fixable" means deleting the plan and typing it again.
//
// Safe to call on a plan that already has a Price: it returns the existing id
// rather than creating a second one, and the idempotency keys make even a
// racing double-click converge on one pair of Stripe objects.
export const retryPlanPrice = action({
  args: { planId: v.id("gymPlans") },
  handler: async (ctx, { planId }): Promise<{ stripeConnectPriceId: string }> => {
    const gym = await requireOwnerGym(ctx);
    const stripeConnectAccountId = requireConnectedAccount(gym);

    const plan = await ctx.runQuery(internal.gymPlans.getPlanForGym, { gymId: gym._id, planId });
    // Same message whether the plan is missing or belongs to another gym — a
    // distinct error would confirm that another gym's plan id is real.
    if (!plan) throw new ConvexError("That plan no longer exists.");
    if (plan.stripeConnectPriceId) {
      return { stripeConnectPriceId: plan.stripeConnectPriceId };
    }

    const stripe = readStripeClient();
    if (!stripe) {
      throw new ConvexError("Member billing is unavailable right now. Nothing was changed.");
    }

    const stripeConnectPriceId = await createPriceForPlan(
      ctx,
      stripe,
      gym,
      stripeConnectAccountId,
      plan
    );
    return { stripeConnectPriceId };
  },
});
