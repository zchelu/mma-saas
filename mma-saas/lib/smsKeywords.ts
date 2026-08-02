// Single source of truth for Twilio SMS opt-out/opt-in/help keywords, shared
// between convex/twilioWebhookAction.ts (the actual keyword matching, "use
// node") and lib/consentText.ts (the consent copy that advertises these same
// keywords to a Next.js Server Component, which can't import a "use node"
// Convex action). Plain TS, no imports, so both sides can pull it in
// regardless of runtime. https://www.twilio.com/docs/messaging/compliance/messaging-policy
//
// TWO LISTS PER CATEGORY, AND THE DISTINCTION IS LOAD-BEARING.
//
//   *_KEYWORDS          — what we ADVERTISE to members.
//   *_KEYWORDS_HANDLED  — what we MATCH on inbound.
//
// HANDLED is a superset of advertised, never the reverse. Honoring more than
// you advertise is safe; advertising more than you honor is a broken promise
// to a member trying to opt out.
//
// WHY THEY DIVERGE. Verified in the Twilio console 2026-07-30, messaging
// service MG3df4bb11fd47a0f0b562ba9605aacd9d, Opt-Out Management. Twilio's
// standard keyword set accepts EIGHT opt-out keywords:
//
//   cancel, quit, stop, optout, unsubscribe, stopall, revoke, end
//
// We were matching six. A member texting OPTOUT or REVOKE was opted out at the
// Twilio layer (further sends blocked with 21610) while
// convex/twilioWebhookAction.ts never matched the body, so
// members.setSmsOptOutByPhone never ran and members.smsOptedOut stayed unset.
// Nobody received an unwanted message — Twilio blocked them — but our own
// records said "active, textable" about a member who had opted out,
// sendRetentionTexts kept selecting them, and the opt-out existed only inside
// Twilio. If we ever changed messaging service or provider it would not travel
// with our data. Same shape for HELP, where Twilio also accepts INFO.
//
// DO NOT "SIMPLIFY" THIS BY ADDING THE EXTRA KEYWORDS TO THE ADVERTISED LISTS.
// lib/consentText.ts renders STOP_KEYWORDS and START_KEYWORDS verbatim into the
// consent checkbox text. Changing those arrays changes the text a member agrees
// to, which requires a CONSENT_VERSION bump (see the rules at the top of
// consentText.ts) — and that exact wording is also quoted inside the A2P
// campaign's Call-to-Action field, which is under carrier review. Widening the
// advertised list would desync the submission from the live page mid-review.
// The advertised lists below are byte-for-byte what CONSENT_VERSION 3 shipped
// and must stay that way until a deliberate version bump.

// ADVERTISED. Rendered into consent copy by lib/consentText.ts. Frozen at
// CONSENT_VERSION 3 — changing these is a consent-text change, not a refactor.
export const STOP_KEYWORDS = ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"];
export const START_KEYWORDS = ["START", "YES", "UNSTOP"];
export const HELP_KEYWORDS = ["HELP"];

// HANDLED. Matched by convex/twilioWebhookAction.ts. Mirrors what Twilio's
// standard keyword set actually accepts, so our database agrees with Twilio's
// opt-out list. If Twilio's set changes, or Advanced Opt-Out is enabled with
// custom keywords, these must be updated to match the console — the console is
// the authority for what a member can successfully send, not this file.
export const STOP_KEYWORDS_HANDLED = [...STOP_KEYWORDS, "OPTOUT", "REVOKE"];
export const START_KEYWORDS_HANDLED = [...START_KEYWORDS];
export const HELP_KEYWORDS_HANDLED = [...HELP_KEYWORDS, "INFO"];
