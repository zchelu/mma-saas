"use node";

import crypto from "crypto";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { STOP_KEYWORDS, START_KEYWORDS, HELP_KEYWORDS } from "../lib/smsKeywords";

// Twilio's standard opt-out/opt-in keyword set (case-insensitive, exact match
// on the trimmed message body) — https://www.twilio.com/docs/messaging/compliance/messaging-policy
// Shared with lib/consentText.ts via lib/smsKeywords.ts so the copy shown to
// members and the keywords actually matched here can never drift apart.

// Verifies X-Twilio-Signature per Twilio's documented algorithm: HMAC-SHA1 of
// the exact webhook URL with all POST params (sorted by key, no separators)
// appended, keyed by the auth token.
function isValidTwilioSignature(url: string, params: Record<string, string>, signature: string, authToken: string) {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  const expected = crypto.createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);
  return expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf);
}

// Every expected outcome is a returned variant, never a throw, so convex/http.ts
// can map each to its own status code. An invalid signature used to throw and
// get caught by a blanket `catch` in the route that answered 403 for anything —
// including a missing TWILIO_AUTH_TOKEN, which is a deployment fault that
// should surface as a 500 and be retried, not silently reported as a forged
// request. Matching on the error message instead wouldn't work: production
// Convex redacts plain Error messages to a generic "Server Error" before the
// caller sees them (see convex/gyms.ts:22-26). So anything reaching the route's
// catch now is genuinely unexpected.
type InboundResult =
  | { status: "ok"; replyMessage?: string }
  | { status: "rate_limited" }
  | { status: "invalid_signature" };

// Only callable via ctx.runAction from convex/http.ts's httpAction — this
// file must stay Node-runtime-only for Node's crypto module (HMAC-SHA1 +
// timingSafeEqual), but httpAction handlers can't live in a "use node" file,
// so the HTTP entry point and this verification/processing logic are split
// across two files, same reason as stripeWebhookAction.ts. Deliberately
// internalAction, not action — unlike Stripe's verifyAndProcess, nothing
// outside this Convex deployment ever needs to call this directly; Twilio
// only ever talks to the http.ts route.
export const verifyAndProcess = internalAction({
  args: {
    url: v.string(),
    params: v.record(v.string(), v.string()),
    signature: v.string(),
  },
  handler: async (ctx, { url, params, signature }): Promise<InboundResult> => {
    // Still a throw, deliberately: this is a broken deployment, not a bad
    // request. It surfaces as a 500 so Twilio retries and the failure is
    // visible, rather than being reported to a legitimate sender as a rejected
    // signature.
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!authToken) {
      throw new Error("Missing TWILIO_AUTH_TOKEN — cannot verify inbound SMS webhook");
    }
    if (!isValidTwilioSignature(url, params, signature, authToken)) {
      return { status: "invalid_signature" };
    }

    const from = params.From;

    // MOVED HERE FROM convex/http.ts, DELIBERATELY — it used to run in the
    // route before this action was ever called, which meant an unauthenticated
    // caller could write a rateLimits row keyed on any From value they liked.
    // Posting 30 unsigned requests claiming to be a real member's number burned
    // that member's bucket, so their genuine STOP was rejected with a 429 by
    // the route before the signature check even ran. An opt-out that the system
    // refuses to hear is the one failure mode here with a statutory penalty
    // attached, so the limiter now sits behind the signature: `from` is
    // Twilio-attested by the time it's used as a key, because the HMAC above
    // covers every POST param including this one.
    //
    // Still bounded-but-not-perfect: a captured valid request replays forever
    // (Twilio signatures carry no timestamp) and each replay consumes budget
    // for that From. MessageSid dedupe is the fix for that, tracked separately.
    const allowed = await ctx.runMutation(internal.rateLimit.checkRateLimit, {
      bucket: "twilioInbound",
      identifier: from ?? "unknown",
    });
    if (!allowed) return { status: "rate_limited" };

    // Replay protection. Twilio's signature carries no timestamp, so a captured
    // valid POST replays indefinitely — and a replayed START silently clears an
    // opt-out the member set later, which is the direction that matters.
    // Claimed after the rate limit so a replay flood is throttled before it
    // touches this table, and before any state change below.
    //
    // A missing MessageSid skips the check rather than failing closed. That
    // isn't a bypass: the HMAC covers every POST param, so an attacker cannot
    // strip MessageSid from a captured request without invalidating the
    // signature that got them past line 55. Real Twilio deliveries always carry
    // it; this only avoids hard-failing if Twilio ever changes the param set.
    const messageSid = params.MessageSid;
    const isReplay = messageSid
      ? !(await ctx.runMutation(internal.twilioInbound.claimMessageSid, { messageSid }))
      : false;

    const body = (params.Body ?? "").trim().toUpperCase();

    // Only the state change is skipped on a replay, never the reply — the
    // response stays byte-identical to a first delivery, so nothing about it
    // reveals that this message was recognized as a duplicate.
    if (from && STOP_KEYWORDS.includes(body)) {
      if (!isReplay) {
        await ctx.runMutation(internal.members.setSmsOptOutByPhone, { phone: from, optedOut: true });
      }
      return {
        status: "ok",
        replyMessage: "You've been unsubscribed and won't receive further texts. Reply START to resume.",
      };
    }

    if (from && START_KEYWORDS.includes(body)) {
      if (!isReplay) {
        await ctx.runMutation(internal.members.setSmsOptOutByPhone, { phone: from, optedOut: false });
      }
      return { status: "ok", replyMessage: "You're resubscribed to text updates." };
    }

    // Carrier-required 10DLC HELP support. Deliberately reply-only — no
    // gymId is resolvable from this webhook (one shared TWILIO_PHONE_NUMBER
    // across every gym, no per-gym signal in Twilio's POST params), so this
    // names "KombatDesk" as sender rather than guessing a gym via a
    // phone->member->gym lookup, which would inherit the same cross-gym
    // ambiguity setSmsOptOutByPhone already has. That's a known mismatch
    // against lib/consentText.ts, which names the gym as sender for the
    // consent-page copy — a real inconsistency, tracked with the lawyer, not
    // something to paper over here. Resolvable later by moving to per-gym
    // Twilio numbers. Support address (kombatdesk@outlook.com) is the one
    // already published in content/terms.html, not the send-only Resend
    // identity.
    if (from && HELP_KEYWORDS.includes(body)) {
      return {
        status: "ok",
        replyMessage:
          "KombatDesk: attendance reminders from your gym. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out. Help: kombatdesk@outlook.com",
      };
    }

    return { status: "ok" };
  },
});
