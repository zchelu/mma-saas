import { query, mutation, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { requireGym, requireWriteAccess, tryGetGym } from "./gyms";
import { assertMaxLength, assertEmailFormat } from "./validate";
import { consumeRateLimit } from "./rateLimit";
import { validateRank, disciplineValidator } from "./beltTaxonomy";

export const getAll = query({
  args: {},
  handler: async (ctx) => {
    const gym = await requireGym(ctx);
    return await ctx.db
      .query("members")
      .withIndex("by_gym", (q) => q.eq("gymId", gym._id))
      .order("desc")
      .collect();
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
      .collect();
    return active.length;
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
};

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
}) {
  assertMaxLength(fields.name, 200, "Name");
  assertMaxLength(fields.plan, 100, "Plan");
  assertMaxLength(fields.email, 254, "Email");
  assertEmailFormat(fields.email, "Email");
  assertMaxLength(fields.phone, 30, "Phone");
  assertMaxLength(fields.beltRank, 100, "Belt rank");
}

export const add = mutation({
  args: memberFields,
  handler: async (ctx, args) => {
    const gym = await requireGym(ctx);
    requireWriteAccess(gym);
    validateMemberFields(args);
    assertSmsConsent(args);
    return await ctx.db.insert("members", { ...args, gymId: gym._id });
  },
});

export const update = mutation({
  args: { id: v.id("members"), ...memberFields },
  handler: async (ctx, { id, ...fields }) => {
    const gym = await requireGym(ctx);
    requireWriteAccess(gym);
    const existing = await ctx.db.get(id);
    if (!existing || existing.gymId !== gym._id) throw new Error("Member not found");
    validateMemberFields(fields);
    assertSmsConsent(fields);
    // A prior opt-out is tied to the phone number that opted out, not the
    // member record — if the number changes, the old opt-out no longer
    // applies to whoever holds the new number, and assertSmsConsent above
    // already forces fresh consent to be re-confirmed for it. Without this,
    // a member who opted out on an old number would stay silently excluded
    // from texts on a new number they never opted out on, with no UI to
    // notice or fix it.
    const phoneChanged = fields.phone !== existing.phone;
    await ctx.db.patch(id, { ...fields, ...(phoneChanged ? { smsOptedOut: false } : {}) });
  },
});

export const remove = mutation({
  args: { id: v.id("members") },
  handler: async (ctx, { id }) => {
    const gym = await requireGym(ctx);
    requireWriteAccess(gym);
    const existing = await ctx.db.get(id);
    if (!existing || existing.gymId !== gym._id) throw new Error("Member not found");
    const enrollments = await ctx.db.query("enrollments").withIndex("by_member", (q) => q.eq("memberId", id)).collect();
    for (const e of enrollments) await ctx.db.delete(e._id);
    const attendance = await ctx.db.query("attendance").withIndex("by_member", (q) => q.eq("memberId", id)).collect();
    for (const a of attendance) await ctx.db.delete(a._id);
    await ctx.db.delete(id);
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
  },
  handler: async (ctx, { id, gymId, idempotencyKey, clientScannedAt }) => {
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
    if (!member || member.gymId !== gymId) throw new Error("Member not found");

    const now = Date.now();
    const eventIso = new Date(clientScannedAt ?? now).toISOString();
    const alreadyVisitedToday =
      !!member.lastVisit && member.lastVisit.slice(0, 10) === eventIso.slice(0, 10);

    if (!alreadyVisitedToday) {
      await ctx.db.patch(id, {
        lastVisit: eventIso,
        status: "active",
        lastRetentionTextAt: undefined,
      });
    }

    await ctx.db.insert("checkIns", { memberId: id, gymId, timestamp: now, clientScannedAt, idempotencyKey });
  },
});

export const getCheckInHistory = query({
  args: { memberId: v.id("members") },
  handler: async (ctx, { memberId }) => {
    const gym = await requireGym(ctx);
    const member = await ctx.db.get(memberId);
    if (!member || member.gymId !== gym._id) throw new Error("Member not found");
    const rows = await ctx.db
      .query("checkIns")
      .withIndex("by_member", (q) => q.eq("memberId", memberId))
      .collect();
    return rows.sort((a, b) => b.timestamp - a.timestamp);
  },
});

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
    return all.filter(
      (m) => m.status === "active" && (!m.lastVisit || m.lastVisit < threshold)
    );
  },
});

function normalizePhoneDigits(phone: string): string {
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
          gymId,
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
      if (member.status === "active" && (!member.lastVisit || member.lastVisit < threshold)) {
        await ctx.db.patch(member._id, { status: "inactive" });
      }
    }
  },
});
