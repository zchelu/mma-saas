// Single source of truth for Twilio SMS opt-out/opt-in/help keywords, shared
// between convex/twilioWebhookAction.ts (the actual keyword matching, "use
// node") and lib/consentText.ts (the consent copy that advertises these same
// keywords to a Next.js Server Component, which can't import a "use node"
// Convex action). Plain TS, no imports, so both sides can pull it in
// regardless of runtime. https://www.twilio.com/docs/messaging/compliance/messaging-policy
export const STOP_KEYWORDS = ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"];
export const START_KEYWORDS = ["START", "YES", "UNSTOP"];
export const HELP_KEYWORDS = ["HELP"];
