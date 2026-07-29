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
// This sentence must stay BYTE-IDENTICAL in five places, because carriers
// cross-check the HELP reply against the opt-in disclosure and both linked
// legal documents (/privacy is one click from the consent page footer):
//   - lib/consentText.ts (here)
//   - convex/twilioWebhookAction.ts (HELP auto-reply body)
//   - content/terms.html §23 Program Description
//   - content/terms.html §23 Message Frequency
//   - content/privacy-policy.html §9 Frequency
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
