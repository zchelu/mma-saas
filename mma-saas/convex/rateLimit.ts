import { action, internalMutation, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

// Named buckets with server-side-fixed limits — callers only supply a bucket
// name + identifier (e.g. request IP or Clerk user id), never the limit
// itself, so a caller can't widen its own ceiling by passing a larger number.
//
// "auth" backs every route that verifies a credential (recovery email
// request, recovery-token/checkout-session claim) — 5 attempts per 15
// minutes per actor, matching Clerk's own attack-protection posture on this
// project rather than inventing a separate policy.
const BUCKETS: Record<string, { limit: number; windowMs: number }> = {
  checkout: { limit: 8, windowMs: 10 * 60 * 1000 },
  auth: { limit: 5, windowMs: 15 * 60 * 1000 },
  portal: { limit: 15, windowMs: 10 * 60 * 1000 },
  checkin: { limit: 60, windowMs: 5 * 60 * 1000 },
  twilioInbound: { limit: 30, windowMs: 15 * 60 * 1000 },
};

// Fixed-window counter (not sliding) — a burst can land two windows in a row
// right at the boundary. Fine here: the goal is a sane abuse ceiling on
// pre-revenue traffic, not precise per-second throttling.
//
// Exported as a plain function (not just the mutation below) so mutations
// that already hold ctx.db — e.g. members.checkIn — can consume a bucket
// in-process, same transaction, no extra round trip. Actions, which can't
// touch ctx.db directly, go through the checkRateLimit mutation instead.
export async function consumeRateLimit(
  ctx: MutationCtx,
  bucket: string,
  identifier: string
): Promise<boolean> {
  const cfg = BUCKETS[bucket];
  if (!cfg) throw new Error(`Unknown rate limit bucket: ${bucket}`);

  // Cap identifier length so a malformed/huge caller-supplied string (e.g. a
  // spoofed x-forwarded-for) can't bloat the rateLimits table.
  const key = `${bucket}:${identifier.slice(0, 200)}`;
  const now = Date.now();
  const existing = await ctx.db
    .query("rateLimits")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();

  if (!existing || now - existing.windowStart >= cfg.windowMs) {
    if (existing) {
      await ctx.db.patch(existing._id, { windowStart: now, count: 1 });
    } else {
      await ctx.db.insert("rateLimits", { key, windowStart: now, count: 1 });
    }
    return true;
  }

  if (existing.count >= cfg.limit) return false;
  await ctx.db.patch(existing._id, { count: existing.count + 1 });
  return true;
}

// Internal — only reachable via ctx.runMutation from a trusted Convex
// function (checkRateLimitAction below, for Next.js callers; or directly by
// any other Convex action/httpAction, e.g. convex/http.ts's /twilio/inbound
// route). Previously a public mutation callable directly by anyone with any
// bucket+identifier pair — letting an attacker pre-exhaust a specific
// victim's quota (e.g. call it 8x with identifier = a real user's IP to lock
// them out of checkout) without ever going through the route that's
// supposed to own that decision.
export const checkRateLimit = internalMutation({
  args: { bucket: v.string(), identifier: v.string() },
  handler: async (ctx, { bucket, identifier }) => consumeRateLimit(ctx, bucket, identifier),
});

// Public entry point for Next.js API routes (via convex/nextjs's
// fetchAction) — actions can't touch ctx.db directly, so this just forwards
// to the internal mutation above.
//
// HONEST LIMITATION: this doesn't fully close the "attacker targets an
// arbitrary identifier" gap the comment above describes — this action is
// itself just as directly callable (with any bucket+identifier a caller
// supplies) as the old public mutation was, since Convex has no way to
// verify a caller-asserted identifier is actually theirs. What this DOES
// achieve: it removes rate-limit-checking from being a casually-callable
// public mutation that other code might reach for without thinking, and
// pairs with clientIp() now preferring Vercel's edge-verified header (see
// lib/rate-limit.ts) so a real victim's identifier is at least not
// something an attacker can easily learn or forge as their own. The
// remaining risk is a low-severity, self-resolving griefing vector (a
// victim's IP gets 429'd for one rate-limit window), not a data-exposure or
// account-compromise issue.
export const checkRateLimitAction = action({
  args: { bucket: v.string(), identifier: v.string() },
  handler: async (ctx, { bucket, identifier }): Promise<boolean> => {
    return await ctx.runMutation(internal.rateLimit.checkRateLimit, { bucket, identifier });
  },
});
