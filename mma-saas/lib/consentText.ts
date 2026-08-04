import { STOP_KEYWORDS, START_KEYWORDS } from "./smsKeywords";

// Single source of truth for SMS-consent copy — both the public consent page
// (app/consent/[gymSlug]) and convex/consent.ts:submitConsent import this, so
// the checkbox label a member actually sees and the consentText frozen onto
// their evidence row can never drift apart. Bump CONSENT_VERSION whenever the
// wording below changes; existing consentSubmissions rows keep whatever text
// was live when they were written (see convex/consent.ts's idempotency check,
// keyed on gymId+phone+version) — that's deliberate, not a bug, since the
// whole point of storing this is knowing what each person actually agreed to.
//
// DRAFT — not legal-reviewed. Zain is taking the consent/sender-of-record
// question to a lawyer; expect this wording (and possibly CONSENT_VERSION) to
// change before this goes live with a real gym.
//
// v2 (2026-07-27): names KombatDesk as the sender-of-record inside the
// checkbox itself — the registered brand now appears in the text the member
// actually agrees to, not only in the surrounding explainer paragraph. The
// wording genuinely changed, so this bump is required: consentSubmissions
// snapshots consentText per row and the idempotency check is keyed on
// gymId+phone+consentVersion. Existing v1 rows are deliberately NOT
// backfilled or mutated — they record what those members really agreed to.
// One intended consequence: someone who already submitted under v1 is no
// longer deduped and can submit again under v2, which is correct — new
// wording is a new TCPA event, not a duplicate.
// v3 (2026-07-28): replaces the unquantified "Message frequency varies." with
// a specific ceiling — "Up to 5 automated msgs/month."
//
// 5, not 4. The 3-attempt winback cap is NOT the monthly bound: a check-in
// clears winbackAttempts AND lastRetentionTextAt (members.ts:checkIn), which
// rearms a member for a second sequence in the same month. The real bound is
// the 7-day per-member spacing in sendRetentionTexts.ts:getAtRiskMembers,
// which allows floor(30/7)+1 = 5 sends in a 30- or 31-day month. 4 is typical;
// 5 is the ceiling under favourable cron/Twilio jitter. The disclosure states
// the ceiling. Manual Elite sends are inside that 5, not additive — they run
// through the same sendRetentionTextsCore, hit the same per-member gates, and
// write the same recordRetentionText — so there is deliberately no "plus
// messages your gym sends" clause; that channel does not exist.
//
// This sentence must stay BYTE-IDENTICAL everywhere it appears, because
// carriers cross-check the HELP reply against the opt-in disclosure and both
// linked legal documents (/privacy is one click from the consent page footer).
//
// THE CANONICAL LIST LIVES IN convex/sendRetentionTexts.ts's getAtRiskMembers,
// beside the 7-day constant that makes the number 5 true. It is not duplicated
// here on purpose: this file used to carry its own copy of the list, which is
// two lists to keep in sync instead of one, and the copy here went stale the
// moment the SMS keyword opt-in added two more sites. One list, one place.
//
// A material TCPA disclosure term changed, so the bump was required for the
// same reason v2's was: consentSubmissions snapshots consentText per row, and
// leaving two different frequency disclosures under one version label destroys
// the ability to prove which one a given member saw. This edit corrects the
// wording INSIDE v3 before any v3 row is stamped in prod, so it is not a
// second bump. v2 rows are NOT backfilled or mutated, members are NOT
// re-prompted (smsConsentConfirmed is unversioned, so nobody already confirmed
// becomes untextable), and the only behavioural effect is that a v2 submitter
// is no longer deduped if they return to the form on their own.
export const CONSENT_VERSION = "3";

// Opt-out/opt-in keyword lists come from lib/smsKeywords.ts, shared with
// convex/twilioWebhookAction.ts's actual STOP/START matching — that file is
// "use node" (Node-runtime Convex action) and this module is imported into a
// Next.js Server Component, which can't pull in a Node-only Convex action,
// but a plain-TS, import-free module works fine on both sides.
//
// HELP is now live in twilioWebhookAction.ts (generic KombatDesk-branded
// reply, not gym-specific — see that file's comment), so it's advertised
// here too.
function formatKeywordList(keywords: string[]): string {
  if (keywords.length === 1) return keywords[0];
  return `${keywords.slice(0, -1).join(", ")}, or ${keywords[keywords.length - 1]}`;
}

// ─── SMS KEYWORD OPT-IN (text-to-join) ──────────────────────────────────────
//
// A SEPARATE VERSION NAMESPACE FROM CONSENT_VERSION ABOVE, AND THAT IS THE
// POINT. Nothing below touches CONSENT_VERSION or getConsentText: a poster and
// a web form are different disclosures shown to different people through
// different channels, and forcing them onto one counter means a wording change
// on either invalidates the evidence for both.
//
// Both strings land in consentSubmissions.consentVersion, which is a plain
// string. NOTHING MAY NUMERICALLY COMPARE OR SORT THAT FIELD once both
// namespaces are live — parseInt("keyword-1") is NaN and every comparison
// against it is silently false, which reads as "never consented". Restated
// here because this file is where the second namespace is introduced.
//
// keyword-1: the member saw the SIGNAGE ONLY. No confirmation reply was sent.
// keyword-2: the member saw the signage AND received the confirmation reply.
//
// Which one is stamped is decided per-row at write time by whether the reply
// actually goes out (convex/keywordConsent.ts), never assumed — snapshotting
// a confirmation the member never received would be exactly the kind of
// plausible-but-false evidence this table exists to prevent.
export const KEYWORD_CONSENT_VERSION_SIGNAGE_ONLY = "keyword-1";
export const KEYWORD_CONSENT_VERSION_WITH_CONFIRMATION = "keyword-2";

// WHAT THE POSTER SAYS. This is the disclosure a member actually reads before
// texting in, so it is what gets snapshotted onto their evidence row.
//
// PRINTED SIGNAGE IS A CONSENT SURFACE YOU CANNOT VERSION-CONTROL. Every
// poster in every gym is a physical object; changing this string does not
// change them, it only means the repo and the wall disagree. So this text is
// deliberately MINIMAL — the smallest set of terms that is complete — and the
// confirmation reply below is where anything that may need to change remotely
// belongs.
//
// ⚠️ CARRIES THE FREQUENCY SENTENCE. "Up to 5 automated msgs/month." must stay
// BYTE-IDENTICAL to every site listed in convex/sendRetentionTexts.ts's
// getAtRiskMembers
// plus the Twilio console's Advanced Opt-Out HELP message. This is a NEW site
// carrying it. When that sentence changes, this string changes with it, and
// every poster in the field becomes stale until reprinted — which is a real
// operational cost and an argument for never changing it casually.
export function getKeywordSignageText(gymName: string): string {
  return (
    `Text-in opt-in for ${gymName}, sent by KombatDesk on the gym's behalf. ` +
    `You'll get automated attendance reminders, including a nudge if you ` +
    `haven't been in for a while. Consent is not a condition of membership or ` +
    `of purchasing anything. Up to 5 automated msgs/month. Message and data ` +
    `rates may apply. Reply STOP to opt out at any time. Reply HELP for help. ` +
    `Terms: kombatdesk.com/terms`
  );
}

// THE CONFIRMATION REPLY — the versioned artifact we actually control.
//
// ⚠️ NOT SENT BY DEFAULT. This is a NEW OUTBOUND MESSAGE TYPE the approved A2P
// campaign does not declare, and Twilio's own 7/30 Message Flow draft had this
// exact line cut because declaring a message you don't send is a false
// statement to the carrier. Sending one never declared is that inverted. It is
// gated behind an env flag AND a gym allowlist in convex/keywordConsent.ts and
// must not be enabled for a real gym until the single batched CTA rewrite
// lands — see docs/sms-campaign-constraints.md.
//
// Also carries the frequency sentence, same byte-identical rule as above.
export function getKeywordConfirmationText(gymName: string): string {
  return (
    `${gymName}: you're opted in to automated attendance reminders from ` +
    `KombatDesk. Up to 5 automated msgs/month. Message and data rates may ` +
    `apply. Reply STOP to opt out. Help: kombatdesk@outlook.com`
  );
}

export function getConsentText(gymName: string): string {
  return (
    `I agree to receive automated text messages about my membership from ${gymName}, ` +
    `sent by KombatDesk on the gym's behalf, ` +
    `including a reminder if I haven't been in for a while, sent to the number above using ` +
    `an automatic telephone dialing system. Consent is not a condition of membership or of ` +
    `purchasing anything. Up to 5 automated msgs/month. Message and data rates may apply. ` +
    `Reply ${formatKeywordList(STOP_KEYWORDS)} to opt out at any time. ` +
    `Reply HELP for help. ` +
    `Reply ${formatKeywordList(START_KEYWORDS)} to opt back in.`
  );
}
