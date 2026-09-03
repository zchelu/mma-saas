"use node";

// Member dues — the Stripe half. Stage 4 of the Connect member-billing build
// (spec §5.4).
//
// Convex allows only ACTIONS in a "use node" module, so every query and
// mutation this flow needs lives in convex/memberBilling.ts.
//
// EVERY CALL BELOW CARRIES A `stripeAccount` HEADER. Customers, Checkout
// Sessions and Subscriptions all belong to the GYM. Without the header they are
// created on KombatDesk's own account, where they are invisible to the gym,
// unusable for a direct charge, and sitting beside our SaaS objects. The call
// still succeeds, which is what makes omitting it dangerous rather than loud.
//
// THE MEMBER'S CARD IS COLLECTED BY STRIPE, ON STRIPE'S PAGE. Checkout in
// `setup` mode, never Elements mounted in our DOM. That is what keeps
// KombatDesk at PCI SAQ-A; mounting Elements moves us to SAQ-A-EP and an annual
// compliance burden for zero UX gain. Spec §1 calls this non-negotiable and it
// is not a preference.
import Stripe from "stripe";
import { action, internalAction, ActionCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { ConvexError, v } from "convex/values";

const STRIPE_API_VERSION = "2026-06-24.dahlia";

// AGENTS.md §7: read into a variable, branch, construct after. `new
// Stripe(undefined!)` throws SYNCHRONOUSLY, above every catch in the caller.
// A CONVEX environment variable — Vercel having it says nothing.
function readStripeClient(): Stripe | null {
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    console.error(
      "Member dues: STRIPE_SECRET_KEY is missing from the CONVEX environment " +
        "(set it in the Convex dashboard — NOT Vercel). Dues setup is unavailable."
    );
    return null;
  }
  return new Stripe(stripeSecretKey);
}

async function requireOwnerGym(ctx: ActionCtx): Promise<Doc<"gyms">> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError("You need to be signed in to manage dues.");
  return await ctx.runQuery(internal.connect.getGymForConnect, { clerkUserId: identity.subject });
}

// THE CHARGE GATE. This is where spec §5.2's "nothing downstream may create a
// charge until chargesEnabled is true" actually binds.
//
// Deliberately stricter than the plans gate in gymPlansStripe.ts, which only
// requires an account to exist: a Product is an inert catalogue entry, and a gym
// waiting days on KYC should still be able to price itself. A Customer with a
// card attached and a Subscription against it is money, and Stripe would accept
// the objects on a restricted account and then fail every invoice — leaving the
// gym telling members "you're set up" while nothing ever collects.
function requireChargeReadyAccount(gym: Doc<"gyms">): string {
  const stripeConnectAccountId = gym.stripeConnectAccountId;
  if (!stripeConnectAccountId) {
    throw new ConvexError("Set up member billing before charging members.");
  }
  if (!gym.connectChargesEnabled) {
    throw new ConvexError(
      "Stripe hasn't cleared your gym to take payments yet. Finish verification on the dashboard first."
    );
  }
  return stripeConnectAccountId;
}

// Where Stripe sends the member after they save a card.
//
// TAKEN FROM THE CLIENT AND THEN ALLOWLISTED, not trusted. A Convex action has
// no request origin to read, and Checkout requires an absolute success_url. An
// unvalidated origin here is an open redirect with a Stripe-branded page in
// front of it — a member finishing checkout is exactly the moment they are least
// suspicious of where they land.
//
// The Connect card deleted CONNECT_DEV_RETURN_ORIGIN when embedded components
// removed its redirect; this flow reintroduces a return target, so the control
// comes back with it rather than being quietly skipped.
const ALLOWED_RETURN_ORIGINS: ReadonlySet<string> = new Set([
  "https://www.kombatdesk.com",
  "https://kombatdesk.com",
  // Connect can only be exercised on localhost — NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
  // is the LIVE key on every deployed environment (spec §11).
  "http://localhost:3000",
]);

function requireAllowedOrigin(origin: string): string {
  const trimmed = origin.trim().replace(/\/+$/, "");
  if (!ALLOWED_RETURN_ORIGINS.has(trimmed)) {
    console.error(`Member dues: refused return origin ${JSON.stringify(origin)}`);
    throw new ConvexError("Couldn't build a payment link from this address.");
  }
  return trimmed;
}

// Resolves the member and the plan together, with the messages an owner can act
// on. Every failure here is a state the owner can see and fix, so none of them
// should surface as "not found".
async function requireBillableMemberAndPlan(
  ctx: ActionCtx,
  gym: Doc<"gyms">,
  memberId: Id<"members">
): Promise<{ member: Doc<"members">; plan: Doc<"gymPlans">; stripeConnectPriceId: string }> {
  const member = await ctx.runQuery(internal.memberBilling.getMemberForBilling, {
    gymId: gym._id,
    memberId,
  });
  // Same message for "not yours" and "does not exist" — a distinct error would
  // confirm another gym's member id is real.
  if (!member) throw new ConvexError("That member no longer exists.");

  const plan = await ctx.runQuery(internal.memberBilling.getMemberPlan, {
    gymId: gym._id,
    memberId,
  });
  if (!plan) {
    throw new ConvexError("Pick a membership plan for this member first.");
  }
  if (!plan.stripeConnectPriceId) {
    // The plan row exists but its Stripe Price creation failed. gymPlansStripe
    // .retryPlanPrice is the fix, and the plans card offers it as a button.
    throw new ConvexError(
      `"${plan.name}" isn't finished at Stripe yet. Retry it on the plans card, then try again.`
    );
  }
  return { member, plan, stripeConnectPriceId: plan.stripeConnectPriceId };
}

// Reuses the member's Customer or creates one, on the GYM's account.
//
// The claim mutation is what resolves a race, not this function — see
// memberBilling.claimMemberStripeConnectCustomerId. Two rapid clicks can both
// reach Stripe before either stores an id; the first write wins and the loser
// continues with the id that actually stuck, because overwriting would strand
// the card already attached to the winner.
async function resolveMemberCustomerId(
  ctx: ActionCtx,
  stripe: Stripe,
  gym: Doc<"gyms">,
  stripeConnectAccountId: string,
  member: Doc<"members">
): Promise<string> {
  if (member.stripeConnectCustomerId) return member.stripeConnectCustomerId;

  const stripeConnectCustomer = await stripe.customers.create(
    {
      name: member.name,
      // Optional on members, and Stripe is fine without it. Present, it is what
      // puts the member's own receipt in their inbox rather than nowhere.
      ...(member.email ? { email: member.email } : {}),
      metadata: {
        kombatdesk_gym_id: gym._id,
        kombatdesk_member_id: member._id,
      },
    },
    {
      stripeAccount: stripeConnectAccountId,
      apiVersion: STRIPE_API_VERSION,
      idempotencyKey: `kd_member_customer_${member._id}`,
    }
  );

  const claim = await ctx.runMutation(internal.memberBilling.claimMemberStripeConnectCustomerId, {
    gymId: gym._id,
    memberId: member._id,
    stripeConnectCustomerId: stripeConnectCustomer.id,
  });
  if (!claim.stored) {
    console.error(
      `Member dues: raced Customer creation for member ${member._id}. Orphaned connected-account ` +
        `customer ${stripeConnectCustomer.id} (delete it in the Stripe dashboard); continuing ` +
        `with the stored customer ${claim.stripeConnectCustomerId}.`
    );
  }
  return claim.stripeConnectCustomerId;
}

// Creates the hosted link the member uses to save a card.
//
// SETUP MODE, NOT SUBSCRIPTION MODE. Subscription mode would create the
// subscription itself, which sounds simpler and is wrong here: it charges
// immediately, on Stripe's clock, before the gym has confirmed anything, and it
// gives us no seam to decide the start date or to refuse a member whose plan
// changed while the link was in their inbox. Setup mode collects the card and
// nothing else; convex/connectDuesWebhookAction.ts creates the subscription when
// `checkout.session.completed` confirms the card is really attached.
//
// The returned URL is a Stripe-hosted page. It is safe to text or email — it
// carries no KombatDesk session and grants no access to anything but this one
// member's card entry.
export const createDuesSetupLink = action({
  args: { memberId: v.id("members"), origin: v.string() },
  handler: async (ctx, { memberId, origin }): Promise<{ url: string }> => {
    const gym = await requireOwnerGym(ctx);
    const stripeConnectAccountId = requireChargeReadyAccount(gym);
    const returnOrigin = requireAllowedOrigin(origin);
    const { member, plan } = await requireBillableMemberAndPlan(ctx, gym, memberId);

    const stripe = readStripeClient();
    if (!stripe) {
      throw new ConvexError("Member billing is unavailable right now. Nothing was changed.");
    }

    const stripeConnectCustomerId = await resolveMemberCustomerId(
      ctx,
      stripe,
      gym,
      stripeConnectAccountId,
      member
    );

    const session = await stripe.checkout.sessions.create(
      {
        mode: "setup",
        customer: stripeConnectCustomerId,
        currency: "usd",
        // The webhook reads these back. Metadata rather than a query parameter
        // on success_url, because a query parameter is written by the member's
        // browser and this decides what gets charged.
        metadata: {
          kombatdesk_gym_id: gym._id,
          kombatdesk_member_id: member._id,
          kombatdesk_plan_id: plan._id,
        },
        success_url: `${returnOrigin}/dues/saved`,
        cancel_url: `${returnOrigin}/dues/canceled`,
      },
      {
        stripeAccount: stripeConnectAccountId,
        apiVersion: STRIPE_API_VERSION,
      }
    );

    if (!session.url) {
      // Documented as nullable, and null here means there is nothing to hand the
      // member. Better to say so than to return an empty string a UI will
      // cheerfully copy to the clipboard.
      throw new ConvexError("Stripe didn't return a payment link. Try again in a moment.");
    }
    return { url: session.url };
  },
});

// Creates the subscription once a card is confirmed attached.
//
// internalAction: the only legitimate caller is the dues webhook, which has
// verified Stripe's signature. Nothing owner-facing creates a subscription
// directly, because "the member saved a card" is a fact only Stripe can report.
//
// Idempotent on the member's subscription id AND on Stripe's side: the
// idempotency key is derived from the Checkout Session, so a redelivered
// `checkout.session.completed` returns the original subscription rather than
// starting a second one against the same card.
export const createSubscriptionForMember = internalAction({
  args: {
    gymId: v.id("gyms"),
    memberId: v.id("members"),
    stripeConnectAccountId: v.string(),
    stripeConnectCustomerId: v.string(),
    stripeConnectPriceId: v.string(),
    checkoutSessionId: v.string(),
  },
  handler: async (
    ctx,
    {
      gymId,
      memberId,
      stripeConnectAccountId,
      stripeConnectCustomerId,
      stripeConnectPriceId,
      checkoutSessionId,
    }
  ): Promise<{ created: boolean }> => {
    const member = await ctx.runQuery(internal.memberBilling.getMemberForBilling, {
      gymId,
      memberId,
    });
    if (!member) {
      console.error(`Member dues: no member ${memberId} for gym ${gymId}; ignoring.`);
      return { created: false };
    }
    if (member.stripeConnectSubscriptionId) {
      // Already subscribed. A redelivery, or the owner sent two links.
      return { created: false };
    }

    const stripe = readStripeClient();
    if (!stripe) throw new Error("STRIPE_SECRET_KEY missing while creating a dues subscription");

    const subscription = await stripe.subscriptions.create(
      {
        customer: stripeConnectCustomerId,
        items: [{ price: stripeConnectPriceId }],
        // NO application_fee_percent and NO transfer_data. Processing is passed
        // through at cost — a deliberate revenue decision, not an omission
        // (spec §1). Adding a fee here silently changes the pricing story the
        // whole product is sold on.
        metadata: {
          kombatdesk_gym_id: gymId,
          kombatdesk_member_id: memberId,
        },
      },
      {
        stripeAccount: stripeConnectAccountId,
        apiVersion: STRIPE_API_VERSION,
        idempotencyKey: `kd_dues_sub_${checkoutSessionId}`,
      }
    );

    await ctx.runMutation(internal.memberBilling.setMemberDuesSubscription, {
      gymId,
      memberId,
      stripeConnectSubscriptionId: subscription.id,
      status: subscription.status === "active" ? "active" : "unpaid",
    });
    return { created: true };
  },
});

// Moves a member to a different plan.
//
// With no live subscription this is a database write and nothing else. With one,
// STRIPE MOVES FIRST and the row follows — memberBilling.setMemberPlanId refuses
// to change planId under a running subscription precisely so this ordering
// cannot be skipped. The reverse order leaves the row claiming one price while
// Stripe bills another, with nothing on screen showing the disagreement.
export const changeMemberPlan = action({
  args: { memberId: v.id("members"), planId: v.id("gymPlans") },
  handler: async (ctx, { memberId, planId }): Promise<{ movedAtStripe: boolean }> => {
    const gym = await requireOwnerGym(ctx);

    const member = await ctx.runQuery(internal.memberBilling.getMemberForBilling, {
      gymId: gym._id,
      memberId,
    });
    if (!member) throw new ConvexError("That member no longer exists.");

    if (!member.stripeConnectSubscriptionId) {
      await ctx.runMutation(internal.memberBilling.setMemberPlanId, {
        gymId: gym._id,
        memberId,
        planId,
      });
      return { movedAtStripe: false };
    }

    const stripeConnectAccountId = requireChargeReadyAccount(gym);
    const plan = await ctx.runQuery(internal.gymPlans.getPlanForGym, { gymId: gym._id, planId });
    if (!plan || !plan.active) throw new ConvexError("That plan no longer exists.");
    if (!plan.stripeConnectPriceId) {
      throw new ConvexError(
        `"${plan.name}" isn't finished at Stripe yet. Retry it on the plans card, then try again.`
      );
    }

    const stripe = readStripeClient();
    if (!stripe) {
      throw new ConvexError("Member billing is unavailable right now. Nothing was changed.");
    }

    const current = await stripe.subscriptions.retrieve(member.stripeConnectSubscriptionId, {
      stripeAccount: stripeConnectAccountId,
      apiVersion: STRIPE_API_VERSION,
    });
    const currentItemId = current.items.data[0]?.id;
    if (!currentItemId) {
      throw new ConvexError("Couldn't read this member's subscription at Stripe. Try again.");
    }

    await stripe.subscriptions.update(
      member.stripeConnectSubscriptionId,
      {
        items: [{ id: currentItemId, price: plan.stripeConnectPriceId }],
        // Prorate. The member is mid-period on a price they are no longer on,
        // and silently charging the full new price on top of what they already
        // paid is the kind of surprise that produces a chargeback rather than a
        // support email.
        proration_behavior: "create_prorations",
      },
      { stripeAccount: stripeConnectAccountId, apiVersion: STRIPE_API_VERSION }
    );

    await ctx.runMutation(internal.memberBilling.setMemberPlanId, {
      gymId: gym._id,
      memberId,
      planId,
      allowWhileSubscribed: true,
    });
    return { movedAtStripe: true };
  },
});

// Cancels a member's dues.
//
// Cancels at Stripe FIRST, then clears the row, for the same ordering reason as
// changeMemberPlan: a cleared row over a live subscription is a member still
// being charged by a gym that believes they stopped.
//
// Immediate, not at period end. An owner cancelling dues has almost always just
// been told in person that someone is leaving, and "you'll be charged once more"
// is not what either of them expects. Revisit only with a real gym asking.
export const cancelMemberDues = action({
  args: { memberId: v.id("members") },
  handler: async (ctx, { memberId }): Promise<{ canceled: boolean }> => {
    const gym = await requireOwnerGym(ctx);
    const member = await ctx.runQuery(internal.memberBilling.getMemberForBilling, {
      gymId: gym._id,
      memberId,
    });
    if (!member) throw new ConvexError("That member no longer exists.");
    if (!member.stripeConnectSubscriptionId) return { canceled: false };

    const stripeConnectAccountId = gym.stripeConnectAccountId;
    if (!stripeConnectAccountId) {
      throw new ConvexError("This gym has no connected Stripe account.");
    }

    const stripe = readStripeClient();
    if (!stripe) {
      throw new ConvexError("Member billing is unavailable right now. Nothing was changed.");
    }

    try {
      await stripe.subscriptions.cancel(member.stripeConnectSubscriptionId, undefined, {
        stripeAccount: stripeConnectAccountId,
        apiVersion: STRIPE_API_VERSION,
      });
    } catch (err) {
      // A subscription Stripe no longer has is the state we were trying to
      // reach. Only that specific error — never the connection or rate-limit
      // classes, which always mean "ask again". Same narrowing discipline as
      // connectOnboarding.ts:isAccountGoneError.
      const gone =
        err instanceof Stripe.errors.StripeInvalidRequestError && err.code === "resource_missing";
      if (!gone) {
        console.error(`Member dues: cancel failed for member ${memberId}:`, err);
        throw new ConvexError("Couldn't cancel at Stripe. Nothing was changed — try again.");
      }
    }

    await ctx.runMutation(internal.memberBilling.clearMemberDuesSubscription, {
      gymId: gym._id,
      memberId,
    });
    return { canceled: true };
  },
});
