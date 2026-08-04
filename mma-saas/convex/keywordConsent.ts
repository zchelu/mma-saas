import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { Doc } from "./_generated/dataModel";
import { MutationCtx } from "./_generated/server";
import { isValidSmsCode } from "./gyms";
import { normalizePhoneDigits } from "./members";
import {
  getKeywordSignageText,
  getKeywordConfirmationText,
  KEYWORD_CONSENT_VERSION_SIGNAGE_ONLY,
  KEYWORD_CONSENT_VERSION_WITH_CONFIRMATION,
} from "../lib/consentText";

// Text-to-join: a member texts the opt-in keyword from their own handset and
// is recorded as having consented.
//
// WHY THIS PATH IS THE STRONGEST EVIDENCE IN THE PRODUCT. convex/consent.ts
// states the weakness of the web form out loud — "nothing here proves the
// submitter owns the phone number they typed, only that someone submitted this
// exact name+phone for this gym." An inbound text proves ownership
// definitionally: Twilio's From is E.164 and carrier-attested, and the
// MessageSid is the carrier's own record that this handset sent this message,
// independently checkable in Twilio's logs years later without trusting
// anything in this database.
//
// Every rule in convex/consent.ts:submitConsent is mirrored here deliberately.
// Where this file diverges, the divergence is commented. The shared rules live
// in docs/sms-campaign-constraints.md under "Consent evidence rules".

// The name written to consentSubmissions.submittedName when someone texts in.
//
// A keyword opt-in carries no name — Twilio sends a phone number, not a person.
// Parenthesised so it reads as not-a-name beside real entries like "Avery
// Simmons" in the owner's consent-gap panel.
//
// DELIBERATELY NOT FILLED FROM THE ROSTER ON A MATCH, even though the matched
// member's name is right there. submittedName means "what the person
// submitted"; the roster is what we already believed. Copying one into the
// other destroys the distinction on the single table whose purpose is
// recording what actually happened. The memberId link carries identity.
//
// Contains no keyword: the keyword can change, and these rows are forever.
const KEYWORD_SUBMITTED_NAME = "(opted in by text)";

// Gyms permitted to receive the confirmation reply, by slug.
//
// SECOND GATE, NOT A CONVENIENCE. The env flag below says "the feature is
// switched on"; this says "and only for a gym we are allowed to send an
// undeclared message type to." The approved A2P campaign does not declare a
// confirmation auto-reply, so sending one to a real gym's members before the
// batched CTA rewrite lands is a discrepancy a carrier reviewer can catch.
//
// ADDING A SLUG HERE IS A CARRIER-FACING CHANGE, NOT A CODE CHANGE. See
// docs/sms-campaign-constraints.md — pre-review with Manish on ticket
// #28460668 first, then one batched rewrite; the CTA field has nine characters
// of headroom so it is a full recompression, not an append.
const CONFIRMATION_REPLY_ALLOWED_SLUGS = new Set(["demo"]);

export type KeywordConsentResult =
  // Consent recorded (or already on file — the two are deliberately
  // indistinguishable to the caller, see the idempotency note below).
  | {
      status: "recorded";
      gymName: string;
      // True when the matched member is suppressed at the carrier by a prior
      // STOP. The reply is skipped in that case because Twilio blocks every
      // outbound message to a suppressed number with 21610, so "sending" it
      // only mints a guaranteed error-log entry the member never sees.
      suppressed: boolean;
      confirmationText: string | null;
    }
  // Could not tell which gym this text is for. Nothing was written.
  | { status: "unresolved" };

type ResolvedGym = {
  gym: Doc<"gyms">;
  gymResolvedBy: "sms_code" | "slug" | "roster_match";
};

// Splits "KEYWORD TOKEN" into its parts. The body arrives already trimmed and
// uppercased by convex/twilioWebhookAction.ts, matching how every other
// keyword branch there sees it.
function parseKeywordBody(body: string): { token: string | null } {
  const parts = body.split(/\s+/).filter(Boolean);
  // parts[0] is the keyword itself; the caller has already matched it.
  return { token: parts.length > 1 ? parts[1] : null };
}

// Resolve which gym an inbound text belongs to.
//
// THIS IS THE CENTRAL PROBLEM AND IT HAS NO ANALOGUE ELSEWHERE IN THE CODE.
// /consent/[gymSlug] reads the gym from the URL. An inbound text has only a
// phone number, arriving at ONE shared Twilio number serving every gym.
// members.setSmsOptOutByPhone sidesteps this by patching every member with
// that phone across all gyms — correct for STOP, because an opt-out should
// apply everywhere. THIS MUST NEVER DO THAT. Granting consent to every gym a
// number appears in fabricates consent for gyms the person never contacted,
// which is the worst failure this system can produce.
//
// Order is strongest-evidence-first:
//   1. smsCode  — validated BEFORE the index lookup, so a mistyped code can
//                 never resolve. This is the whole reason the code carries a
//                 Luhn check character (convex/gyms.ts).
//   2. slug     — lowercased first; slugs are lowercase and the body is
//                 uppercase. Free to embed in a QR or sms: link, where nobody
//                 types it.
//   3. roster   — inferred, not told. Only when the phone matches exactly ONE
//                 member across ALL gyms. Zero or two-plus matches resolves
//                 nothing.
//
// A TOKEN THAT IS PRESENT BUT RESOLVES TO NOTHING DOES NOT FALL THROUGH TO THE
// ROSTER MATCH. If someone was given a specific gym identifier and it doesn't
// resolve, that is a signal something is wrong, not an invitation to guess.
// Falling through would attach a visiting member to their home gym instead of
// the gym whose poster they actually read — silently, and with gymResolvedBy
// recording "roster_match" as though nothing had been typed.
async function resolveGym(
  ctx: MutationCtx,
  token: string | null,
  fromPhone: string
): Promise<ResolvedGym | null> {
  if (token) {
    if (isValidSmsCode(token)) {
      // .first(), never .unique(). A duplicate would throw, and a throw in
      // this call chain becomes a 500 that Twilio retries forever — turning a
      // data problem into an infinite redelivery loop. Codes are unique by
      // construction (generateUniqueSmsCode checks by_sms_code); failing soft
      // here is about the blast radius when that assumption breaks, not about
      // expecting it to.
      const byCode = await ctx.db
        .query("gyms")
        .withIndex("by_sms_code", (q) => q.eq("smsCode", token))
        .first();
      if (byCode) return { gym: byCode, gymResolvedBy: "sms_code" };
    }

    const bySlug = await ctx.db
      .query("gyms")
      .withIndex("by_slug", (q) => q.eq("slug", token.toLowerCase()))
      .first();
    if (bySlug) return { gym: bySlug, gymResolvedBy: "slug" };

    return null;
  }

  // Bare keyword. Full scan across every gym's roster — the same shape as
  // members.setSmsOptOutByPhone, and the same known scaling limit flagged in
  // convex/consent.ts:submitConsent. Fine at current roster sizes.
  const target = normalizePhoneDigits(fromPhone);
  if (!target) return null;

  const all = await ctx.db.query("members").collect();
  const matches = all.filter((m) => m.phone && normalizePhoneDigits(m.phone) === target);

  // Distinct GYMS, not distinct member rows: one person legitimately having
  // two rows at the same gym is still an unambiguous resolution, while one
  // row at each of two gyms is not.
  const gymIds = new Set(matches.map((m) => m.gymId).filter(Boolean));
  if (gymIds.size !== 1) return null;

  const gymId = [...gymIds][0]!;
  const gym = await ctx.db.get(gymId);
  return gym ? { gym, gymResolvedBy: "roster_match" } : null;
}

// Internal — only reachable via ctx.runMutation from
// convex/twilioWebhookAction.ts, after it has verified Twilio's request
// signature, consumed the rate limit, and claimed the MessageSid. Same trust
// boundary and same reasoning as members.setSmsOptOutByPhone.
//
// NO SEPARATE RATE LIMIT HERE. The twilioInbound bucket the action already
// consumes is keyed on params.From, which IS the per-phone bucket (30 per 15
// minutes, convex/rateLimit.ts). Adding a second one keyed on the same value
// would halve the real ceiling for no gain.
export const recordKeywordConsent = internalMutation({
  args: {
    // Twilio's From, carrier-attested E.164.
    fromPhone: v.string(),
    // The full trimmed/uppercased message body. Parsed here rather than in the
    // action so the parsing is testable without the Node runtime.
    body: v.string(),
    messageSid: v.optional(v.string()),
    // Whether the confirmation-reply feature is switched on at all. Read from
    // the environment by the action ("use node"); the per-gym allowlist is
    // applied below, where the gym is actually known.
    confirmationEnabled: v.boolean(),
  },
  handler: async (ctx, args): Promise<KeywordConsentResult> => {
    const { token } = parseKeywordBody(args.body);
    const resolved = await resolveGym(ctx, token, args.fromPhone);
    if (!resolved) return { status: "unresolved" };

    const { gym, gymResolvedBy } = resolved;
    const normalizedPhone = normalizePhoneDigits(args.fromPhone);
    if (!normalizedPhone) return { status: "unresolved" };

    // Match the member. NEVER creates one, and deliberately applies NO
    // ARCHIVED FILTER — convex/consent.ts:submitConsent has none either, and
    // consistency on this table beats cleverness. An archived member who texts
    // in has still consented, and their row is the thing that carries it.
    const members = await ctx.db
      .query("members")
      .withIndex("by_gym", (q) => q.eq("gymId", gym._id))
      .collect();
    const matched = members.find(
      (m) => m.phone && normalizePhoneDigits(m.phone) === normalizedPhone
    );

    // Carrier suppression from a prior STOP. members.setSmsOptOutByPhone
    // patches every member row sharing that phone across ALL gyms, so a STOP
    // sent about a different gym already shows up on this gym's row — which is
    // correct, because Twilio's suppression is per-number and global too.
    const suppressed = matched?.smsOptedOut === true;

    // Decided here, before anything is written, because it determines WHICH
    // TEXT THE EVIDENCE ROW SNAPSHOTS. A confirmation that will not be sent
    // must not be recorded as seen.
    const willConfirm =
      args.confirmationEnabled &&
      !!gym.slug &&
      CONFIRMATION_REPLY_ALLOWED_SLUGS.has(gym.slug) &&
      !suppressed;

    const gymName = gym.name ?? "your gym";
    const signageText = getKeywordSignageText(gymName);
    const confirmationText = willConfirm ? getKeywordConfirmationText(gymName) : null;
    const consentVersion = willConfirm
      ? KEYWORD_CONSENT_VERSION_WITH_CONFIRMATION
      : KEYWORD_CONSENT_VERSION_SIGNAGE_ONLY;
    const consentText = confirmationText
      ? `${signageText}\n\n${confirmationText}`
      : signageText;

    // Idempotent per gym + phone + version, exactly like submitConsent. A
    // double-text is not a second TCPA event. A text under DIFFERENT wording
    // is, which is why the version is part of the key rather than just the
    // gym and phone.
    //
    // Returns the same shape as a fresh write on purpose: the caller must not
    // be able to tell a first text from a duplicate, for the same reason
    // twilioWebhookAction.ts keeps its replay response byte-identical.
    const existing = await ctx.db
      .query("consentSubmissions")
      .withIndex("by_gym_phone", (q) =>
        q.eq("gymId", gym._id).eq("normalizedPhone", normalizedPhone)
      )
      .collect();
    if (existing.some((s) => s.consentVersion === consentVersion)) {
      return { status: "recorded", gymName, suppressed, confirmationText };
    }

    const now = Date.now();

    if (matched) {
      // NEVER TOUCHES smsOptedOut. A prior STOP is a more recent and more
      // specific signal than this text, and only a registered START keyword
      // may clear it — stated in three places and restated in
      // docs/sms-campaign-constraints.md. The two gates pass independently:
      // someone can be consented AND suppressed, which is exactly the state
      // the owner dashboard needs to surface.
      //
      // Also never un-archives.
      await ctx.db.patch(matched._id, {
        smsConsentConfirmed: true,
        smsConsentConfirmedAt: now,
        smsConsentSource: "keyword",
      });
    }

    // Written whether or not a member matched. An unmatched row is not waste:
    // consent.ts:listPendingConsent and applyPendingConsent filter on memberId
    // and not on source, so the owner's existing consent-gap panel picks this
    // up for free once the person is added to the roster.
    await ctx.db.insert("consentSubmissions", {
      gymId: gym._id,
      memberId: matched?._id,
      submittedName: KEYWORD_SUBMITTED_NAME,
      // VERBATIM Twilio From, not normalized and not reformatted. The raw
      // carrier E.164 is the evidence; normalizedPhone is the lookup key.
      submittedPhone: args.fromPhone,
      normalizedPhone,
      consentedAt: now,
      consentText,
      consentVersion,
      source: "keyword",
      messageSid: args.messageSid,
      gymResolvedBy,
      // ip/userAgent deliberately absent. An inbound webhook has neither, and
      // the evidence rules require these be derived server-side rather than
      // accepted from a caller — so the honest value is undefined, not
      // Twilio's own IP dressed up as the member's.
    });

    return { status: "recorded", gymName, suppressed, confirmationText };
  },
});
