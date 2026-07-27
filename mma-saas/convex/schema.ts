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
    // Winback termination cap. lastRetentionTextAt sets the *cadence* (one
    // text per member per 7 days); these set the *end*: after 3 confirmed
    // sends the member goes dormant and is never texted again until they
    // check in. Both optional with no backfill — undefined winbackAttempts
    // is read as 0 everywhere, so every pre-existing member starts with a
    // full three attempts. Written together by
    // sendRetentionTexts.ts:recordRetentionText, cleared together by
    // members.ts:checkIn.
    winbackAttempts: v.optional(v.number()),
    winbackDormantAt: v.optional(v.number()),
    smsConsentConfirmed: v.optional(v.boolean()),
    smsConsentConfirmedAt: v.optional(v.number()),
    // Which flow most recently stamped smsConsentConfirmed, so a
    // lawyer/carrier question about how a specific member consented is
    // answerable from the member row itself, not by cross-referencing
    // consentSubmissions/consentAttestations. Last-write-wins, mirroring
    // how smsConsentConfirmedAt already behaves (not sticky-to-first).
    smsConsentSource: v.optional(
      v.union(
        v.literal("member_self_serve"),
        v.literal("owner_attestation"),
        v.literal("member_modal")
      )
    ),
    smsOptedOut: v.optional(v.boolean()),
    // Optional until the backfill migration (convex/migrations.ts) has run for
    // every existing row — see convex/migrations.ts for the tighten-to-required follow-up.
    gymId: v.optional(v.id("gyms")),
    // Populated by CSV import (scripts/import-members.js) and otherwise
    // unused today — no UI reads/writes these yet.
    joinDate: v.optional(v.string()),
    beltPromotionDate: v.optional(v.string()),
    // Opaque token embedded in a member's QR/card for check-in. Set when a
    // token is (re)issued; checkInTokenIssuedAt records when, so tokens
    // issued before some cutoff can be bulk-invalidated later if needed.
    checkInToken: v.optional(v.string()),
    checkInTokenIssuedAt: v.optional(v.number()),
    // Stamped once per adminImportBatch call (scripts/import-members.js), so
    // every row from the same CSV run is addressable as a batch — see
    // consentAttestations below, which the bulk-consent UI groups by this.
    importBatchId: v.optional(v.string()),
  })
    .index("by_gym", ["gymId"])
    .index("by_check_in_token", ["checkInToken"]),
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
    // Optional until a backfill migration runs for pre-existing rows —
    // see convex/migrations.ts for the same pattern on members/classes/invoices.
    gymId: v.optional(v.id("gyms")),
    // Set only by offline-queue replays — the moment the member actually
    // scanned client-side, distinct from `timestamp` (server insert time).
    // Undefined for live/online kiosk taps.
    clientScannedAt: v.optional(v.number()),
    // Client-generated key from the offline check-in queue, so a retried
    // mutation call after a dropped ack doesn't insert a second row for
    // the same physical scan. Undefined for live/online taps.
    idempotencyKey: v.optional(v.string()),
  })
    .index("by_member", ["memberId"])
    .index("by_gym", ["gymId"])
    .index("by_gym_timestamp", ["gymId", "timestamp"])
    .index("by_idempotency_key", ["idempotencyKey"]),
  // One row per winback recovery, not per member — a member can lapse and be
  // won back more than once, and members.ts:checkIn's own rearm logic (a
  // returning member gets a clean three attempts) would otherwise destroy
  // the evidence a text led to a return. Captured at the moment of return,
  // before that reset clears winbackAttempts/winbackDormantAt. daysToReturn
  // is stored unrounded (fractional days) so a same-day return isn't
  // truncated to a misleading 0 — round only when displaying it.
  // memberId is not cascade-deleted by members.ts:remove; getWinbackRecoveries
  // falls back to "Unknown Member" the same way invoices.getAll does, since
  // deleting these rows would retroactively shrink a number already quoted
  // to a gym owner.
  winbackRecoveries: defineTable({
    memberId: v.id("members"),
    gymId: v.id("gyms"),
    returnedAt: v.number(), // event time of the qualifying check-in (clientScannedAt ?? server now)
    lastTextedAt: v.number(), // member.lastRetentionTextAt at the moment of return
    attemptsUsed: v.number(), // member.winbackAttempts at the moment of return
    daysToReturn: v.number(), // unrounded (returnedAt - lastTextedAt) / 1 day — round for display only
  })
    .index("by_gym_returnedAt", ["gymId", "returnedAt"])
    .index("by_member", ["memberId"]),
  // One row per bulk-consent attestation event (convex/members.ts:
  // attestBulkConsent), TCPA audit trail. memberIds records exactly which
  // members were stamped by this call, independent of importBatchId
  // grouping in the UI — so the record stays precise even if a future UI
  // change alters how members are grouped/presented for attestation.
  // Inserted unconditionally, even when memberCount is 0: an owner running
  // the flow and confirming nobody needed stamping is still a true event.
  consentAttestations: defineTable({
    gymId: v.id("gyms"),
    attestedByClerkUserId: v.string(),
    attestedAt: v.number(),
    memberCount: v.number(),
    memberIds: v.array(v.id("members")),
    attestationVersion: v.string(),
  }).index("by_gym", ["gymId"]),
  // One row per member self-serve consent submission at /consent/[gymSlug]
  // (convex/consent.ts:submitConsent) — TCPA evidence that this specific
  // person, not the gym owner, opted themselves in. Inserted for every
  // submission regardless of whether it matched an existing member row
  // (memberId left undefined on no-match), so the record survives even if
  // the phone was mistyped or the member hasn't been imported yet.
  // normalizedPhone/consentVersion together back the idempotency check in
  // submitConsent (same person re-submitting the same consent version is a
  // no-op, not a duplicate row). consentText is the verbatim copy shown at
  // submission time (see lib/consentText.ts), captured per-row so a later
  // wording change never rewrites what an already-submitted member agreed to.
  consentSubmissions: defineTable({
    gymId: v.id("gyms"),
    memberId: v.optional(v.id("members")),
    submittedName: v.string(),
    submittedPhone: v.string(),
    normalizedPhone: v.string(),
    consentedAt: v.number(),
    consentText: v.string(),
    consentVersion: v.string(),
    source: v.literal("member_self_serve"),
    ip: v.optional(v.string()),
    userAgent: v.optional(v.string()),
  })
    .index("by_gym", ["gymId"])
    .index("by_gym_phone", ["gymId", "normalizedPhone"]),
  // One row per Stripe event id already processed. Purely a duplicate-delivery
  // guard, NOT replay protection — Stripe's constructEvent already enforces a
  // ~5 minute signature timestamp tolerance, so a captured payload can't be
  // replayed beyond that. What this stops is Stripe's own retry behaviour
  // re-running a handler that isn't idempotent, specifically the customer-facing
  // trial confirmation email in stripeWebhookAction.ts.
  //
  // Retention is deliberately SHORT (30 days) and must not be copied from
  // twilioInboundMessages below, which keeps a year because it genuinely is the
  // security control. Stripe's retry window tops out around 3 days; 30 is an
  // order of magnitude of headroom over that and nothing depends on older rows.
  //
  // Claimed and released by convex/stripeEvents.ts — released rather than left
  // in place when processing fails, so Stripe's retry isn't swallowed as a
  // duplicate and the event lost.
  stripeWebhookEvents: defineTable({
    eventId: v.string(),
    processedAt: v.number(),
  })
    .index("by_event_id", ["eventId"])
    .index("by_processed_at", ["processedAt"]),
  // One row per inbound Twilio message that has been processed, keyed on
  // Twilio's MessageSid (unique per message). This table IS the replay
  // protection for /twilio/inbound. Unlike Stripe's, Twilio's signature scheme
  // carries no timestamp, so there is no tolerance window bounding how long a
  // captured valid POST stays replayable — without this it is forever, and a
  // replayed START would silently clear an opt-out the member set afterwards.
  // Claimed atomically by convex/twilioInbound.ts:claimMessageSid, which also
  // prunes expired rows opportunistically (by_processed_at backs that scan).
  twilioInboundMessages: defineTable({
    messageSid: v.string(),
    processedAt: v.number(),
  })
    .index("by_message_sid", ["messageSid"])
    .index("by_processed_at", ["processedAt"]),
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
    // Owner's email, captured from Clerk at onboarding time (see
    // convex/onboarding.ts) so the monthly winback report
    // (convex/winbackReportEmail.ts) has somewhere to send to without a
    // separate Clerk backend-API lookup at send time. Optional: gyms that
    // predate this field, or never finished onboarding, have none — the
    // report sender skips and logs those rather than failing the whole run.
    email: v.optional(v.string()),
    city: v.optional(v.string()),
    state: v.optional(v.string()),
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
    // Set once the auth-first onboarding wizard (app/onboarding) finishes —
    // distinct from planStatus/billing state. A gym can be onboardingCompleted
    // and still have no active plan (checkout abandoned); dashboard gates on
    // both independently. See convex/onboarding.ts.
    onboardingCompleted: v.optional(v.boolean()),
    // Gym-level attestation collected at onboarding step 3, separate from the
    // per-member members.smsConsentConfirmed/At fields — this is the owner
    // confirming they've obtained consent for the initial roster entered
    // during onboarding, before any of those members exist as rows yet.
    smsConsentConfirmed: v.optional(v.boolean()),
    smsConsentConfirmedAt: v.optional(v.number()),
    // Human-readable public identifier for /consent/[gymSlug] — set once the
    // gym's real name is known (convex/onboarding.ts:completeOnboarding), never
    // the raw Convex document id, so a gym owner can safely paste this into an
    // email or text. Optional: gyms that never completed onboarding have no
    // name yet and so have nothing to slugify — see convex/migrations.ts's
    // backfillGymSlugs for existing rows.
    slug: v.optional(v.string()),
  })
    .index("by_clerk_user", ["clerkUserId"])
    .index("by_stripe_customer", ["stripeCustomerId"])
    .index("by_slug", ["slug"]),
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
