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
// consentPhone/consentIp back /consent/[gymSlug] (convex/consent.ts) as two
// separate buckets, not one: consentPhone (keyed ip+normalizedPhone) is tight
// enough to catch a scripted loop hammering one phone number; consentIp
// (keyed ip alone) is deliberately looser, with a ceiling set above a real
// gym class size so a front-desk QR code shared behind one NAT'd IP doesn't
// get a whole class silently rate-limited. Kept as two buckets so the
// caller can tell which one tripped and show an honest "try again shortly"
// instead of the same generic response used for a phone match/no-match.
// recoverEmail/recoverGlobal/recoverIp back the "recover my purchase" flow as
// three layers. recoverEmail (keyed on the normalized email) is the precise
// one and lives INSIDE convex/recoveryAction.ts, so it applies to direct Convex
// callers, not just traffic through app/api/recover/route.ts. recoverGlobal is
// a deliberately coarse platform-wide ceiling on the same flow: the email key
// is caller-supplied, so an attacker rotating addresses would otherwise get
// unlimited Stripe fan-out on our account. It is sized far above any plausible
// real recovery volume, because a global bucket is itself a griefing target —
// burning it blocks legitimate recovery for everyone until the window rolls.
// recoverIp is the route-level second layer and is the only one of the three
// reachable from the public action below.
const BUCKETS: Record<string, { limit: number; windowMs: number }> = {
  checkout: { limit: 8, windowMs: 10 * 60 * 1000 },
  auth: { limit: 5, windowMs: 15 * 60 * 1000 },
  portal: { limit: 15, windowMs: 10 * 60 * 1000 },
  checkin: { limit: 60, windowMs: 5 * 60 * 1000 },
  twilioInbound: { limit: 30, windowMs: 15 * 60 * 1000 },
  consentPhone: { limit: 3, windowMs: 15 * 60 * 1000 },
  consentIp: { limit: 75, windowMs: 15 * 60 * 1000 },
  recoverEmail: { limit: 3, windowMs: 15 * 60 * 1000 },
  recoverGlobal: { limit: 40, windowMs: 60 * 60 * 1000 },
  recoverIp: { limit: 5, windowMs: 15 * 60 * 1000 },
};

// Buckets checkRateLimitAction (below) is allowed to touch — exactly the three
// consumed by a Next.js route via fetchAction, and nothing else.
//
// This exists because that action takes a caller-supplied bucket AND
// identifier, and Convex cannot verify that an asserted identifier belongs to
// the caller. That was tolerable while every bucket was a convenience throttle.
// It stopped being tolerable once a bucket became the enforcement point for a
// security control: with "recoverEmail" reachable, anyone could call this
// action three times with a real customer's address and lock that customer out
// of the only path back into their paid account. Same for "auth", which keys
// on a Clerk user id in claimGymBySessionId/claimGymByRecoveryToken.
//
// This is a containment measure, not a complete fix — "recoverIp" is still
// burnable for an arbitrary IP by a direct caller. It's layer two behind
// recoverEmail/recoverGlobal, which are now unreachable from here, so a burned
// recoverIp no longer disables the real control. The complete fix is a shared
// secret between Vercel and Convex on this action; deliberately not done here,
// since a fourth env var that must match across two dashboards is exactly the
// drift lib/plans.ts already warns about, and it deserves its own change.
const PUBLICLY_CALLABLE_BUCKETS = new Set(["checkout", "portal", "recoverIp"]);

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
// HONEST LIMITATION, narrowed but not closed: Convex has no way to verify
// that a caller-asserted identifier is actually theirs, so a direct caller
// can still consume another actor's quota within the buckets this action is
// allowed to reach. The allowlist above is what keeps that bounded to
// convenience throttles (checkout/portal/recoverIp) and out of the buckets
// that now enforce a security control. Pairs with clientIp() preferring
// Vercel's edge-verified header (see lib/rate-limit.ts) so a real victim's
// identifier isn't something an attacker can easily forge as their own.
// Residual risk: a victim's IP gets 429'd on checkout/portal/recovery for one
// window — self-resolving griefing, not data exposure or account compromise.
export const checkRateLimitAction = action({
  args: { bucket: v.string(), identifier: v.string() },
  handler: async (ctx, { bucket, identifier }): Promise<boolean> => {
    // Deliberately indistinguishable from a genuine "you're throttled"
    // response: a caller probing for which buckets exist shouldn't be able to
    // tell a rejected bucket name from an exhausted one.
    if (!PUBLICLY_CALLABLE_BUCKETS.has(bucket)) {
      console.error(`checkRateLimitAction: refused non-public bucket "${bucket}"`);
      return false;
    }
    return await ctx.runMutation(internal.rateLimit.checkRateLimit, { bucket, identifier });
  },
});
