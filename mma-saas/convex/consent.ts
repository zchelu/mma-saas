import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { consumeRateLimit } from "./rateLimit";
import { tryGetGym, requireGym, requireWriteAccess } from "./gyms";
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

// Owner-facing counts for the dashboard.
//
// THIS USED TO RETURN ONLY `totalSubmissions`, AND THAT WAS THE PRODUCT'S MOST
// DANGEROUS NUMBER. A submission that doesn't match a roster phone number sets
// nothing on any member — that person can never be texted — but it still
// inserts a consentSubmissions row, and submitConsent deliberately returns the
// same "ok" to matched and unmatched alike (anti-enumeration: a stranger must
// not be able to probe the roster). So the member saw success, this counter
// climbed, and nobody could tell which opt-ins were real.
//
// Worse, the default onboarding order maximises it: an owner shares the consent
// link with their members BEFORE finishing the roster import, so the earliest
// submissions are exactly the ones that silently do nothing. It surfaces in
// week two, when the first winback run reaches only some of them.
//
// Splitting matched from unmatched HERE is safe and does not weaken the
// anti-enumeration property: this query is owner-authenticated and scoped to
// their own gym. Only submitConsent's public response must stay generic.
//
// tryGetGym, not requireGym: this renders in StatsGrid ("use client") via
// useQuery, so it fires during the window before Clerk's client-side session
// has hydrated. requireGym throws a plain Error there, which production
// redacts to a generic "Server Error" and — with no error boundary on the
// route — took the whole dashboard down. Its three sibling stat cards already
// use tryGetGym for exactly this reason; see 518ad18. Return shape matches the
// success path so StatCard renders 0 rather than an indefinite loading "…".
export const getConsentStats = query({
  args: {},
  handler: async (ctx) => {
    const gym = await tryGetGym(ctx);
    if (!gym) return { totalSubmissions: 0, matchedSubmissions: 0, unmatchedSubmissions: 0 };
    const submissions = await ctx.db
      .query("consentSubmissions")
      .withIndex("by_gym", (q) => q.eq("gymId", gym._id))
      .collect();
    const matched = submissions.filter((s) => s.memberId).length;
    return {
      totalSubmissions: submissions.length,
      matchedSubmissions: matched,
      unmatchedSubmissions: submissions.length - matched,
    };
  },
});

// The unmatched submissions, re-checked against the roster AS IT IS NOW.
//
// `memberId` on a consentSubmissions row is a snapshot taken at submit time and
// is never revisited. So an owner who adds a member AFTER that person submitted
// consent ends up with someone who consented, is on the roster, and still can't
// be texted — because nothing ever re-ran the match. That is a silent failure
// with no surface anywhere in the app, and it is the common case during
// onboarding.
//
// This splits the gap into the two buckets an owner can actually act on:
//   nowOnRoster: true  — they've since been added; their consent just needs
//                        applying (see applyPendingConsent below)
//   nowOnRoster: false — genuinely not on the roster; the owner must add them
//
// Deduped by normalized phone, most recent first, so one person who submitted
// across two CONSENT_VERSIONs appears once.
export const listPendingConsent = query({
  args: {},
  handler: async (ctx) => {
    const gym = await tryGetGym(ctx);
    if (!gym) return [];

    const submissions = await ctx.db
      .query("consentSubmissions")
      .withIndex("by_gym", (q) => q.eq("gymId", gym._id))
      .collect();
    const unmatched = submissions.filter((s) => !s.memberId);
    if (unmatched.length === 0) return [];

    const members = await ctx.db
      .query("members")
      .withIndex("by_gym", (q) => q.eq("gymId", gym._id))
      .collect();
    const rosterPhones = new Set(
      members.filter((m) => m.phone).map((m) => normalizePhoneDigits(m.phone!))
    );

    const newestByPhone = new Map<string, (typeof unmatched)[number]>();
    for (const s of unmatched) {
      const seen = newestByPhone.get(s.normalizedPhone);
      if (!seen || s.consentedAt > seen.consentedAt) newestByPhone.set(s.normalizedPhone, s);
    }

    return [...newestByPhone.values()]
      .sort((a, b) => b.consentedAt - a.consentedAt)
      .map((s) => ({
        submittedName: s.submittedName,
        submittedPhone: s.submittedPhone,
        consentedAt: s.consentedAt,
        nowOnRoster: rosterPhones.has(s.normalizedPhone),
      }));
  },
});

// Applies consent that was already given but never landed, because the member
// wasn't on the roster at the time. Owner-triggered from the dashboard.
//
// This does not fabricate consent. The person submitted the form for THIS gym,
// at a recorded time, and the exact text they agreed to is stored on the
// submission row. All this does is finish the join that submitConsent couldn't
// complete because the roster row didn't exist yet.
//
// Mirrors submitConsent's rules deliberately:
//   - never touches smsOptedOut. A prior Twilio STOP is a more recent and more
//     specific signal than an older web form and must not be undone by it. Only
//     an inbound START/YES can clear it.
//   - does not gate on CONSENT_VERSION. The member consented to whatever text
//     was shown at the time, which is what's stored; submitConsent's own patch
//     doesn't re-check version either, and diverging here would mean the same
//     submission is honoured on one path and dropped on the other.
//
// Returns how many members were updated so the UI can report it honestly.
export const applyPendingConsent = mutation({
  args: {},
  handler: async (ctx) => {
    const gym = await requireGym(ctx);
    requireWriteAccess(gym);

    const submissions = await ctx.db
      .query("consentSubmissions")
      .withIndex("by_gym", (q) => q.eq("gymId", gym._id))
      .collect();
    const unmatched = submissions.filter((s) => !s.memberId);
    if (unmatched.length === 0) return { applied: 0 };

    const members = await ctx.db
      .query("members")
      .withIndex("by_gym", (q) => q.eq("gymId", gym._id))
      .collect();
    const memberByPhone = new Map(
      members.filter((m) => m.phone).map((m) => [normalizePhoneDigits(m.phone!), m])
    );

    const now = Date.now();
    const handled = new Set<string>();
    let applied = 0;

    for (const submission of unmatched) {
      const member = memberByPhone.get(submission.normalizedPhone);
      if (!member) continue;

      // Backfill the submission's memberId too, so the audit trail records
      // which roster row this consent ultimately attached to and this row
      // stops being reported as a gap.
      await ctx.db.patch(submission._id, { memberId: member._id });

      // One member can have several unmatched submissions (re-submits across
      // CONSENT_VERSIONs). Every one of them gets its memberId backfilled
      // above, but the member is only considered once.
      if (handled.has(member._id)) continue;
      handled.add(member._id);

      // Counts only members this actually changed, so the UI can't report
      // "applied 4" when three of them were already confirmed.
      if (member.smsConsentConfirmed) continue;
      await ctx.db.patch(member._id, {
        smsConsentConfirmed: true,
        smsConsentConfirmedAt: now,
        // From the submission, not hardcoded. This used to stamp
        // "member_self_serve" unconditionally, which mislabelled every
        // keyword-origin consent the moment a second source existed — on the
        // exact field that exists so a carrier or lawyer question about how a
        // specific member consented is answerable from the member row alone,
        // without cross-referencing consentSubmissions.
        smsConsentSource: submission.source,
      });
      applied++;
    }

    return { applied };
  },
});
