import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { disciplineValidator } from "./beltTaxonomy";

export default defineSchema({
  members: defineTable({
    name: v.string(),
    plan: v.string(),
    status: v.union(v.literal("active"), v.literal("inactive")),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    beltRank: v.optional(v.string()),
    lastVisit: v.optional(v.string()),
    lastRetentionTextAt: v.optional(v.number()),
    smsConsentConfirmed: v.optional(v.boolean()),
    smsConsentConfirmedAt: v.optional(v.number()),
    smsOptedOut: v.optional(v.boolean()),
    // Optional until the backfill migration (convex/migrations.ts) has run for
    // every existing row — see convex/migrations.ts for the tighten-to-required follow-up.
    gymId: v.optional(v.id("gyms")),
    // Populated by CSV import (scripts/import-members.js) and otherwise
    // unused today — no UI reads/writes these yet.
    joinDate: v.optional(v.string()),
    beltPromotionDate: v.optional(v.string()),
  }).index("by_gym", ["gymId"]),
  classes: defineTable({
    name: v.string(),
    instructor: v.string(),
    dayOfWeek: v.string(),
    time: v.string(),
    // Optional until backfilled — see convex/migrations.ts.
    gymId: v.optional(v.id("gyms")),
  }).index("by_gym", ["gymId"]),
  invoices: defineTable({
    memberId: v.id("members"),
    amount: v.number(),
    status: v.union(v.literal("paid"), v.literal("unpaid")),
    dueDate: v.string(),
    // Optional until backfilled — see convex/migrations.ts.
    gymId: v.optional(v.id("gyms")),
  }).index("by_gym", ["gymId"]),
  enrollments: defineTable({
    memberId: v.id("members"),
    classId: v.id("classes"),
  })
    .index("by_class", ["classId"])
    .index("by_member", ["memberId"]),
  attendance: defineTable({
    classId: v.id("classes"),
    memberId: v.id("members"),
    date: v.string(),
    checkedInAt: v.string(),
  })
    .index("by_class_date", ["classId", "date"])
    .index("by_class", ["classId"])
    .index("by_member", ["memberId"]),
  checkIns: defineTable({
    memberId: v.id("members"),
    timestamp: v.number(),
  }).index("by_member", ["memberId"]),
  recoveryTokens: defineTable({
    token: v.string(),
    stripeCustomerId: v.string(),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
  }).index("by_token", ["token"]),
  gyms: defineTable({
    // Optional: guest-checkout rows exist between payment and account
    // creation before being claimed — see convex/subscriptions.ts claim flow.
    clerkUserId: v.optional(v.string()),
    name: v.optional(v.string()),
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
    plan: v.optional(v.string()),
    planStatus: v.optional(v.string()),
    createdAt: v.optional(v.number()),
    // Set by convex/sendRetentionTexts.ts:claimRetentionRunLock. Shared by
    // both the automated cron path and the manual Elite button — a single
    // per-gym cooldown floor beneath both, independent of the per-member
    // lastRetentionTextAt gate on the members table.
    lastRetentionRunAt: v.optional(v.number()),
  })
    .index("by_clerk_user", ["clerkUserId"])
    .index("by_stripe_customer", ["stripeCustomerId"]),
  // Generic fixed-window rate limiter backing convex/rateLimit.ts. `key` is
  // "<bucket>:<identifier>" (e.g. "checkout:203.0.113.4") so unrelated
  // buckets never collide even if an identifier repeats across them.
  rateLimits: defineTable({
    key: v.string(),
    windowStart: v.number(),
    count: v.number(),
  }).index("by_key", ["key"]),
  // One row per (memberId, discipline) — a cross-training member holds
  // multiple rows. Source of truth for belt/rank going forward; the legacy
  // members.beltRank/beltPromotionDate fields are left untouched as a
  // display snapshot populated only by the CSV import path (see
  // migration-assets/beltTaxonomy.json for canonical discipline/belt values).
  ranks: defineTable({
    memberId: v.id("members"),
    gymId: v.id("gyms"),
    discipline: disciplineValidator,
    currentBelt: v.string(),
    currentStripes: v.optional(v.number()),
    promotionDate: v.optional(v.string()),
  })
    .index("by_gym", ["gymId"])
    .index("by_member", ["memberId"])
    .index("by_member_discipline", ["memberId", "discipline"]),
  // `belt` is the rank being promoted INTO, i.e. the requirements to reach
  // that belt from whatever precedes it in the discipline's taxonomy order.
  promotionCriteria: defineTable({
    gymId: v.id("gyms"),
    discipline: disciplineValidator,
    belt: v.string(),
    requiredSessions: v.optional(v.number()),
    requiredDaysAtRank: v.optional(v.number()),
  })
    .index("by_gym", ["gymId"])
    .index("by_gym_discipline_belt", ["gymId", "discipline", "belt"]),
});
