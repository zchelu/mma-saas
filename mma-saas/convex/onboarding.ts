import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { assertMaxLength } from "./validate";

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
  },
  handler: async (ctx, { gymName, city, state, smsConsentConfirmed }) => {
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
    // onboardingCompleted is deliberately NOT set here — it's only ever set
    // true by upsertSubscription (convex/subscriptions.ts), once Stripe
    // actually confirms a paid subscription via webhook. Setting it here,
    // before checkout even runs, is what let an abandoned/failed checkout
    // permanently strand a gym on a fake unpurchased plan (see
    // app/onboarding/page.tsx's redirect guard). Same reasoning for not
    // defaulting plan/planStatus on insert: an unpaid gym should have no
    // plan at all, not a fabricated "starter"/"inactive" pair.
    const gymPatch = {
      name: gymName,
      city,
      state,
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

    return { gymId };
  },
});
