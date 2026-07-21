"use node";

import crypto from "crypto";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

// Twilio's standard opt-out/opt-in keyword set (case-insensitive, exact match
// on the trimmed message body) — https://www.twilio.com/docs/messaging/compliance/messaging-policy
const STOP_KEYWORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const START_KEYWORDS = new Set(["START", "YES", "UNSTOP"]);

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
  handler: async (ctx, { url, params, signature }): Promise<{ replyMessage?: string }> => {
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!authToken) {
      throw new Error("Missing TWILIO_AUTH_TOKEN — cannot verify inbound SMS webhook");
    }
    if (!isValidTwilioSignature(url, params, signature, authToken)) {
      throw new Error("Invalid Twilio signature");
    }

    const from = params.From;
    const body = (params.Body ?? "").trim().toUpperCase();

    if (from && STOP_KEYWORDS.has(body)) {
      await ctx.runMutation(internal.members.setSmsOptOutByPhone, { phone: from, optedOut: true });
      return { replyMessage: "You've been unsubscribed and won't receive further texts. Reply START to resume." };
    }

    if (from && START_KEYWORDS.has(body)) {
      await ctx.runMutation(internal.members.setSmsOptOutByPhone, { phone: from, optedOut: false });
      return { replyMessage: "You're resubscribed to text updates." };
    }

    return {};
  },
});
