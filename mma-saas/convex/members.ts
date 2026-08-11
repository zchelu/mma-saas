import { query, mutation, internalMutation, MutationCtx } from "./_generated/server";
// Id is used only as a type, by numberHasOptOutOnRecord's excludeId parameter.
// Its absence did not fail a single test: vitest transpiles without
// typechecking, so 8/8 green said nothing about whether this file compiles.
// `npx tsc --noEmit` is the check that catches this class of error.
import { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { requireGym, requireWriteAccess, tryGetGym, tryGetReadableGym } from "./gyms";
import { assertMaxLength, assertEmailFormat } from "./validate";
import { consumeRateLimit } from "./rateLimit";
import { validateRank, disciplineValidator } from "./beltTaxonomy";
import { MAX_WINBACK_ATTEMPTS, WINBACK_ATTRIBUTION_WINDOW_DAYS } from "./sendRetentionTexts";
import { isTextEligibleMember } from "../lib/memberEligibility";
import { parseCalendarDate } from "../lib/documents";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Gym-scoped, narrowed the same way getActiveForGym/getUnconfirmedImportedMembers
// are — no checkInToken (kiosk check-in credential). It's the owner's own
// data, not a tenant leak, but the dashboard's members list/modals/history
// drawer (app/members/page.tsx's Member type) never need the credential, so
// it shouldn't ship to the client at all.
export const getAll = query({
  args: {},
  handler: async (ctx) => {
    const gym = await tryGetReadableGym(ctx);
    if (!gym) return [];
    const members = await ctx.db
      .query("members")
      .withIndex("by_gym", (q) => q.eq("gymId", gym._id))
      .order("desc")
      .filter((q) => q.neq(q.field("archived"), true))
      .collect();
    return members.map((m) => ({
      _id: m._id,
      name: m.name,
      plan: m.plan,
      status: m.status,
      email: m.email,
      phone: m.phone,
      beltRank: m.beltRank,
      lastVisit: m.lastVisit,
      // Needed by the member modal so an owner can fill in or correct either
      // one, and by nothing else on the /members screen. Both are already the
      // owner's own data — this is the authenticated, gym-scoped query, not
      // the kiosk's narrowed getActiveForGym, which deliberately still ships
      // neither.
      dob: m.dob,
      address: m.address,
      smsConsentConfirmed: m.smsConsentConfirmed,
      smsConsentConfirmedAt: m.smsConsentConfirmedAt,
      // Needed by the Members table's "Texts" column to tell "this member told
      // us to stop" apart from "we never asked them". Without it both render as
      // simply not-textable, and the owner can't see which ones are worth
      // sending the opt-in link to — which is the entire point of that column.
      // Read-only in the sense that matters: no field in the UI sets it, and an
      // inbound START from the member's own handset is the only thing that
      // clears it for a number we still hold
      // (convex/twilioWebhookAction.ts -> members.setSmsOptOutByPhone).
      //
      // The one other path that writes it is members.update, and only when the
      // member's number is REPLACED with a different one that carries no
      // opt-out of its own — because at that point the flag is describing a
      // number this member no longer has. It used to fire on any raw-string
      // difference, so reformatting a number cleared a live STOP; see the long
      // comment on that mutation. Do not restate this as "nothing in the app
      // can clear it" — that was wrong for weeks and shipped into a tooltip.
      smsOptedOut: m.smsOptedOut,
      // Feeds the Texts column's "Dormant" state — this member has used every
      // winback attempt of the current cold streak, so the automatic sequence
      // has stopped even though they're still perfectly reachable. Same field
      // getDormantMembers below filters on, and the same one
      // getAtRiskMembers returns, so the Members table and the dashboard's At
      // Risk panel render that state from identical inputs.
      winbackAttempts: m.winbackAttempts,
    }));
  },
});

export const getActiveCount = query({
  args: {},
  handler: async (ctx) => {
    const gym = await tryGetGym(ctx);
    if (!gym) return 0;
    const active = await ctx.db
      .query("members")
      .withIndex("by_gym", (q) => q.eq("gymId", gym._id))
      .filter((q) => q.eq(q.field("status"), "active"))
      .filter((q) => q.neq(q.field("archived"), true))
      .collect();
    return active.length;
  },
});

// The dashboard's "Can be texted" tile — how many members would actually
// receive a retention text right now, same predicate as
// sendRetentionTexts.ts:getAtRiskMembers's send gate (minus its transient
// 7-day/attempts gates) and app/members/page.tsx's Texts column, via
// lib/memberEligibility.ts. This replaced a tile that read
// consent.ts:getConsentStats — a count of public-form submissions that
// stayed at 0 for consent recorded through the member modal or the bulk
// attestation panel, and that still climbed for a submission that matched no
// roster member and made nobody textable. See getConsentStats for why that
// number still exists (it's a genuine audit-trail count) and why it
// shouldn't be shown to an owner as "members opted in".
//
// tryGetGym, not requireGym — this renders in StatsGrid ("use client") via
// useQuery, so it fires before Clerk's client-side session has hydrated.
// requireGym throws a plain Error there, which production redacts to a
// generic "Server Error" and — with no error boundary on the route — took
// the whole dashboard down once already (518ad18). getConsentStats and its
// three sibling stat cards all use tryGetGym for exactly this reason.
export const getTextableCount = query({
  args: {},
  handler: async (ctx) => {
    const gym = await tryGetGym(ctx);
    if (!gym) return 0;
    const members = await ctx.db
      .query("members")
      .withIndex("by_gym", (q) => q.eq("gymId", gym._id))
      .collect();
    return members.filter(isTextEligibleMember).length;
  },
});

const memberFields = {
  name: v.string(),
  plan: v.string(),
  status: v.union(v.literal("active"), v.literal("inactive")),
  email: v.optional(v.string()),
  phone: v.optional(v.string()),
  beltRank: v.optional(v.string()),
  smsConsentConfirmed: v.optional(v.boolean()),
  smsConsentConfirmedAt: v.optional(v.number()),
  // Calendar date, "YYYY-MM-DD" — see the schema comment on members.dob. Owner
  // -editable here so a gym can fill it in from their paper records ahead of a
  // kids' class; the kiosk signing step also collects it when it's missing,
  // because convex/documents.ts:signDocument refuses to sign a guardian-
  // requiring document for a member whose age it can't determine.
  dob: v.optional(v.string()),
  address: v.optional(v.string()),
};

// Normalizes the two calendar/text fields the documents feature added, and
// returns ONLY the keys the caller actually sent.
//
// Two separate hazards, both about the difference between "not mentioned" and
// "cleared":
//
//   - `patch({ dob: "" })` would store an empty string, which
//     lib/documents.ts:parseCalendarDate reads as "no date of birth" — the
//     same meaning as an absent field, in a second representation. One of
//     them is enough.
//   - `patch({ dob: undefined })` DELETES the field. So a helper that always
//     emits a `dob` key turns any partial update that didn't mention a date of
//     birth into an erasure of the one value the guardian rule depends on.
//     Emitting the key only when a string actually arrived keeps "omitted"
//     and "cleared" apart: omitted leaves the stored value alone, and an
//     explicit "" clears it.
function normalizedDocumentFields(fields: { dob?: string; address?: string }): {
  dob?: string;
  address?: string;
} {
  const out: { dob?: string; address?: string } = {};
  if (typeof fields.dob === "string") out.dob = fields.dob.trim() || undefined;
  if (typeof fields.address === "string") out.address = fields.address.trim() || undefined;
  return out;
}

function assertSmsConsent(fields: { phone?: string; smsConsentConfirmed?: boolean }) {
  if (fields.phone && !fields.smsConsentConfirmed) {
    throw new Error("SMS consent must be confirmed before saving a phone number");
  }
}

function validateMemberFields(fields: {
  name: string;
  plan: string;
  email?: string;
  phone?: string;
  beltRank?: string;
  dob?: string;
  address?: string;
}) {
  assertMaxLength(fields.name, 200, "Name");
  assertMaxLength(fields.plan, 100, "Plan");
  assertMaxLength(fields.email, 254, "Email");
  assertEmailFormat(fields.email, "Email");
  assertMaxLength(fields.phone, 30, "Phone");
  assertMaxLength(fields.beltRank, 100, "Belt rank");
  assertMaxLength(fields.address, 500, "Address");
  // Reached only AFTER normalizedDocumentFields has run at both call sites, so
  // a cleared field is already `undefined` here and never "" — checking for
  // the empty string again would be dead code. What's left has to be a real
  // calendar date: an unparseable one would make documents.ts:signDocument
  // treat the member's age as unknown, and the gym would find that out at the
  // door rather than here.
  if (fields.dob !== undefined && !parseCalendarDate(fields.dob)) {
    throw new Error("Date of birth must be a valid date.");
  }
}

// CSPRNG, not Math.random — Web Crypto's getRandomValues (Node's
// crypto.randomBytes isn't available outside a "use node" action). 20 random
// bytes -> 40 hex characters, well above the 20-char floor; hex is
// inherently URL-safe so there's no padding/charset edge case like base64url
// has.
function generateCheckInToken(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Loops on the (astronomically unlikely) chance generateCheckInToken()
// collides with an existing token, checked against the by_check_in_token
// index rather than trusted blind. Capped so a persistent index/index-write
// bug fails loudly instead of hanging the mutation.
export async function generateUniqueCheckInToken(ctx: MutationCtx): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateCheckInToken();
    const collision = await ctx.db
      .query("members")
      .withIndex("by_check_in_token", (q) => q.eq("checkInToken", candidate))
      .unique();
    if (!collision) return candidate;
  }
  throw new Error("Failed to generate a unique check-in token after 5 attempts");
}

// Does any member row OTHER than excludeId already carry an opt-out for this
// number? Shared by add and update, which both need it for the same reason and
// would otherwise drift.
//
// Opt-out state is number-scoped but stored redundantly on member rows —
// setSmsOptOutByPhone patches every row holding the number, archived ones
// included. So "has this number told us to stop" is a question about the whole
// members table, not about one row, and every path that puts a number ONTO a
// row has to ask it. Same full-table scan and same cross-gym scope as
// setSmsOptOutByPhone, deliberately: an inheritance rule narrower than the
// write rule it mirrors leaves a way back in.
//
// Archived rows are included for the same reason setSmsOptOutByPhone doesn't
// skip them — the privacy policy commits to honoring an opt-out after removal
// from the roster, and a removed member is exactly the row a re-add would
// otherwise sail past.
// Exported for convex/documents.ts:createMemberFromKiosk, which creates member
// rows from the unauthenticated front-desk tablet and needs the identical rule
// for the identical reason. Sharing the function rather than copying it is the
// point: a second implementation is how one of the two paths quietly stops
// inheriting an opt-out.
export async function numberHasOptOutOnRecord(
  ctx: MutationCtx,
  digits: string,
  excludeId?: Id<"members">
): Promise<boolean> {
  if (!digits) return false;
  const all = await ctx.db.query("members").collect();
  return all.some(
    (m) =>
      m._id !== excludeId &&
      m.smsOptedOut === true &&
      m.phone &&
      normalizePhoneDigits(m.phone) === digits
  );
}

export const add = mutation({
  args: memberFields,
  handler: async (ctx, rawArgs) => {
    const gym = await requireGym(ctx);
    requireWriteAccess(gym);
    const args = { ...rawArgs, ...normalizedDocumentFields(rawArgs) };
    validateMemberFields(args);
    assertSmsConsent(args);
    // A NEW row is not a clean slate for a number that already opted out.
    // Without this, "remove the member, add them again" — or simply typing an
    // opted-out number onto a new member — produced a row with smsOptedOut
    // undefined, which isTextEligibleMember reads as textable. That is the same
    // hole this file just closed in `update`, reached from the other side, and
    // it defeats that fix entirely: an owner who cannot clear an opt-out by
    // editing can still clear it by re-adding. assertSmsConsent above forces
    // the owner to tick consent to save a number at all, so nothing else would
    // have stopped the send.
    const optedOut = await numberHasOptOutOnRecord(ctx, normalizePhoneDigits(args.phone ?? ""));
    return await ctx.db.insert("members", {
      ...args,
      gymId: gym._id,
      // Only ever written as `true`. A number with no opt-out on record leaves
      // the field unset, exactly as before, rather than being stamped false —
      // "we have never heard from this number" and "this number opted back in"
      // are different facts and the schema distinguishes them.
      ...(optedOut ? { smsOptedOut: true } : {}),
      ...(args.smsConsentConfirmed ? { smsConsentSource: "member_modal" as const } : {}),
    });
  },
});

export const update = mutation({
  args: { id: v.id("members"), ...memberFields },
  handler: async (ctx, { id, ...rawFields }) => {
    const gym = await requireGym(ctx);
    requireWriteAccess(gym);
    const fields = { ...rawFields, ...normalizedDocumentFields(rawFields) };
    const existing = await ctx.db.get(id);
    if (!existing || existing.gymId !== gym._id) throw new Error("Member not found");
    // An archived member is not editable. No UI can reach one (every list query
    // filters them out), so this only closes a direct client call — but the
    // phoneChanged branch below sets smsOptedOut: false, which would clear the
    // opt-out record the privacy policy (§10) commits to retaining after a
    // member is removed. Same opaque error as a foreign/missing id: an archived
    // member should be indistinguishable from one that isn't there.
    if (existing.archived) throw new Error("Member not found");
    validateMemberFields(fields);
    assertSmsConsent(fields);
    // A prior opt-out is tied to the phone number that opted out, not the
    // member record — if the number changes, the old opt-out no longer
    // applies to whoever holds the new number, and assertSmsConsent above
    // already forces fresh consent to be re-confirmed for it. Without this,
    // a member who opted out on an old number would stay silently excluded
    // from texts on a new number they never opted out on, with no UI to
    // notice or fix it.
    //
    // COMPARED ON NORMALIZED DIGITS, NOT RAW STRINGS. This was
    // `fields.phone !== existing.phone`, and member phone numbers are
    // free-typed (member-modal.tsx) — so re-saving a member after retyping
    // "(720) 555-0100" as "720-555-0100" registered as a NEW NUMBER and
    // silently cleared a real STOP. That made the dashboard capable of
    // undoing a member's opt-out by reformatting a phone number, which
    // contradicts the tooltip in app/components/text-state-pill.tsx ("Only
    // they can undo it") and the privacy policy's opt-out retention
    // commitment. normalizePhoneDigits is the same function
    // setSmsOptOutByPhone and consent.ts:submitConsent match on (hoisted —
    // declared below), so "the same number" means one thing everywhere.
    const newPhoneDigits = normalizePhoneDigits(fields.phone ?? "");
    const oldPhoneDigits = normalizePhoneDigits(existing.phone ?? "");
    const phoneChanged = newPhoneDigits !== oldPhoneDigits;

    // A genuinely new number is not automatically a clean one — if the number
    // being moved TO already told us to stop, that instruction must survive
    // being typed into a different member. Shares numberHasOptOutOnRecord with
    // `add`, which needs the identical rule for the identical reason; two
    // copies is how the two paths drift and one of them quietly stops
    // inheriting.
    //
    // Self is excluded: this row's smsOptedOut refers to the OLD number, which
    // by definition isn't the one being adopted.
    const inheritedOptOut =
      phoneChanged && newPhoneDigits
        ? await numberHasOptOutOnRecord(ctx, newPhoneDigits, id)
        : false;
    // member-modal.tsx only advances smsConsentConfirmedAt to Date.now() when
    // it computes needsConsent (a genuinely new phone/consent event); it
    // resends the existing timestamp unchanged when just re-saving an
    // already-confirmed phone. A changed timestamp is therefore this dashboard
    // modal establishing fresh consent, not a no-op resend — worth stamping
    // the source for. Doing the comparison here (not accepting source as a
    // client arg) keeps this in sync with the modal without touching it.
    const isFreshModalConsent =
      fields.smsConsentConfirmed &&
      fields.smsConsentConfirmedAt !== existing.smsConsentConfirmedAt;
    await ctx.db.patch(id, {
      ...fields,
      // Guarded on newPhoneDigits as well as phoneChanged: CLEARING a member's
      // phone number is a change, but it hands the opt-out to nobody. Writing
      // smsOptedOut: false there would let "delete the number, save, retype the
      // same number, save" launder a STOP through the UI in two clicks. With
      // the guard, a row whose number is removed keeps its opt-out on file,
      // which is also what the privacy policy's post-removal retention
      // commitment requires.
      ...(phoneChanged && newPhoneDigits ? { smsOptedOut: inheritedOptOut } : {}),
      ...(isFreshModalConsent ? { smsConsentSource: "member_modal" as const } : {}),
    });
  },
});

// Soft delete — the dashboard's "Remove" action, and the ONLY member-removal
// path. There is deliberately no hard-delete mutation: one existed until it was
// removed as dead code, because deleting the row destroys the member's
// smsOptedOut/smsConsentConfirmed fields, which are the TCPA evidence that a
// given number opted in (or out). The privacy policy (§10) commits to retaining
// an opt-out even after the member record is removed from the roster, and a
// destroyed opt-out means a re-added or re-imported number can be texted again.
// Do not reintroduce a delete path here without resolving that first — the old
// one also cascade-deleted the member's attendance and enrollments rows.
// Archiving keeps the row and its consent history intact while removing the
// member from every list, count, and the retention-text audience.
//
// Deliberately patches ONLY the two archival fields. It must never touch
// smsOptedOut, smsConsentConfirmed, smsConsentConfirmedAt, or smsConsentSource
// — those have to survive archival for the reason above. It also leaves
// `status` alone, so a member's active/inactive state is preserved if they're
// ever unarchived (no UI for that yet — see the frontend copy, which promises
// archival, not erasure).
export const archiveMember = mutation({
  args: { memberId: v.id("members") },
  handler: async (ctx, { memberId }) => {
    const gym = await requireGym(ctx);
    requireWriteAccess(gym);
    // Same ownership re-check every other write in this file does, not a
    // filtered list read: a memberId belonging to another gym must throw, never
    // archive. Cross-tenant write if this is missing.
    const existing = await ctx.db.get(memberId);
    if (!existing || existing.gymId !== gym._id) throw new Error("Member not found");
    // Idempotent — re-archiving an already-archived member would otherwise
    // move archivedAt, rewriting when the removal actually happened.
    if (existing.archived) return;
    await ctx.db.patch(memberId, { archived: true, archivedAt: Date.now() });
  },
});

// Run when a member reports a lost/stolen card. Overwriting checkInToken is
// itself the invalidation: by_check_in_token is keyed on the live field, so
// the old token stops resolving to anything the instant this patch commits
// — no separate revocation list needed.
export const regenerateCheckInToken = mutation({
  args: { memberId: v.id("members") },
  handler: async (ctx, { memberId }) => {
    const gym = await requireGym(ctx);
    requireWriteAccess(gym);
    const existing = await ctx.db.get(memberId);
    if (!existing || existing.gymId !== gym._id) throw new Error("Member not found");

    const token = await generateUniqueCheckInToken(ctx);
    await ctx.db.patch(memberId, { checkInToken: token, checkInTokenIssuedAt: Date.now() });
    return token;
  },
});

// No auth — public kiosk search, scoped by the gymId the kiosk page passes
// in. Returns only the fields app/checkin/page.tsx actually renders
// (_id/name/plan/status/beltRank) — previously returned full member docs
// including phone, email, and SMS-consent fields to this unauthenticated
// endpoint, which the kiosk UI never used.
export const getActiveForGym = query({
  args: { gymId: v.id("gyms") },
  handler: async (ctx, { gymId }) => {
    const members = await ctx.db
      .query("members")
      .withIndex("by_gym", (q) => q.eq("gymId", gymId))
      .filter((q) => q.eq(q.field("status"), "active"))
      .filter((q) => q.neq(q.field("archived"), true))
      .collect();
    return members.map((m) => ({
      _id: m._id,
      name: m.name,
      plan: m.plan,
      status: m.status,
      beltRank: m.beltRank,
    }));
  },
});

// No auth — public, called by the kiosk before checkIn to resolve a
// scanned QR/card token to a member. The token itself is the credential
// (40 random hex chars, effectively unguessable), so this is safe to leave
// open the same way getActiveForGym/checkIn are. Returns null on no match
// rather than throwing, since a bad/stale scan is an expected kiosk case,
// not an error. Also returns null if the matched member has no gymId
// (pre-multi-tenancy row that predates backfillFirstGym) — there'd be
// nothing valid to hand back for the kiosk's follow-up checkIn call, and
// this getting hit at all should be rare-to-impossible on real data since
// every current member already has a gymId.
export const resolveCheckInToken = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const member = await ctx.db
      .query("members")
      .withIndex("by_check_in_token", (q) => q.eq("checkInToken", token))
      .unique();
    // Archived members resolve to null, same as a stale/unknown token: an
    // archived member is off the roster, so their card must stop opening the
    // kiosk. Paired with the archived filter on getActiveForGym (the kiosk's
    // other lookup path) and the guard in checkIn below, so no kiosk route
    // logs attendance for someone who's been removed.
    if (!member || !member.gymId || member.archived) return null;
    return { memberId: member._id, gymId: member.gymId, name: member.name };
  },
});

// No auth — intentionally public for the kiosk check-in screen.
// gymId is required so a stale/spoofed member id from another gym can't be checked in
// through this gym's kiosk. Rate-limited per gym (not per caller — there's no
// reliable caller identity on a public kiosk mutation) so a scripted loop
// against one kiosk can't hammer the table; 60/5min is far above any real
// kiosk's walk-in rate.
//
// idempotencyKey/clientScannedAt are only sent by the offline check-in
// queue — live/online taps omit both and behave exactly as before.
// idempotencyKey is checked first and short-circuits everything else,
// including the rate limiter, so a replayed queue item that already
// succeeded doesn't burn rate-limit budget or re-run side effects.
// clientScannedAt, when present, is the authoritative event time for the
// once-per-day check and for lastVisit — using server receive-time instead
// would misattribute a check-in queued late one day to whichever day it
// happens to replay on.
export const checkIn = mutation({
  args: {
    id: v.id("members"),
    gymId: v.id("gyms"),
    idempotencyKey: v.optional(v.string()),
    clientScannedAt: v.optional(v.number()),
    // Which class the kiosk had selected when this tap happened. Optional
    // forever — open mat and off-hours training are real check-ins with no
    // class. Validated against this gym below rather than trusted: the kiosk
    // is unauthenticated, so a hand-crafted call could otherwise attach a
    // walk-in to another gym's class.
    classId: v.optional(v.id("classes")),
    // The tablet's own local date, "YYYY-MM-DD". See the schema comment on
    // checkIns.localDate: this deployment runs in UTC, so an evening check-in
    // bucketed server-side would land on the following day.
    localDate: v.optional(v.string()),
  },
  handler: async (ctx, { id, gymId, idempotencyKey, clientScannedAt, classId, localDate }) => {
    if (idempotencyKey) {
      const existing = await ctx.db
        .query("checkIns")
        .withIndex("by_idempotency_key", (q) => q.eq("idempotencyKey", idempotencyKey))
        .unique();
      if (existing) return;
    }

    const allowed = await consumeRateLimit(ctx, "checkin", gymId);
    if (!allowed) throw new Error("Too many check-ins right now — please try again in a few minutes.");

    const member = await ctx.db.get(id);
    // Archived members are indistinguishable from unknown ones here. Both kiosk
    // lookups (getActiveForGym, resolveCheckInToken) already exclude them, so
    // this only closes a direct call with a remembered member id — but without
    // it such a call would still patch lastVisit/status and insert a checkIns
    // row for someone who's been removed from the roster.
    if (!member || member.gymId !== gymId || member.archived) throw new Error("Member not found");

    const now = Date.now();
    const eventTime = clientScannedAt ?? now;
    const eventIso = new Date(eventTime).toISOString();
    const alreadyVisitedToday =
      !!member.lastVisit && member.lastVisit.slice(0, 10) === eventIso.slice(0, 10);

    if (!alreadyVisitedToday) {
      await ctx.db.patch(id, {
        lastVisit: eventIso,
        status: "active",
        lastRetentionTextAt: undefined,
      });
    }

    // Winback sequence reset, deliberately outside the once-per-day branch
    // above: walking through the door ends the sequence, whether or not this
    // is the member's first scan today. A dormant member who returns is fully
    // rearmed, so a future lapse starts a clean three attempts rather than
    // finding a spent counter and never being texted again. Guarded so an
    // ordinary check-in by a member with nothing to clear writes nothing.
    // Safe to read off the `member` snapshot taken above: the patch in this
    // mutation touches neither winback field.
    //
    // Recovery capture lives inside this same branch, read BEFORE the patch
    // below overwrites the fields it needs. It's gated on the identical
    // condition, which is what makes it fire exactly once per winback
    // sequence: the condition is evaluated against the member's state as
    // freshly read from the DB above, not a flag, so once this patch clears
    // winbackAttempts/winbackDormantAt, any later checkIn call for this
    // member (a same-day double-scan, an offline-queue replay under a
    // different idempotencyKey) reads clean state and this branch can't
    // fire again — no separate dedupe mechanism needed.
    if ((member.winbackAttempts ?? 0) > 0 || member.winbackDormantAt !== undefined) {
      // lastRetentionTextAt is required, not just winbackAttempts > 0 — with
      // no timestamp there's nothing to attribute the return to, and the
      // point of the attribution window below is to under-claim rather than
      // guess. Uses eventTime, not `now`: for an offline-queue replay,
      // eventTime is when the member actually scanned, which is what the
      // attribution window and daysToReturn need to be measured against, not
      // whenever the queue happened to sync.
      if (member.lastRetentionTextAt !== undefined) {
        const daysToReturn = (eventTime - member.lastRetentionTextAt) / MS_PER_DAY;
        if (daysToReturn >= 0 && daysToReturn <= WINBACK_ATTRIBUTION_WINDOW_DAYS) {
          await ctx.db.insert("winbackRecoveries", {
            memberId: id,
            gymId,
            returnedAt: eventTime,
            lastTextedAt: member.lastRetentionTextAt,
            attemptsUsed: member.winbackAttempts ?? 0,
            daysToReturn,
          });
        }
      }
      await ctx.db.patch(id, { winbackAttempts: 0, winbackDormantAt: undefined });
    }

    // Never trust the kiosk's classId. This mutation is reachable
    // unauthenticated (the kiosk has no login), so a hand-crafted call could
    // otherwise pin a walk-in onto a class belonging to a different gym and
    // corrupt that gym's attendance. A class that doesn't resolve, or that
    // belongs to someone else, degrades to a plain no-class check-in rather
    // than throwing — the member is standing at the door and the check-in
    // itself matters far more than the class label on it.
    let resolvedClassId = undefined;
    if (classId) {
      const cls = await ctx.db.get(classId);
      if (cls && cls.gymId === gymId) resolvedClassId = classId;
    }

    await ctx.db.insert("checkIns", {
      memberId: id,
      gymId,
      timestamp: now,
      clientScannedAt,
      idempotencyKey,
      classId: resolvedClassId,
      // Only meaningful alongside a class — it exists so the classes page can
      // match kiosk check-ins to a roll-call date. Stored whenever the kiosk
      // sends it regardless, since it costs nothing and a local date is
      // strictly more information than an absolute timestamp alone.
      localDate,
    });
  },
});

export const getCheckInHistory = query({
  args: { memberId: v.id("members") },
  handler: async (ctx, { memberId }) => {
    const gym = await tryGetReadableGym(ctx);
    if (!gym) return [];
    const member = await ctx.db.get(memberId);
    if (!member || member.gymId !== gym._id) throw new Error("Member not found");
    const rows = await ctx.db
      .query("checkIns")
      .withIndex("by_member", (q) => q.eq("memberId", memberId))
      .collect();
    return rows.sort((a, b) => b.timestamp - a.timestamp);
  },
});

// The dashboard's "who has gone quiet" panel (app/dashboard/at-risk.tsx).
// Deliberately wider than sendRetentionTexts.ts:getAtRiskMembers (the send
// gate) — this one lists people with no number and people who opted out too,
// because a coach still needs to see them; it just can't text them.
//
// Narrowed to an explicit field map for the same reason getAll,
// getActiveForGym and getUnconfirmedImportedMembers are: returning raw member
// documents shipped checkInToken — the kiosk check-in credential — to the
// browser for every at-risk member. The panel never needs it. Everything below
// lastVisit is here only to feed app/components/text-state-pill.tsx.
//
// tryGetGym, not requireGym — at-risk.tsx is "use client" and reads this via
// useQuery, so it fires before Clerk's session has hydrated. requireGym throws
// there, production redacts that to a generic "Server Error", and with no
// error boundary on the route it takes the whole dashboard down (518ad18).
export const getAtRiskMembers = query({
  args: {},
  handler: async (ctx) => {
    const gym = await tryGetGym(ctx);
    if (!gym) return [];
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const threshold = sevenDaysAgo.toISOString();
    const all = await ctx.db
      .query("members")
      .withIndex("by_gym", (q) => q.eq("gymId", gym._id))
      .collect();
    return all
      .filter(
        (m) => !m.archived && m.status === "active" && (!m.lastVisit || m.lastVisit < threshold)
      )
      .map((m) => ({
        _id: m._id,
        name: m.name,
        lastVisit: m.lastVisit,
        // The pill's inputs. archived/status are constant across this list
        // given the filter above, but they're what isTextEligibleMember takes,
        // and passing them explicitly keeps the panel honest if that filter
        // ever loosens.
        phone: m.phone,
        smsConsentConfirmed: m.smsConsentConfirmed,
        smsOptedOut: m.smsOptedOut,
        status: m.status,
        archived: m.archived,
        winbackAttempts: m.winbackAttempts,
      }));
  },
});

const CONSENT_ATTESTATION_VERSION = "v1";

// Bulk consent stamp for imported members, gated behind an explicit
// owner-facing attestation checkbox (attested must be true — no silent
// default). Always inserts one consentAttestations audit row, even when
// nothing gets stamped: an owner running the flow and confirming nobody
// needed it is still a true TCPA-relevant event. memberIds is unbounded —
// this does N reads + N patches in one transaction, fine at the roster
// sizes every current plan tier supports; chunk if bulk imports ever bring
// in thousands at once.
export const attestBulkConsent = mutation({
  args: { memberIds: v.array(v.id("members")), attested: v.boolean() },
  handler: async (ctx, { memberIds, attested }) => {
    const gym = await requireGym(ctx);
    requireWriteAccess(gym);
    if (!attested) throw new Error("Attestation must be explicitly confirmed");

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");

    const now = Date.now();
    const stampedIds: typeof memberIds = [];
    let skippedNoPhone = 0;
    let skippedAlreadyConfirmed = 0;

    for (const memberId of memberIds) {
      const member = await ctx.db.get(memberId);
      if (!member || member.gymId !== gym._id) continue; // scope guard
      if (!member.phone) {
        skippedNoPhone++;
        continue;
      }
      if (member.smsConsentConfirmed) {
        skippedAlreadyConfirmed++;
        continue;
      }
      await ctx.db.patch(memberId, {
        smsConsentConfirmed: true,
        smsConsentConfirmedAt: now,
        smsConsentSource: "owner_attestation",
      });
      stampedIds.push(memberId);
    }

    await ctx.db.insert("consentAttestations", {
      gymId: gym._id,
      attestedByClerkUserId: identity.subject,
      attestedAt: now,
      memberCount: stampedIds.length,
      memberIds: stampedIds,
      attestationVersion: CONSENT_ATTESTATION_VERSION,
    });

    return { confirmed: stampedIds.length, skippedNoPhone, skippedAlreadyConfirmed };
  },
});

// Gym-scoped, narrowed the same way getActiveForGym/getDormantMembers are —
// no checkInToken (kiosk check-in credential), email, or other fields the
// bulk-consent UI doesn't need. importBatchId is included so the UI can
// group by import run: the attestation requirement is per-import, and two
// separate CSV imports merging into one undifferentiated list would satisfy
// it only in spirit, not literally.
export const getUnconfirmedImportedMembers = query({
  args: {},
  handler: async (ctx) => {
    const gym = await tryGetReadableGym(ctx);
    if (!gym) return [];
    const members = await ctx.db
      .query("members")
      .withIndex("by_gym", (q) => q.eq("gymId", gym._id))
      .collect();
    return members
      .filter((m) => !m.archived && !!m.phone && m.smsConsentConfirmed !== true)
      .map((m) => ({ _id: m._id, name: m.name, phone: m.phone, importBatchId: m.importBatchId }));
  },
});

// Members who exhausted the three-attempt winback sequence and are no longer
// being texted (see convex/sendRetentionTexts.ts). Deliberately separate from
// getAtRiskMembers above, which still lists them — this is the "we've stopped
// reaching out, it's a phone call from you now" list. Authenticated and
// double-scoped: requireGym establishes the caller's own gym, and the passed
// gymId must match it, so this can't be pointed at another gym's roster.
export const getDormantMembers = query({
  args: { gymId: v.id("gyms") },
  handler: async (ctx, { gymId }) => {
    const gym = await requireGym(ctx);
    if (gym._id !== gymId) throw new Error("Gym not found");
    const all = await ctx.db
      .query("members")
      .withIndex("by_gym", (q) => q.eq("gymId", gymId))
      .collect();
    return all
      .filter((m) => !m.archived && (m.winbackAttempts ?? 0) >= MAX_WINBACK_ATTEMPTS)
      .sort((a, b) => (b.winbackDormantAt ?? 0) - (a.winbackDormantAt ?? 0))
      .map((m) => ({
        _id: m._id,
        name: m.name,
        phone: m.phone,
        lastVisit: m.lastVisit,
        winbackDormantAt: m.winbackDormantAt,
      }));
  },
});

export function normalizePhoneDigits(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

// Internal — only reachable via ctx.runMutation from
// convex/twilioWebhookAction.ts, after it verifies Twilio's request
// signature (see convex/http.ts's /twilio/inbound route). Not a public
// mutation: nothing outside that trusted call chain can flip a member's
// opt-out flag. Matches on stripped digits, not exact string equality,
// because member phone numbers are stored as free-typed text (e.g.
// "(720) 555-0100") while Twilio's inbound "From" is E.164
// (+17205550100) — an exact match would never fire.
//
// DELIBERATELY does NOT skip archived members, unlike every list/count query in
// this file. An archived member who texts STOP must still have smsOptedOut
// recorded: the privacy policy commits to honoring an opt-out after removal
// from the roster, and if that number is ever re-added or re-imported the
// stored opt-out is the only thing that keeps it from being texted. Adding an
// archived filter here would be a TCPA regression, not a cleanup.
export const setSmsOptOutByPhone = internalMutation({
  args: { phone: v.string(), optedOut: v.boolean() },
  handler: async (ctx, { phone, optedOut }) => {
    const target = normalizePhoneDigits(phone);
    if (!target) return;
    const all = await ctx.db.query("members").collect();
    for (const m of all) {
      if (m.phone && normalizePhoneDigits(m.phone) === target) {
        await ctx.db.patch(m._id, { smsOptedOut: optedOut });
      }
    }
  },
});

// Admin-only bulk import path for scripts/import-members.js, invoked via
// `npx convex run members:adminImportBatch` — internal functions aren't
// reachable from the client SDK, only the CLI/dashboard with an admin key,
// which is what makes this safe to run without a signed-in gym owner.
// Deliberately mirrors the public `add` mutation's validation (same
// validateMemberFields call) but skips requireGym/requireWriteAccess since
// there's no Clerk session here. Never sets smsConsentConfirmed: migrated
// CSV data carries no proof real consent was obtained, so an imported phone
// number sits unconfirmed until a gym owner edits + re-saves that member
// through the normal UI. sendRetentionTexts.ts:getAtRiskMembers requires
// smsConsentConfirmed before texting anyone, so this can't silently bypass
// the consent gate the way a raw ctx.db.insert normally would.
export const adminImportBatch = internalMutation({
  args: {
    gymId: v.id("gyms"),
    rows: v.array(
      v.object({
        name: v.string(),
        plan: v.optional(v.string()),
        status: v.optional(v.union(v.literal("active"), v.literal("inactive"))),
        email: v.optional(v.string()),
        phone: v.optional(v.string()),
        beltRank: v.optional(v.string()),
        joinDate: v.optional(v.string()),
        beltPromotionDate: v.optional(v.string()),
        discipline: v.optional(disciplineValidator),
        stripes: v.optional(v.number()),
      })
    ),
  },
  handler: async (ctx, { gymId, rows }) => {
    const gym = await ctx.db.get(gymId);
    if (!gym) throw new Error(`No gym found with id ${gymId}`);

    // One id per call, not per row — every member inserted by this
    // invocation belongs to the same CSV run, which is what makes the id
    // useful as a grouping key (see consentAttestations/attestBulkConsent).
    const importBatchId = crypto.randomUUID();

    // Baseline lastVisit for the whole batch, server-set and deliberately NOT
    // a caller-supplied arg — no CSV source exports a last-visit column, so
    // there is nothing truthful to import and this is the honest floor: "we
    // have no record of a visit before the import."
    //
    // Without it every imported member trips the `!m.lastVisit` clause in both
    // at-risk tests (members.ts:getAtRiskMembers, sendRetentionTexts.ts:
    // getAtRiskMembers) and the entire roster is at-risk on day one. With it,
    // the batch starts clean and a genuinely lapsed member surfaces at day 7
    // when no real check-in has landed since — the same 7-day gate everyone
    // else is measured by.
    //
    // ISO string, matching every other writer (attendance.ts:69, checkIn's
    // eventIso) and every threshold comparison, all of which use
    // .toISOString() so the lexicographic `<` stays chronological.
    // One timestamp for the batch, not per row, so a slow import doesn't
    // scatter members across different baselines.
    const importedAt = new Date().toISOString();

    // Dedupe against members already in this gym, matched on email — the
    // same signal the script uses to skip a row it already imported on a
    // prior run. Loaded once up front and kept in sync as we insert so two
    // rows in the same CSV that share an email don't both get inserted.
    const existing = await ctx.db
      .query("members")
      .withIndex("by_gym", (q) => q.eq("gymId", gymId))
      .collect();
    const existingEmails = new Set(
      existing.filter((m) => m.email).map((m) => m.email!.toLowerCase())
    );

    const results: Array<{
      status: "inserted" | "duplicate" | "error";
      name: string;
      email?: string;
      message?: string;
      rankWarning?: string;
    }> = [];

    for (const row of rows) {
      const plan = row.plan?.trim() || "Imported";
      const email = row.email?.trim() || undefined;
      try {
        if (email && existingEmails.has(email.toLowerCase())) {
          results.push({ status: "duplicate", name: row.name, email });
          continue;
        }
        validateMemberFields({ name: row.name, plan, email, phone: row.phone, beltRank: row.beltRank });
        const memberId = await ctx.db.insert("members", {
          name: row.name,
          plan,
          status: row.status ?? "active",
          email,
          phone: row.phone,
          beltRank: row.beltRank,
          joinDate: row.joinDate,
          beltPromotionDate: row.beltPromotionDate,
          lastVisit: importedAt,
          gymId,
          importBatchId,
        });
        if (email) existingEmails.add(email.toLowerCase());

        // Rank data is optional and validated separately from the rest of the
        // row: a bad discipline/belt/stripe combo flags a warning on an
        // otherwise-successful member import rather than failing the whole
        // row, matching normalizeBelt()'s flag-don't-crash posture in
        // scripts/import-members.js.
        let rankWarning: string | undefined;
        if (row.discipline && row.beltRank) {
          const check = validateRank(row.discipline, row.beltRank, row.stripes);
          if (check.valid) {
            await ctx.db.insert("ranks", {
              memberId,
              gymId,
              discipline: row.discipline,
              currentBelt: check.canonicalBelt,
              currentStripes: row.stripes,
              promotionDate: row.beltPromotionDate,
            });
          } else {
            rankWarning = check.reason;
          }
        }

        results.push({ status: "inserted", name: row.name, email, rankWarning });
      } catch (e) {
        results.push({
          status: "error",
          name: row.name,
          email,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return results;
  },
});

// Global admin sweep across all gyms — safe unscoped: it only patches each
// member's own status based on their own lastVisit, never returns or compares
// data across gyms.
export const markInactiveMembers = internalMutation({
  args: {},
  handler: async (ctx) => {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const threshold = thirtyDaysAgo.toISOString();
    const members = await ctx.db.query("members").collect();
    for (const member of members) {
      // An UNSET lastVisit is left alone — absence of evidence, not evidence of
      // absence. This used to read `!member.lastVisit || member.lastVisit <
      // threshold`, where the first clause short-circuited before the 30-day
      // comparison was ever evaluated. No CSV source exports a last-visit
      // column (see adminImportBatch), so every imported member has none, and
      // that clause flipped an entire freshly-imported roster to "inactive"
      // within 24 hours of setup — emptying getActiveForGym and with it the
      // check-in kiosk, so nobody could check in the next morning. Only a
      // member with a RECORDED visit older than the threshold flips now.
      // Archived members are skipped — flipping status on a row that no list
      // or count reads is pointless write churn, and it would misdate the row
      // as though something happened to it after it was removed.
      if (!member.archived && member.status === "active" && member.lastVisit !== undefined && member.lastVisit < threshold) {
        await ctx.db.patch(member._id, { status: "inactive" });
      }
    }
  },
});
