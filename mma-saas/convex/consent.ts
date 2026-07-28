import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { consumeRateLimit } from "./rateLimit";
import { tryGetGym } from "./gyms";
import { normalizePhoneDigits } from "./members";
import { assertMaxLength } from "./validate";
import { getConsentText, CONSENT_VERSION } from "../lib/consentText";

// Public, unauthenticated mutation behind /consent/[gymSlug] — a gym member
// opting themselves into SMS, not a gym owner attesting on their behalf (that
// path is members.ts:attestBulkConsent). gymSlug resolves the gym server-side
// via by_slug; the client never supplies a gymId directly, so this can't be
// pointed at an arbitrary gym's roster by guessing/tampering with an id.
//
// No SMS verification loop yet (documented, deliberate gap — see the
// handoff): nothing here proves the submitter owns the phone number they
// typed, only that *someone* submitted this exact name+phone for this gym.
// consentSubmissions is the audit trail for that; smsConsentConfirmed on a
// matched member is the operational effect (unblocks winback texts).
export const submitConsent = mutation({
  args: {
    gymSlug: v.string(),
    name: v.string(),
    phone: v.string(),
    ip: v.optional(v.string()),
    userAgent: v.optional(v.string()),
  },
  handler: async (ctx, { gymSlug, name, phone, ip, userAgent }) => {
    assertMaxLength(name, 200, "Name");
    assertMaxLength(phone, 30, "Phone");
    if (!name.trim() || !phone.trim()) {
      throw new Error("Name and phone are required");
    }

    const gym = await ctx.db
      .query("gyms")
      .withIndex("by_slug", (q) => q.eq("slug", gymSlug))
      .unique();
    if (!gym?.name) throw new Error("Gym not found");

    const normalizedPhone = normalizePhoneDigits(phone);
    const ipKey = ip || "unknown";

    // Two separate buckets, checked independently, so a legitimate class
    // sharing one front-desk IP isn't punished for a script hammering a
    // single phone number, or vice versa — see rateLimit.ts's BUCKETS
    // comment for the sizing rationale. Either tripping returns the same
    // distinguishable "rate_limited" status (never the generic "ok" used for
    // a real submission), so the page can show an honest "try again shortly"
    // instead of implying a match/no-match result.
    const phoneOk = await consumeRateLimit(ctx, "consentPhone", `${ipKey}:${normalizedPhone}`);
    if (!phoneOk) return { status: "rate_limited" as const };
    const ipOk = await consumeRateLimit(ctx, "consentIp", ipKey);
    if (!ipOk) return { status: "rate_limited" as const };

    // Idempotent per gym+phone+consentVersion — a member re-submitting the
    // same form (double-tap, page refresh) isn't a second TCPA event.
    const existingSubmissions = await ctx.db
      .query("consentSubmissions")
      .withIndex("by_gym_phone", (q) => q.eq("gymId", gym._id).eq("normalizedPhone", normalizedPhone))
      .collect();
    const alreadySubmitted = existingSubmissions.some((s) => s.consentVersion === CONSENT_VERSION);
    if (alreadySubmitted) return { status: "ok" as const };

    const now = Date.now();

    // Full-roster-per-gym linear scan — a known, flagged (not fixed) scaling
    // limit, fine at current gym sizes. Would need a stored normalized-phone
    // index on members to avoid at real scale.
    const members = await ctx.db
      .query("members")
      .withIndex("by_gym", (q) => q.eq("gymId", gym._id))
      .collect();
    const matched = members.find((m) => m.phone && normalizePhoneDigits(m.phone) === normalizedPhone);

    if (matched) {
      // Deliberately never touches smsOptedOut — a prior Twilio STOP is a
      // separate, more recent signal than this form and must not be
      // silently undone by it. Only an inbound START/YES reply can clear it.
      await ctx.db.patch(matched._id, {
        smsConsentConfirmed: true,
        smsConsentConfirmedAt: now,
        smsConsentSource: "member_self_serve",
      });
    }

    await ctx.db.insert("consentSubmissions", {
      gymId: gym._id,
      memberId: matched?._id,
      submittedName: name.trim(),
      submittedPhone: phone.trim(),
      normalizedPhone,
      consentedAt: now,
      consentText: getConsentText(gym.name),
      consentVersion: CONSENT_VERSION,
      source: "member_self_serve",
      ip,
      userAgent,
    });

    // Same generic response whether or not a member matched — a bad actor
    // probing phone numbers against this endpoint can't learn who's on the
    // roster from the response shape.
    return { status: "ok" as const };
  },
});

// Owner-facing count for the dashboard — how many people have self-served
// their own SMS consent via /consent/[gymSlug], regardless of whether it
// matched an existing member (an owner running the "we migrate your whole
// roster" offer wants to see this number climb even before every submission
// resolves to a roster match).
// tryGetGym, not requireGym: this renders in StatsGrid ("use client") via
// useQuery, so it fires during the window before Clerk's client-side session
// has hydrated. requireGym throws a plain Error there, which production
// redacts to a generic "Server Error" and — with no error boundary on the
// route — took the whole dashboard down. Its three sibling stat cards
// (members.getActiveCount, classes.getCount, invoices.getUnpaidCount) already
// use tryGetGym for exactly this reason; see 518ad18, which fixed this same
// crash once before. Return shape matches the success path so StatCard
// renders 0 rather than an indefinite loading "…".
export const getConsentStats = query({
  args: {},
  handler: async (ctx) => {
    const gym = await tryGetGym(ctx);
    if (!gym) return { totalSubmissions: 0 };
    const submissions = await ctx.db
      .query("consentSubmissions")
      .withIndex("by_gym", (q) => q.eq("gymId", gym._id))
      .collect();
    return { totalSubmissions: submissions.length };
  },
});
