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
    // Soft delete (members.ts:archiveMember). The row is never deleted: the
    // consent/opt-out fields above are TCPA evidence and the privacy policy
    // commits to honoring an opt-out even after a member is "removed" from the
    // gym's roster, which a hard delete would destroy. Both optional with no
    // backfill — undefined reads as "not archived" everywhere, so every
    // pre-existing row stays valid.
    //
    // Every query that lists or counts members filters these out; the
    // deliberate exceptions are documented at their call sites
    // (members.ts:setSmsOptOutByPhone and generateUniqueCheckInToken must
    // still see archived rows). Archived members are excluded from
    // sendRetentionTexts.ts:getAtRiskMembers, so archiving stops texts.
    archived: v.optional(v.boolean()),
    archivedAt: v.optional(v.number()),
    // --- Stripe Connect member billing (dues). See the Connect member-billing
    // spec in the claude.ai project, §2.
    //
    // These bill the MEMBER, for the GYM's dues, on the gym's connected
    // account. That is a different Stripe account and a different money system
    // from gyms.stripeCustomerId/stripeSubscriptionId, which bill the GYM for
    // KombatDesk's own SaaS fee. Keeping the two apart is the whole point.
    //
    // THE NAMING RULE: any id belonging to a connected account carries
    // `Connect`, in locals and variable names too, not just here.
    // gyms.by_stripe_customer backs subscriptions.updatePlanStatusByCustomer —
    // a bare `stripeCustomerId` on this table would sit one table away from a
    // lookup that could flip a gym's SaaS plan status from a member's dues
    // event. The prefix is what keeps the two systems distinguishable by
    // reading, at every call site, without checking which table you're on.
    //
    // members.plan (free-text, above) is left ALONE as display copy — it
    // cannot carry a price, and nothing should try to parse one out of it.
    // planId is the source of truth for money.
    planId: v.optional(v.id("gymPlans")),
    stripeConnectCustomerId: v.optional(v.string()),
    stripeConnectSubscriptionId: v.optional(v.string()),
    duesStatus: v.optional(
      v.union(
        v.literal("active"),
        v.literal("past_due"),
        v.literal("canceled"),
        v.literal("unpaid")
      )
    ),
    // When the most recent dues payment failed, and how many have failed in a
    // row.
    //
    // RANKING INPUT ONLY. Read by getAtRiskMembers to order and explain the
    // at-risk list — a member who missed class AND bounced a payment ranks
    // above either alone. Deliberately NOT part of
    // lib/memberEligibility.ts:isTextEligibleMember, which answers "may we
    // lawfully text this person" (consent, opt-out, archived) and feeds
    // getTextableCount, the "Can be texted" tile and the /members Texts
    // column — the numbers quoted against the "Up to 5 automated msgs/month"
    // disclosure. Eligibility and priority must not be the same predicate.
    //
    // Durable until resolved, which is what qualifies it for the at-risk list
    // at all: the durable-states-only rule in getAtRiskMembers' header comment
    // exists so a roster badge can't flicker between page loads.
    duesFailedAt: v.optional(v.number()),
    duesFailureCount: v.optional(v.number()),
    // --- Documents & Waivers (convex/documents.ts).
    //
    // Calendar date, "YYYY-MM-DD" — NOT a timestamp. A date of birth has no
    // time and no timezone, and storing it as a number would reintroduce the
    // UTC off-by-one that lib/localDate.ts documents four times, on the one
    // field where being a day out can flip whether a child is allowed to sign
    // their own liability waiver. Parsed only through
    // lib/documents.ts:parseCalendarDate, never `new Date(dob)`.
    //
    // This is what makes minor detection possible at all: signDocument
    // computes age from this against gyms.minorAgeThreshold and refuses to
    // sign a guardian-requiring document when it's absent, rather than
    // assuming the signer is an adult.
    //
    // Optional, following the same optional-until-backfilled convention as
    // gymId above — every existing member row predates this field. There is
    // deliberately no backfill: a date of birth cannot be inferred, only
    // asked for, which is what the signing step does.
    dob: v.optional(v.string()),
    // WAS THIS DATE OF BIRTH TYPED BY WHOEVER WAS HOLDING THE TABLET?
    //
    // The kiosk is unauthenticated and hands the device to the signer, so the
    // date it collects is self-reported and nobody at the gym has checked it.
    // That matters more here than anywhere else in this schema: `dob` above is
    // the single input to the guardian rule, so a 12-year-old who types an
    // adult date has quietly disabled their own guardian requirement, and
    // nothing in the product would ever have said so.
    //
    // No software can verify an age at a kiosk. What it can do is refuse to
    // pretend it did. This field makes the gap visible and closeable rather
    // than silent: the owner sees "not checked" against that member and
    // confirms or corrects it at the desk.
    //
    // DELIBERATELY NOT `dobVerified`. Only ever written as `true`, and only by
    // the two kiosk paths that write a date nobody checked — same convention as
    // smsOptedOut. A `dobVerified` field would instead assert something nobody
    // actually did, and would need every future write path to remember to set
    // it in order to stay honest.
    //
    // NO BACKFILL, and here is the specific reason rather than a hand-wave:
    // absent means "not written by a kiosk path", which is only equivalent to
    // "the owner typed it" because the kiosk paths that could have written a
    // date have never run against production. Both of them
    // (documents.createMemberFromKiosk, and signDocument's fill-in branch)
    // arrived with Documents & Waivers, whose frontend never reached Vercel
    // until 2026-08-11 — /kiosk/signup returned 404 the whole time — and
    // production still has no waiver template at all, so no signature has ever
    // been taken. The unflagged-kiosk-date cohort is empty in production.
    //
    // IT IS NOT NECESSARILY EMPTY ON THE DEV DEPLOYMENT, where the flow was
    // exercised by hand. Dev rows reading as owner-entered is harmless. If a
    // kiosk date is ever found on a production row with no flag, that is a
    // migration, not a mystery.
    //
    // Cleared by members.ts:confirmDob (the owner says the date is right) or by
    // members.ts:update changing the date to a different value (the owner
    // looked at it and typed a correction). Never cleared by an unauthenticated
    // caller — that would let the kiosk mark its own work as checked.
    //
    // NOT A GATE. It must never block a check-in, a signature or a signup:
    // every new kiosk member starts out flagged, so gating on it would break
    // the front door for exactly the people the kiosk exists to serve.
    dobUnverified: v.optional(v.boolean()),
    // WHO said the date was right, and when.
    //
    // Clearing dobUnverified on its own destroys the only thing that was known
    // and records nothing in its place: afterwards, a date an owner checked
    // against a birth certificate is byte-identical to one they clicked past.
    // This pair is the same evidence smsConsentSource/smsConsentConfirmedAt
    // carry for a smaller stake — and the stake here is whether a child signed
    // a liability release alone, which is the question a dispute actually asks.
    //
    // Written together by members.ts:confirmDob and by members.ts:update when
    // the owner changes the date (typing a value is its own attestation).
    // Clerk user id rather than a name: names change, and this has to stay
    // answerable from the row alone months later.
    dobConfirmedAt: v.optional(v.number()),
    dobConfirmedByClerkUserId: v.optional(v.string()),
    // Free-text, single field, on purpose. It exists to fill the
    // {{member_address}} placeholder in a waiver the gym wrote — it is not
    // structured for shipping, tax, or Stripe, and nothing should try to
    // parse a city or postcode out of it.
    address: v.optional(v.string()),
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
  // The MANUAL ledger — an owner types an amount and a due date and toggles
  // status by hand. No processor, no payment link, no reconciliation. Stripe-
  // backed dues live in `duesInvoices` below and must never be mixed in here:
  // different lifecycle, different write path, different source of truth.
  invoices: defineTable({
    memberId: v.id("members"),
    // DOLLARS, AS A FLOAT — not cents. app/invoices/invoice-modal.tsx writes
    // this from a `type="number" step="0.01"` input through Number(), so 150.00
    // means $150.00. Left exactly as it is on purpose.
    //
    // Every money field added to this codebase from 2026-08-09 on carries a
    // `Cents` suffix and is an integer (see duesInvoices/gymPlans). This field
    // predates that rule and is the reason for it: an integer-cents field
    // sitting next to a dollars float with a near-identical name is a silent
    // 100x billing error. Do not add money fields to this table.
    amount: v.number(),
    status: v.union(v.literal("paid"), v.literal("unpaid")),
    dueDate: v.string(),
    // Optional until backfilled — see convex/migrations.ts.
    gymId: v.optional(v.id("gyms")),
  }).index("by_gym", ["gymId"]),
  // Gym-defined membership plans — what a gym charges its own members, priced
  // on that gym's CONNECTED Stripe account. Distinct from lib/plans.ts, which
  // is KombatDesk's own SaaS tiers (academy/fightteam/blackbelt).
  //
  // New table, so fields are required: the optional-until-backfilled pattern
  // on members.gymId et al. exists to avoid invalidating rows that already
  // exist, and there are none here.
  gymPlans: defineTable({
    gymId: v.id("gyms"),
    name: v.string(), // "Adult Unlimited", "Kids 2x/week"
    // INTEGER cents. Never a float. See the invoices.amount comment above.
    amountCents: v.number(),
    interval: v.union(v.literal("month"), v.literal("year")),
    // Stripe Price id on the CONNECTED account, not the platform account.
    // Optional because the row is written before the Price is created, and a
    // plan whose Stripe Price creation failed must still be visible and
    // fixable rather than lost.
    stripeConnectPriceId: v.optional(v.string()),
    active: v.boolean(),
  }).index("by_gym", ["gymId"]),
  // Stripe-mirrored dues invoices. Deliberately NOT the `invoices` table above.
  //
  // Written only from the Connect webhook — this table mirrors Stripe, it is
  // never the origin of a fact. `status` uses Stripe's own vocabulary rather
  // than the paid/unpaid pair `invoices` uses, so a value never has to be
  // translated on the way in and silently lose a state (uncollectible and void
  // are not "unpaid").
  duesInvoices: defineTable({
    gymId: v.id("gyms"),
    memberId: v.id("members"),
    stripeConnectInvoiceId: v.string(),
    amountDueCents: v.number(), // INTEGER cents
    amountPaidCents: v.number(), // INTEGER cents
    status: v.union(
      v.literal("draft"),
      v.literal("open"),
      v.literal("paid"),
      v.literal("uncollectible"),
      v.literal("void")
    ),
    hostedInvoiceUrl: v.optional(v.string()),
    paidAt: v.optional(v.number()),
  })
    .index("by_gym", ["gymId"])
    .index("by_member", ["memberId"])
    // The upsert key — the webhook looks a row up by Stripe's id before
    // deciding to insert or patch, so redelivery can't create a second row.
    .index("by_stripe_connect_invoice", ["stripeConnectInvoiceId"]),
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
    // Which class this walk-in was for, when the kiosk had one selected.
    //
    // Before this existed, the kiosk and the classes page recorded the same
    // physical event into two tables that never met: the kiosk wrote checkIns
    // (no class), while attendance rows — the only per-class record — were
    // created solely by a coach hitting "mark all present". A gym that put the
    // kiosk at the door, which is exactly what we tell them to do, saw every
    // class sit at zero attendance forever. lastVisit is patched either way so
    // at-risk detection was never affected; it was only the class-level view
    // that was blind.
    //
    // Optional on purpose and permanently: open mat, off-hours training, and
    // gyms that don't run a fixed schedule are all legitimate check-ins with no
    // class attached. Never make this required.
    classId: v.optional(v.id("classes")),
    // The kiosk tablet's own local calendar date, "YYYY-MM-DD".
    //
    // `timestamp` is absolute, and this deployment runs in UTC — so a 6pm
    // Denver check-in carries a timestamp that is already the NEXT day in UTC.
    // Bucketing kiosk check-ins by date server-side would therefore file every
    // evening class on the wrong day, which is most of them. attendance.date
    // has always been a local date string supplied by the client; this is the
    // same contract, so the two sources can be matched against each other
    // without a timezone field on gyms.
    localDate: v.optional(v.string()),
  })
    .index("by_member", ["memberId"])
    .index("by_gym", ["gymId"])
    .index("by_gym_timestamp", ["gymId", "timestamp"])
    .index("by_class", ["classId"])
    .index("by_idempotency_key", ["idempotencyKey"]),
  // One row per winback recovery, not per member — a member can lapse and be
  // won back more than once, and members.ts:checkIn's own rearm logic (a
  // returning member gets a clean three attempts) would otherwise destroy
  // the evidence a text led to a return. Captured at the moment of return,
  // before that reset clears winbackAttempts/winbackDormantAt. daysToReturn
  // is stored unrounded (fractional days) so a same-day return isn't
  // truncated to a misleading 0 — round only when displaying it.
  // Nothing cascade-deletes these rows by memberId — members are archived, not
  // hard-deleted (see members.ts:archiveMember), so the referenced member row
  // survives. getWinbackRecoveries still falls back to "Unknown Member" the
  // same way invoices.getAll does, since deleting these rows would
  // retroactively shrink a number already quoted to a gym owner.
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
    // "keyword" is the SMS text-in opt-in path from the env-boundary-verify
    // branch (commit 6dc4209). ITS CODE IS NOT ON THIS BRANCH — only the
    // shape, so the schema can describe rows that already exist.
    //
    // Why that's necessary rather than tidy: Convex validates the ENTIRE
    // schema against existing data before accepting any push, and the dev
    // deployment already holds a keyword row written on 2026-08-04. Without
    // this literal every push from master fails, for every lane, which is
    // exactly what happened — the deployment went un-deployed for six days
    // and both the documents and Connect lanes were silently blocked.
    //
    // When that branch merges, this is already correct and needs no change.
    // If it is ever abandoned instead, delete the literal AND the rows
    // together, not the literal alone.
    source: v.union(v.literal("member_self_serve"), v.literal("keyword")),
    // Same origin, same reasoning. Both optional and written only by the
    // keyword path: messageSid is Twilio's id for the inbound text that
    // carried the opt-in, and gymResolvedBy records how that text was
    // attributed to a gym ("sms_code" — see gyms.smsCode below).
    messageSid: v.optional(v.string()),
    gymResolvedBy: v.optional(v.string()),
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
  // Duplicate-delivery guard for the CONNECT webhook, exactly mirroring
  // stripeWebhookEvents above — same 30-day retention, same claim/release
  // discipline, same reasoning.
  //
  // A separate table, and NOT because ids could collide: Stripe's `evt_` ids
  // are globally unique, so one table would work. It is for operational
  // isolation. The platform stream is load-bearing for provisioning a gym that
  // has already paid; the dues stream must be purgeable, replayable and
  // debuggable without any chance of disturbing it.
  stripeConnectWebhookEvents: defineTable({
    eventId: v.string(),
    processedAt: v.number(),
  })
    .index("by_event_id", ["eventId"])
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
    // The owner's own wording for the AUTOMATIC winback text. Unset means the
    // built-in default in convex/sendRetentionTexts.ts is used, so existing
    // gyms need no backfill.
    //
    // Until this existed the automatic message was hardcoded, which meant a
    // text went out in the gym owner's name, to their member, in words they
    // had never seen and could not change. Manual sends were always
    // owner-composed; only the cron path was locked.
    //
    // Supports the same {name} token as a manual send. The STOP footer is
    // appended server-side and is NOT part of this string — an owner must not
    // be able to ship a message with no opt-out instructions.
    retentionMessageTemplate: v.optional(v.string()),
    // --- Stripe Connect member billing. NOTE the two fields above,
    // stripeCustomerId and stripeSubscriptionId: those are the PLATFORM
    // account — this gym's own KombatDesk SaaS subscription. Everything below
    // is the gym's CONNECTED account, where it bills its own members. Unset
    // for every gym that hasn't onboarded to Connect, which today is all of
    // them.
    stripeConnectAccountId: v.optional(v.string()),
    // Mirrored from Stripe by the account.updated webhook — never written
    // optimistically at onboarding time. Express onboarding is routinely
    // abandoned partway, leaving a real account that cannot charge, so
    // "we created an account" and "this gym can take money" are different
    // facts. Nothing may create a charge until connectChargesEnabled is true.
    connectChargesEnabled: v.optional(v.boolean()),
    connectPayoutsEnabled: v.optional(v.boolean()),
    connectOnboardedAt: v.optional(v.number()),
    // IANA zone, e.g. "America/Denver". Collected during Connect onboarding,
    // defaulted from the browser and confirmable by the owner.
    //
    // lib/localDate.ts says there is deliberately no timezone on gyms because
    // "the device is physically in the gym, so its clock is the gym's clock."
    // That is correct for attendance and the kiosk and does NOT extend here: a
    // member-facing renewal date is server-rendered into an email, for a gym
    // that may not be in Colorado, with no device in the loop whose clock we
    // could borrow. stripeWebhookAction.ts hardcodes America/Denver, which is
    // right for our own SaaS billing (the seller is in Colorado) and wrong the
    // moment the seller is a gym in Tampa.
    //
    // Do not "unify" this with localDate.ts. They answer different questions:
    // what day is it where the device is, versus what day will this specific
    // human be charged. The second one shipped wrong once already, inside a
    // statutory disclosure.
    timezone: v.optional(v.string()),
    // v2's per-configuration status, stored ALONGSIDE connectChargesEnabled /
    // connectPayoutsEnabled rather than replacing them. Do not widen those
    // booleans into these.
    //
    // Measured on a real unonboarded account 2026-08-13: card_payments comes
    // back `status: "restricted"` with
    // `status_details: [{ code: "requirements_past_due", ... }]` — NOT
    // "pending". Four states exist (active | pending | restricted |
    // unsupported) and the booleans flatten pending and restricted both to
    // false, which is exactly the distinction an owner reading "Setup
    // incomplete" needs.
    //
    // BOTH ARE v.string(), never a v.union, and that is deliberate. Stripe's
    // status and code vocabularies grow; a union would fail schema validation
    // ON WRITE the first time they add a value, which is strictly worse than
    // not having the data. This session hit the typings-are-wider-than-the-API
    // trap three times (requirements_collector, application_express,
    // stripe_balance) — the same lesson pointed at our own schema.
    //
    // Codes are captured, NOT branched on. Stripe's notification_banner
    // component does the remediation prompting; these exist to decide what the
    // dashboard card says and, later, to find gyms stuck mid-onboarding without
    // opening each one. Capture now, interpret when there is a reason.
    connectChargesStatus: v.optional(v.string()),
    connectChargesStatusCodes: v.optional(v.array(v.string())),
    connectPayoutsStatus: v.optional(v.string()),
    connectPayoutsStatusCodes: v.optional(v.array(v.string())),
    // Age below which a signer needs a parent/guardian signature on any
    // document whose template sets requiresGuardianForMinors. Per gym because
    // it isn't a fact about the world — it's whatever the gym's own waiver
    // and its state's rule on parental consent say, and a gym that runs a
    // separate teen program may set it lower than 18.
    //
    // Optional with no backfill; every read goes through
    // documents.ts:minorAgeThresholdFor, which applies
    // lib/documents.ts:DEFAULT_MINOR_AGE_THRESHOLD (18). Deliberately NOT
    // defaulted by a migration: `18` written onto a row and `18` implied by
    // an absent field mean the same thing here, and a backfill would only
    // create a second place for the default to disagree with itself.
    minorAgeThreshold: v.optional(v.number()),
    // THE CREDENTIAL THE FRONT-DESK TABLET CARRIES.
    //
    // Every kiosk function (check-in, new-member signup, waiver signing) is
    // unauthenticated by necessity — the device at the door has no Clerk
    // session. They used to take a raw `gymId`, which meant the gym's own
    // document id, pasted into a bookmark, WAS the credential: anyone holding
    // a kiosk URL could enumerate the roster through members.getActiveForGym
    // and then read each member's date of birth, home address and minor
    // status through documents.getUnsignedRequiredDocs. Children included.
    //
    // This replaces it. The token is what the URL carries, the gym is resolved
    // from it server-side (gyms.ts:requireKioskGym), and a gym id on its own
    // now opens nothing. Rotating it (gyms.ts:rotateKioskToken) invalidates
    // every bookmarked kiosk URL at once, which is the control an owner needs
    // when a tablet is lost or an ex-coach still has the link.
    //
    // Optional, and no backfill: a gym without one simply has no working kiosk
    // URL until the owner generates it from the dashboard. That is the safe
    // direction — the alternative is auto-issuing a credential nobody asked
    // for and nobody knows exists.
    //
    // NOT the same thing as members.checkInToken, which identifies ONE member
    // for a QR/card scan. This identifies the DEVICE's right to talk to the
    // kiosk API at all. Both can be present; they answer different questions.
    kioskToken: v.optional(v.string()),
    kioskTokenIssuedAt: v.optional(v.number()),
    // The gym's short SMS opt-in code, from the env-boundary-verify branch
    // (commit 6dc4209). Present on all 14 rows of the dev deployment, so the
    // schema has to describe it — see the note on consentSubmissions.source
    // above for why a missing field here blocks every push, not just its own
    // lane. No code on this branch reads or writes it.
    //
    // The branch also adds a by_sms_code index. That is deliberately NOT
    // copied here: an index is only needed by the lookup code, which isn't on
    // this branch either, and adding one changes what the deployment builds.
    // The field alone is what unblocks validation.
    smsCode: v.optional(v.string()),
  })
    .index("by_clerk_user", ["clerkUserId"])
    // PLATFORM customer ids only. A connected-account customer id must never
    // reach this index — see the naming rule on members.stripeConnectCustomerId.
    .index("by_stripe_customer", ["stripeCustomerId"])
    .index("by_slug", ["slug"])
    .index("by_kiosk_token", ["kioskToken"])
    // The Connect webhook (convex/connectWebhookAction.ts) receives an
    // account.updated event carrying only the CONNECTED-account id, so this is
    // the only way it can find the gym. Without it that lookup is a full table
    // scan on every account.updated Stripe sends, and Stripe sends them often
    // during onboarding.
    //
    // Distinct from by_stripe_customer above, which is PLATFORM customer ids —
    // see the naming rule. Nothing may look a connected-account id up in that
    // index or a member's dues event could flip a gym's SaaS plan status.
    .index("by_stripe_connect_account", ["stripeConnectAccountId"]),
  // Every winback text this product has actually sent.
  //
  // There was no such record. Texts went out and the ONLY copy of what was
  // said, to whom, and when lived in Twilio's message log, which ages out on a
  // retention window we don't control. That failed in two directions: the
  // Saved Member Guarantee requires showing an owner the text that brought a
  // member back, and a TCPA complaint months later needs evidence of exactly
  // what was sent and that consent preceded it.
  //
  // Written from sendRetentionTexts.ts inside the `res.ok` branch only, in the
  // same mutation that advances the winback counter — so a row exists if and
  // only if Twilio accepted the message, and the count and the record can
  // never disagree.
  sentTexts: defineTable({
    gymId: v.id("gyms"),
    memberId: v.id("members"),
    // The exact body handed to Twilio, opt-out footer included. Stored rather
    // than reconstructed: the template can change afterwards, and the whole
    // point is what was sent at the time.
    body: v.string(),
    sentAt: v.number(),
    // Twilio's message SID, for cross-referencing their log while it still
    // exists. Optional — a send is recorded even if the response body can't be
    // parsed, since losing the SID is far better than losing the record.
    twilioSid: v.optional(v.string()),
    // Which path sent it. "automatic" is the daily cron; "manual" is the
    // owner pressing Send Retention Texts.
    kind: v.union(v.literal("automatic"), v.literal("manual")),
  })
    .index("by_gym", ["gymId"])
    .index("by_member", ["memberId"])
    .index("by_gym_sentAt", ["gymId", "sentAt"]),
  // Documents & Waivers — the gym's own document text. See convex/documents.ts.
  //
  // THE GYM OWNER SUPPLIES `content`. This product does not generate legal
  // language and must not start: we build the signing rail, not the document.
  //
  // New table, so fields are required — the optional-until-backfilled pattern
  // on members.gymId exists to avoid invalidating rows that already exist, and
  // there are none here.
  documentTemplates: defineTable({
    gymId: v.id("gyms"),
    title: v.string(),
    // Supports the {{placeholder}} tokens listed in
    // lib/documents.ts:PLACEHOLDER_KEYS. Stored UNRESOLVED — resolution
    // happens once, at signing time, into signedDocuments.renderedContent.
    content: v.string(),
    // The gym's liability waiver: the one document that gates check-in, and
    // the one that cannot be deleted (documents.ts:deleteTemplate). Exactly
    // one row per gym may carry this, enforced in createTemplate, and it is
    // deliberately not editable afterwards — flipping it would change what
    // gates the door for every member at once, and demoting the waiver would
    // be a back door around the delete block.
    isWaiver: v.boolean(),
    // When true, a signer under gyms.minorAgeThreshold must also capture a
    // parent/guardian name and signature. Per template, because a gym's photo
    // release and its liability waiver do not necessarily have the same rule.
    requiresGuardianForMinors: v.boolean(),
    // Must this be signed before the member is let onto the mats? This — not
    // isWaiver — is what gates check-in (documents.ts:isRequired). The two
    // were conflated at first, which meant a gym could not add a second
    // mandatory document, and could not add an optional one at all without it
    // becoming "the waiver".
    //
    // OPTIONAL, against the letter of the spec, and deliberately: this table
    // already holds rows on the dev deployment, and Convex validates the whole
    // schema against existing data before accepting any push — a required
    // boolean here rejects the push outright, which is exactly the class of
    // failure that blocked every lane for six days on 2026-08-05. Same
    // optional-until-backfilled convention as members.gymId, classes.gymId and
    // invoices.gymId above. Absent reads as `isWaiver`, which is precisely the
    // behaviour those rows were created under, so no backfill is needed and
    // nothing changes for them.
    requiredAtSignup: v.optional(v.boolean()),
    createdAt: v.number(),
  }).index("by_gym", ["gymId"]),
  // One row per signature event. THE EVIDENCE.
  //
  // renderedContent is the whole point of this table's shape: it is the
  // document text with placeholders already resolved, frozen at the instant
  // of signing. Nothing re-renders a signed record from its template. An
  // owner correcting a typo in the waiver next month must not retroactively
  // alter what a member put their name to — that would make every signed
  // record in the gym worthless as evidence at the same moment, silently.
  // documents.ts:updateTemplate therefore touches no row here, and
  // deleteTemplate does not cascade: these rows outlive their template and
  // stay fully readable without it.
  //
  // Rows are never deleted, for the same reason members are archived rather
  // than hard-deleted (see members.archived): a waiver signed by someone who
  // has since left the gym is exactly the record a liability claim asks for.
  signedDocuments: defineTable({
    gymId: v.id("gyms"),
    memberId: v.id("members"),
    templateId: v.id("documentTemplates"),
    renderedContent: v.string(),
    // base64 PNG data URL from the canvas pad
    // (app/components/signature-pad.tsx). Validated for shape and size by
    // lib/documents.ts:isValidSignatureData before it reaches this table —
    // PNG only, so no script-bearing SVG data URL can end up as an <img src>
    // on the screen an owner would show a lawyer.
    signatureData: v.string(),
    // What the signer typed, which is not necessarily members.name — the
    // roster may say "Maya" and the signature block should carry the legal
    // name she printed.
    signerName: v.string(),
    // Both set together or neither. Present when the signer was under the
    // gym's minorAgeThreshold at signing time and the template required a
    // guardian. Optional rather than a nested object so the absence of a
    // guardian on an adult's waiver is simply an absent field.
    guardianName: v.optional(v.string()),
    guardianSignatureData: v.optional(v.string()),
    // Had anyone at the gym checked the signer's date of birth, AS OF THIS
    // SIGNING? Frozen here for the same reason renderedContent is: this row is
    // evidence, and what the gym knew later is not what the gym knew then. An
    // owner who confirms a date next week must not retroactively make an
    // unchecked signature look checked.
    //
    // Says only that the date was unchecked — NOT that it decided a guardian
    // question. It is set whenever the signer's date was unchecked, including
    // on templates with requiresGuardianForMinors false, where no guardian rule
    // ran at all. The date can still matter there ({{member_dob}} prints into
    // the text), so the flag is worth setting; claiming more than that would be
    // false on exactly those documents.
    //
    // Copied from members.dobUnverified at insert time and, like it, only ever
    // written as `true`. Absent means the age came from a date the owner had
    // entered themselves. See the comment on members.dobUnverified.
    signerDobUnverified: v.optional(v.boolean()),
    signedAt: v.number(),
    // Deliberately UNSET by the current signing path, not merely unused.
    // Convex mutations cannot see the caller's address, and the kiosk is
    // unauthenticated — accepting an IP as a client argument would put a
    // self-asserted string into the one field whose entire value is being
    // trustworthy. The field stays so a future server-side signing route can
    // populate it from an edge-verified header, the way
    // convex/consent.ts:submitConsent already receives `ip`.
    ipAddress: v.optional(v.string()),
  })
    .index("by_gym_member", ["gymId", "memberId"])
    .index("by_gym_template", ["gymId", "templateId"]),
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
