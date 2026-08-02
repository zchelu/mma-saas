import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { assertMaxLength } from "./validate";
import { consumeRateLimit } from "./rateLimit";
import { hasWriteAccess } from "./gyms";
import { planHasTexting, resolvePlanFromPriceId } from "../lib/plans";
import { alertUnresolvedPrice } from "../lib/alerts";

export const upsertSubscription = internalMutation({
  args: {
    clerkUserId: v.string(),
    stripeCustomerId: v.string(),
    stripeSubscriptionId: v.string(),
    // Optional (schema field already is): stripeWebhookAction.ts passes
    // undefined when the subscription's Stripe Price doesn't resolve to a
    // known plan (see lib/plans.ts:resolvePlanFromPriceId), rather than
    // guessing a tier. Omitting the field here — never defaulting it — is
    // what keeps this gym's plan untouched instead of mislabeled: a
    // just-paid customer still gets planStatus/stripeCustomerId written and
    // keeps access, just with whatever plan value (or none) it already had.
    plan: v.optional(v.string()),
    planStatus: v.string(),
  },
  handler: async (ctx, args): Promise<{ gymId: string }> => {
    const existing = await ctx.db
      .query("gyms")
      .withIndex("by_clerk_user", (q) => q.eq("clerkUserId", args.clerkUserId))
      .unique();

    // onboardingCompleted is set true here, not in convex/onboarding.ts —
    // this is the auth-first flow's real confirmation that Stripe actually
    // created/updated a subscription for this clerkUserId, as opposed to
    // the wizard merely having been filled out. Applies on every event
    // (created/updated/deleted, see stripeWebhookAction.ts) since a
    // canceled subscription still means onboarding genuinely happened —
    // planStatus is what tracks current billing state, not this flag.
    if (existing) {
      await ctx.db.patch(existing._id, {
        stripeCustomerId: args.stripeCustomerId,
        stripeSubscriptionId: args.stripeSubscriptionId,
        ...(args.plan ? { plan: args.plan } : {}),
        planStatus: args.planStatus,
        onboardingCompleted: true,
      });
      return { gymId: existing._id };
    } else {
      const gymId = await ctx.db.insert("gyms", {
        clerkUserId: args.clerkUserId,
        stripeCustomerId: args.stripeCustomerId,
        stripeSubscriptionId: args.stripeSubscriptionId,
        ...(args.plan ? { plan: args.plan } : {}),
        planStatus: args.planStatus,
        onboardingCompleted: true,
      });
      return { gymId };
    }
  },
});

// Called from the webhook for subscription events with no clerkUserId in
// metadata — a guest checkout. Creates or updates a gym row keyed only by
// stripeCustomerId; clerkUserId is attached later by claimGymByCustomer.
// Never touches clerkUserId on an existing row, since a claim may have
// already landed before this event does.
export const upsertUnclaimedSubscription = internalMutation({
  args: {
    stripeCustomerId: v.string(),
    stripeSubscriptionId: v.string(),
    // See upsertSubscription's comment above — same optional-plan reasoning.
    plan: v.optional(v.string()),
    planStatus: v.string(),
  },
  handler: async (ctx, args): Promise<{ gymId: string }> => {
    const existing = await ctx.db
      .query("gyms")
      .withIndex("by_stripe_customer", (q) => q.eq("stripeCustomerId", args.stripeCustomerId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        stripeSubscriptionId: args.stripeSubscriptionId,
        ...(args.plan ? { plan: args.plan } : {}),
        planStatus: args.planStatus,
      });
      return { gymId: existing._id };
    } else {
      const gymId = await ctx.db.insert("gyms", {
        stripeCustomerId: args.stripeCustomerId,
        stripeSubscriptionId: args.stripeSubscriptionId,
        ...(args.plan ? { plan: args.plan } : {}),
        planStatus: args.planStatus,
        createdAt: Date.now(),
      });
      return { gymId };
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

    // Shares the "auth" bucket/ceiling with claimGymByRecoveryToken below —
    // both verify a credential against Stripe on the caller's behalf, so a
    // scripted loop guessing/retrying session ids or tokens is bounded
    // across either path, not just one.
    const allowed = await ctx.runMutation(internal.rateLimit.checkRateLimit, {
      bucket: "auth",
      identifier: `user:${identity.subject}`,
    });
    if (!allowed) throw new Error("Too many attempts — please wait a few minutes and try again.");

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
    const priceId = sub?.items?.data?.[0]?.price?.id;
    const plan = resolvePlanFromPriceId(priceId);

    const result = await ctx.runMutation(internal.subscriptions.claimGymByCustomer, {
      clerkUserId: identity.subject,
      stripeCustomerId,
      stripeSubscriptionId: sub?.id,
      // resolvePlanFromPriceId(undefined) already returns undefined when sub
      // is null (priceId is undefined too), so this needs no ternary.
      plan,
      planStatus: sub?.status,
    });

    // Does not throw — a customer sitting mid-checkout must not see an error
    // page. gym.plan stays whatever claimGymByCustomer already left it as;
    // this only alerts so it gets fixed by hand.
    if (sub && !plan) {
      await alertUnresolvedPrice({
        source: "subscriptions.claimGymBySessionId",
        priceId,
        gymId: result.gymId,
        stripeSubscriptionId: sub.id,
      });
    }

    return result;
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
      // Never fabricate a plan for an unresolved price (see
      // lib/plans.ts:resolvePlanFromPriceId) — omit the field entirely
      // (already optional in schema) rather than defaulting to "academy".
      // upsertUnclaimedSubscription will fill this in once the webhook
      // lands, same as it always does for a still-blank placeholder.
      ...(plan ? { plan } : {}),
      planStatus: planStatus ?? "inactive",
      createdAt: Date.now(),
    });
    return { gymId };
  },
});

// Internal — only reachable via ctx.runQuery from convex/recoveryAction.ts,
// which performs the actual Stripe ownership verification. Used to pick the
// right Stripe customer when an email has more than one (e.g. a guest
// checkout retried after an earlier attempt never got claimed). Stripe's
// customers.list returns newest-first, so without this check the action
// would always resolve to the most recent customer and could never recover
// an older, still-unclaimed purchase sitting behind a newer already-claimed
// one under the same email.
export const isCustomerClaimed = internalQuery({
  args: { stripeCustomerId: v.string() },
  handler: async (ctx, { stripeCustomerId }) => {
    const gym = await ctx.db
      .query("gyms")
      .withIndex("by_stripe_customer", (q) => q.eq("stripeCustomerId", stripeCustomerId))
      .unique();
    return !!gym?.clerkUserId;
  },
});

// Internal — only reachable via ctx.runMutation from
// convex/recoveryAction.ts, after it independently verifies via the Stripe
// API that this email belongs to a paying, unclaimed customer. Previously a
// public mutation trusting whatever stripeCustomerId it was handed with no
// verification at all — anyone could mint a token for ANY customer id
// (including a real paying customer's) and use it via
// claimGymByRecoveryToken to link that customer's gym/subscription to their
// own Clerk account, stealing it before the real owner ever claimed it. The
// rate limit below is still worth keeping as defense in depth even though
// this is internal now — it bounds repeated token-minting for the same
// Stripe customer regardless of caller.
export const createRecoveryToken = internalMutation({
  args: { token: v.string(), stripeCustomerId: v.string(), expiresAt: v.number() },
  handler: async (ctx, args) => {
    const allowed = await consumeRateLimit(ctx, "auth", `mint:${args.stripeCustomerId}`);
    if (!allowed) throw new Error("Too many requests for this account — please try again later.");
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

    const allowed = await ctx.runMutation(internal.rateLimit.checkRateLimit, {
      bucket: "auth",
      identifier: `user:${identity.subject}`,
    });
    if (!allowed) throw new Error("Too many attempts — please wait a few minutes and try again.");

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
    assertMaxLength(defaultName, 200, "Gym name");

    const existing = await ctx.db
      .query("gyms")
      .withIndex("by_clerk_user", (q) => q.eq("clerkUserId", clerkUserId))
      .unique();
    if (existing) return existing;

    // A gym with no subscription has no plan — never fabricate one (see the
    // same reasoning in claimGymByCustomer below and lib/plans.ts:
    // resolvePlanFromPriceId). Defaulting to "academy" here made
    // planHasTexting() return true for a gym that has never subscribed, and
    // made app/billing/page.tsx show "Academy" to someone who has never paid.
    const gymId = await ctx.db.insert("gyms", {
      clerkUserId,
      name: defaultName ?? "My Gym",
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
      return {
        plan: null,
        planStatus: null,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        onboardingCompleted: false,
        hasSlug: false,
        slug: null,
        gymId: null,
        createdAt: null,
      };
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
      onboardingCompleted: gym?.onboardingCompleted ?? false,
      // Exposed for app/onboarding/page.tsx's redirect guard, which must let a
      // paying-but-slugless gym back into the wizard. A gym with no slug has no
      // /consent/[gymSlug] page, so no member can ever confirm consent and the
      // gym can never send a single retention text — the entire product, dead,
      // on a paid subscription (see claude/guest-checkout-dead-gym-trap.md).
      // slug is only ever assigned by onboarding.completeOnboarding from a real
      // gym name, so "has a slug" also implies "has a name" — which getBySlug
      // requires before it will resolve the consent page at all. Boolean rather
      // than the slug itself: nothing client-side needs the value here.
      hasSlug: !!gym?.slug,
      // The slug itself, for app/dashboard/owner-links.tsx — the owner has to
      // be able to find their own /consent/[gymSlug] URL. Until this existed
      // the only way to get it was to read the gyms table in the Convex
      // dashboard by hand, which meant an owner who lost the link could not
      // collect member consent, and a gym that cannot collect consent can
      // never send a text. Same dead end as the guest-checkout trap, reached
      // a different way.
      //
      // Not sensitive: the slug is the public part of a URL handed to every
      // member of the gym. hasSlug above is kept as its own field so the
      // onboarding redirect guard doesn't have to change shape — see
      // app/onboarding/page.tsx, where getting that guard wrong routes every
      // paying gym into the setup wizard.
      slug: gym?.slug ?? null,
      // Exposed for app/dashboard/winback-panel.tsx: the panel's default range
      // start is this gym's own createdAt, not a trailing window — see that
      // file for why.
      gymId: gym?._id ?? null,
      createdAt: gym?.createdAt ?? null,
    };
  },
});

export const updatePlanStatusByCustomer = internalMutation({
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

export const getGymById = internalQuery({
  args: { gymId: v.id("gyms") },
  handler: async (ctx, { gymId }) => {
    return await ctx.db.get(gymId);
  },
});

// Used by the retention-text cron dispatcher to fan out per gym instead of
// treating "any gym anywhere is subscribed" as license to text every gym's
// members. academy/fightteam/blackbelt get identical texting access — this
// filters on billing status (hasWriteAccess, same bar as any other gym-scoped
// write), not tier. The one plan-based exclusion left is legacy "starter"
// rows (see planHasTexting in lib/plans.ts) — never included under the old
// pricing, and billing-status-only gating shouldn't silently grant it now.
export const listTextableGyms = internalQuery({
  args: {},
  handler: async (ctx) => {
    const gyms = await ctx.db.query("gyms").collect();
    return gyms.filter((gym) => hasWriteAccess(gym) && planHasTexting(gym.plan));
  },
});
