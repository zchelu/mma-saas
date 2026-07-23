import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { assertMaxLength, assertEmailFormat, assertMaxArrayLength } from "./validate";

const MAX_ONBOARDING_MEMBERS = 500;

const memberRow = v.object({
  name: v.string(),
  email: v.optional(v.string()),
  phone: v.optional(v.string()),
  beltRank: v.optional(v.string()),
});

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
// creates a second gym row for the same owner. Member rows are NOT
// deduped by name/email here: onboarding is a one-time initial-roster step,
// not a re-runnable import, so a genuine double-submit is expected to be
// rare and left as a manual cleanup if it ever happens, same tradeoff the
// dashboard's manual "add member" form already accepts.
export const completeOnboarding = mutation({
  args: {
    gymName: v.string(),
    city: v.optional(v.string()),
    state: v.optional(v.string()),
    members: v.array(memberRow),
    smsConsentConfirmed: v.boolean(),
  },
  handler: async (ctx, { gymName, city, state, members, smsConsentConfirmed }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const clerkUserId = identity.subject;

    assertMaxLength(gymName, 200, "Gym name");
    assertMaxLength(city, 100, "City");
    assertMaxLength(state, 100, "State");
    assertMaxArrayLength(members, MAX_ONBOARDING_MEMBERS, "Members");
    for (const m of members) {
      assertMaxLength(m.name, 200, "Member name");
      assertMaxLength(m.email, 254, "Member email");
      assertEmailFormat(m.email, "Member email");
      assertMaxLength(m.phone, 30, "Member phone");
      assertMaxLength(m.beltRank, 100, "Member belt rank");
      // Mirrors members.ts:assertSmsConsent — a phone number can't be saved
      // without consent, and the only consent mechanism onboarding has is
      // this one gym-level checkbox covering the whole initial batch.
      if (m.phone && !smsConsentConfirmed) {
        throw new Error("SMS consent must be confirmed before adding a member with a phone number.");
      }
    }

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

    for (const m of members) {
      await ctx.db.insert("members", {
        name: m.name,
        plan: "Member",
        status: "active",
        email: m.email,
        phone: m.phone,
        beltRank: m.beltRank,
        gymId,
        ...(m.phone ? { smsConsentConfirmed: true, smsConsentConfirmedAt: now } : {}),
      });
    }

    return { gymId };
  },
});
