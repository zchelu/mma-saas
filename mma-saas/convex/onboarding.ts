import { mutation, MutationCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { assertMaxLength } from "./validate";
import { generateGymSlug } from "./gyms";
import { consumeRateLimit } from "./rateLimit";
import { foundingTrialEndFrom, PLAN_PRICE_USD } from "../lib/plans";

// ---------------------------------------------------------------------------
// Founding (comped) trial grant
// ---------------------------------------------------------------------------
//
// The whole no-card trial is this: a code the owner presents during setup, and
// a timestamp written on their gym row. No Stripe call, no new table, no cron.
// See lib/plans.ts's "Founding (comped) trial" header for how it differs from
// the Stripe trial every normal customer gets, and convex/schema.ts's
// foundingTrialEndsAt for why the timestamp is stored rather than inferred.
//
// FOUNDING_TRIAL_CODE is a CONVEX env var (Convex dashboard -> Settings ->
// Environment Variables), not a Vercel one — this mutation runs on Convex.
// Unset means the founding trial is simply off, which is the correct resting
// state for an environment that isn't running the offer.
//
// FOUNDING_TRIAL_MAX caps how many gyms can ever redeem it, defaulting to 1 —
// "the first gym", enforced rather than trusted. Raise it in the dashboard to
// open a second founding slot; no deploy needed.
const DEFAULT_FOUNDING_TRIAL_MAX = 1;

function foundingTrialMax(): number {
  const raw = process.env.FOUNDING_TRIAL_MAX;
  const parsed = raw === undefined ? NaN : Number(raw);
  // A typo'd env var must not silently open the offer to everyone, so anything
  // that isn't a positive integer falls back to the default rather than to
  // Infinity or 0.
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_FOUNDING_TRIAL_MAX;
}

// Full scan of a table that holds one row per GYM — 14 rows on the dev
// deployment, single digits in production. Deliberately no index: this runs
// once per founding redemption, ever, and an index exists to be maintained on
// every future write of a table that has no other reason to carry one. Revisit
// if gyms ever reaches the thousands, which would be a very good problem.
async function countFoundingTrialsGranted(ctx: MutationCtx): Promise<number> {
  const gyms = await ctx.db.query("gyms").collect();
  return gyms.filter((gym) => gym.foundingTrialEndsAt !== undefined).length;
}

// Flat, with every field always present, rather than a discriminated union.
// Convex has to serialize this across the wire and the wizard has to narrow it
// on the other side; a union buys nothing here and a missing key is one more
// thing that can arrive as undefined on the client.
export type FoundingTrialOutcome = {
  granted: boolean;
  endsAt: number | null;
  /** Owner-facing, already phrased for display. null when there is nothing to say. */
  error: string | null;
};

// Auth-first signup's setup wizard (app/onboarding). Deliberately does NOT go
// through requireGym/requireWriteAccess — those block any gym whose
// planStatus is "inactive", which is exactly this gym's state the entire
// time onboarding runs (it happens before Stripe checkout, not after). Same
// reasoning as adminImportBatch bypassing requireGym for the CSV-import CLI
// path; this is the interactive equivalent, scoped to the caller's own gym
// via their Clerk identity instead of an admin key.
//
// Idempotent create-or-patch on the gym (mirrors getOrCreateGym) so calling
// this twice — e.g. a retried submit after a dropped response — never
// creates a second gym row for the same owner.
//
// Members are NOT collected here — the wizard is gym info + SMS consent
// only (2 steps). Adding the initial roster moved to a first-run dashboard
// task (app/dashboard/page.tsx) via the existing add-member UI/mutation in
// convex/members.ts, which already enforces its own per-member SMS consent
// via assertSmsConsent — this mutation's smsConsentConfirmed is a blanket
// owner attestation collected upfront, not tied to any roster entered here.
export const completeOnboarding = mutation({
  args: {
    gymName: v.string(),
    city: v.optional(v.string()),
    state: v.optional(v.string()),
    smsConsentConfirmed: v.boolean(),
    // Clerk's client-side user object, not a Convex identity claim — the
    // Convex JWT template doesn't carry email. Only destination we have for
    // the monthly winback report (convex/winbackReportEmail.ts).
    ownerEmail: v.optional(v.string()),
    // The tier the wizard was opened on. Used ONLY when a founding trial is
    // granted below, to decide which plan slug the comped gym runs on — a
    // paying gym's plan still comes from the Stripe Price it actually bought
    // (lib/plans.ts:resolvePlanFromPriceId), never from anything the client
    // sends here.
    plan: v.optional(v.string()),
    // The founding-gym access code, typed into the wizard or prefilled from
    // /onboarding?code=... . Absent for every normal customer, who goes to
    // Stripe Checkout exactly as before.
    foundingCode: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { gymName, city, state, smsConsentConfirmed, ownerEmail, plan, foundingCode }
  ) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const clerkUserId = identity.subject;

    assertMaxLength(gymName, 200, "Gym name");
    assertMaxLength(city, 100, "City");
    assertMaxLength(state, 100, "State");

    const existing = await ctx.db
      .query("gyms")
      .withIndex("by_clerk_user", (q) => q.eq("clerkUserId", clerkUserId))
      .unique();

    const now = Date.now();
    // Assigned once, here, the moment a gym's real name first becomes known
    // — the one reliable spot in the app for that (see gyms.ts:generateGymSlug).
    // Never reassigned on a repeat submit (e.g. the owner edits the gym name
    // and resubmits): a slug already handed out in a /consent/[gymSlug] link
    // must keep resolving to the same gym.
    const slug = existing?.slug ? undefined : await generateGymSlug(ctx, gymName);

    // onboardingCompleted is deliberately NOT set here — it's only ever set
    // true by upsertSubscription (convex/subscriptions.ts), once Stripe
    // actually confirms a paid subscription via webhook. Setting it here,
    // before checkout even runs, is what let an abandoned/failed checkout
    // permanently strand a gym on a fake unpurchased plan (see
    // app/onboarding/page.tsx's redirect guard). Same reasoning for not
    // defaulting plan/planStatus on insert: an unpaid gym should have no
    // plan at all, not a fabricated "academy"/"inactive" pair.
    const gymPatch = {
      name: gymName,
      city,
      state,
      ...(slug ? { slug } : {}),
      ...(ownerEmail ? { email: ownerEmail } : {}),
      ...(smsConsentConfirmed ? { smsConsentConfirmed: true, smsConsentConfirmedAt: now } : {}),
    };

    const gymId = existing
      ? existing._id
      : await ctx.db.insert("gyms", {
          clerkUserId,
          createdAt: now,
          ...gymPatch,
        });
    if (existing) await ctx.db.patch(existing._id, gymPatch);

    const foundingTrial = await maybeGrantFoundingTrial(ctx, {
      gymId,
      clerkUserId,
      existing,
      plan,
      foundingCode,
      now,
    });

    return { gymId, foundingTrial };
  },
});

// Returns an OUTCOME; DOES NOT THROW ON A BAD CODE. That is not a style
// preference, it is the only way the rate limit above it can work: a Convex
// mutation is one transaction, so throwing here would roll back the
// consumeRateLimit write along with everything else and an attacker could
// guess codes forever at zero cost. The wizard renders outcome.error and
// stops; nothing is sent to Stripe.
//
// Rolling back the gym name on a typo'd code would also be its own small
// cruelty — the owner is standing in front of Zain on a call when this runs.
//
// Reuses the existing "auth" bucket (5 attempts / 15 min, keyed on the Clerk
// user) rather than adding a bucket. Same ceiling, same reasoning, as
// subscriptions.ts:claimGymBySessionId: both verify a credential the caller
// supplied, so a scripted loop is bounded across either path.
async function maybeGrantFoundingTrial(
  ctx: MutationCtx,
  input: {
    gymId: Id<"gyms">;
    clerkUserId: string;
    existing: Doc<"gyms"> | null;
    plan: string | undefined;
    foundingCode: string | undefined;
    now: number;
  }
): Promise<FoundingTrialOutcome> {
  const { gymId, clerkUserId, existing, plan, foundingCode, now } = input;

  const code = foundingCode?.trim();
  if (!code) return { granted: false, endsAt: null, error: null };

  // ALREADY GRANTED -> succeed silently, do not re-grant. completeOnboarding is
  // idempotent by design (a retried submit after a dropped response must not
  // create a second gym), and that has to extend to the trial: re-running it
  // must never extend the clock by another 30 days.
  if (existing?.foundingTrialEndsAt !== undefined) {
    return { granted: true, endsAt: existing.foundingTrialEndsAt, error: null };
  }

  // A gym that already has a Stripe subscription is a paying customer. Handing
  // it a comped trial would overwrite the planStatus Stripe owns with a local
  // string no webhook can correct.
  if (existing?.stripeSubscriptionId) {
    return { granted: false, endsAt: null, error: "This gym already has a subscription." };
  }

  const allowed = await consumeRateLimit(ctx, "auth", `founding:${clerkUserId}`);
  if (!allowed) {
    return {
      granted: false,
      endsAt: null,
      error: "Too many attempts — please wait a few minutes and try again.",
    };
  }

  const expected = process.env.FOUNDING_TRIAL_CODE;
  // Same message for "no code configured in this environment" and "wrong code".
  // A distinct "founding access isn't enabled" reply tells an outsider whether
  // the offer exists at all, and there is nothing the owner could do with the
  // difference anyway — they call Zain either way.
  if (!expected || code !== expected) {
    return { granted: false, endsAt: null, error: "That founding access code isn't valid." };
  }

  const granted = await countFoundingTrialsGranted(ctx);
  if (granted >= foundingTrialMax()) {
    return {
      granted: false,
      endsAt: null,
      error: "Founding access is fully claimed. Pick a plan to start your free trial with a card instead.",
    };
  }

  // Never trust a client-supplied plan slug — fall back to the entry tier if it
  // isn't one of the three real ones (PLAN_PRICE_USD is the list). A comped gym
  // still needs a plan value: planHasTexting(undefined) is false, and a
  // founding gym that cannot send a winback text has been given a trial of
  // everything except the product.
  const planSlug = plan && plan in PLAN_PRICE_USD ? plan : "academy";
  const endsAt = foundingTrialEndFrom(now);

  await ctx.db.patch(gymId, {
    plan: planSlug,
    // The one place in the codebase that writes "trialing" without Stripe
    // saying so. Everything downstream — requireGym, hasWriteAccess,
    // listTextableGyms, the dashboard — already treats "trialing" as full
    // access, which is what makes this a genuinely complete trial rather than
    // a crippled one. gyms.ts:hasWriteAccess is what ends it.
    planStatus: "trialing",
    foundingTrialStartedAt: now,
    foundingTrialEndsAt: endsAt,
    // Set here for the SAME reason the header comment above says not to set it
    // on the normal path: it means "billing is settled, stop asking". For a
    // paying gym only Stripe can say that; for a comped gym this grant IS the
    // settlement. Leaving it false would bounce the founding gym between
    // /dashboard and /onboarding forever — app/dashboard/page.tsx redirects on
    // !onboardingCompleted && !stripeCustomerId, and a comped gym has neither.
    onboardingCompleted: true,
  });

  return { granted: true, endsAt, error: null };
}
