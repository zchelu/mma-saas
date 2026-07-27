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
export const CONSENT_VERSION = "1";

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
    `I agree to receive automated text messages from ${gymName} about my membership, ` +
    `including a reminder if I haven't been in for a while, sent to the number above using ` +
    `an automatic telephone dialing system. Consent is not a condition of membership or of ` +
    `purchasing anything. Message frequency varies. Message and data rates may apply. ` +
    `Reply ${formatKeywordList(STOP_KEYWORDS)} to opt out at any time. ` +
    `Reply HELP for help. ` +
    `Reply ${formatKeywordList(START_KEYWORDS)} to opt back in.`
  );
}
