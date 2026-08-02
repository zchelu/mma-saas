"use node";

import crypto from "crypto";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import {
  STOP_KEYWORDS_HANDLED,
  START_KEYWORDS_HANDLED,
  HELP_KEYWORDS_HANDLED,
} from "../lib/smsKeywords";

// Twilio's standard opt-out/opt-in keyword set (case-insensitive, exact match
// on the trimmed message body) — https://www.twilio.com/docs/messaging/compliance/messaging-policy
//
// Matches the *_HANDLED lists, NOT the advertised ones. Twilio's standard set
// accepts OPTOUT and REVOKE for opt-out and INFO for help, which our consent
// copy does not advertise. Matching only the advertised six meant a member
// texting REVOKE was opted out inside Twilio while members.smsOptedOut stayed
// unset here — Twilio blocked the sends (21610) so nobody was messaged, but our
// own records contradicted the member's actual choice and the opt-out lived
// only in Twilio. See the long comment in lib/smsKeywords.ts for why the
// advertised lists must not simply be widened to match.

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
    // DELIBERATELY NO replyMessage. This branch used to return
    // "You've been unsubscribed and won't receive further texts. Reply START
    // to resume." That reply is structurally undeliverable and always was:
    // with Advanced Opt-Out enabled (7/30), Twilio blocks every outbound
    // message to the number at the moment it processes the STOP — before our
    // TwiML is handed over. The reply came back 21610 "attempt to send to
    // unsubscribed recipient" every time, verified in Twilio's error log
    // 2026-08-02 at 21:59 and 22:08 UTC, one per STOP.
    //
    // Removing it is not a compliance regression. Twilio's own opt-out
    // confirmation IS delivered and is what carriers require; the member sees
    // exactly one confirmation either way. What changes is that we stop
    // minting a guaranteed 21610 in the error log on every single opt-out —
    // noise that buries real 21610s, which is the precise error that caused
    // the 7/30 misdiagnosis of a blocked send.
    //
    // Do not "restore" this reply. If it ever needs to exist, Advanced
    // Opt-Out has to be reconfigured first, and that is a carrier-facing
    // change, not a code change.
    if (from && STOP_KEYWORDS_HANDLED.includes(body)) {
      if (!isReplay) {
        await ctx.runMutation(internal.members.setSmsOptOutByPhone, { phone: from, optedOut: true });
      }
      return { status: "ok" };
    }

    if (from && START_KEYWORDS_HANDLED.includes(body)) {
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
    if (from && HELP_KEYWORDS_HANDLED.includes(body)) {
      return {
        status: "ok",
        replyMessage:
          "KombatDesk: attendance reminders from your gym. Up to 5 automated msgs/month. Msg & data rates may apply. Reply STOP to opt out. Help: kombatdesk@outlook.com",
      };
    }

    return { status: "ok" };
  },
});
