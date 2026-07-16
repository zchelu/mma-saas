import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

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
    // Optional until the backfill migration (convex/migrations.ts) has run for
    // every existing row — see convex/migrations.ts for the tighten-to-required follow-up.
    gymId: v.optional(v.id("gyms")),
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
  })
    .index("by_clerk_user", ["clerkUserId"])
    .index("by_stripe_customer", ["stripeCustomerId"]),
});
