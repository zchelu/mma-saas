import { NextRequest, NextResponse } from "next/server";
import { fetchAction } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { clientIp } from "@/lib/rate-limit";
import { readJsonBody } from "@/lib/http";

const GENERIC_RESPONSE = {
  message: "If that email has a purchase on file, we've sent a link to finish setting up your account.",
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// TIMING, largely closed. This route no longer branches on whether the email
// matched: requestRecovery does no Stripe or Resend work inline — it consumes
// two rate limits, schedules convex/recoveryAction.ts:deliverRecoveryEmail with
// runAfter(0), and returns. The old gap was a match doing several hundred
// milliseconds of Stripe lookups plus an email send while a non-match did
// neither; what's left is one scheduler insert, and it happens before match
// status is even known, so it can't correlate with it.
//
// Residual: a rate-limited call returns after one mutation instead of two plus
// a schedule. Sub-millisecond, and it reveals throttle state rather than
// account existence. Accepted.
//
// This route's own limit is layer two. The real per-email and platform-wide
// limits live inside the Convex action, because this route is not the only way
// to reach it — the deployment is directly callable.
export async function POST(request: NextRequest) {
  const body = await readJsonBody<{ email?: string }>(request);
  const email = body?.email;
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }

  // "recoverIp", not the shared "auth" bucket. Two reasons: this is now an
  // outer layer rather than the control, and "auth" is no longer reachable
  // through checkRateLimitAction at all — it keys on a Clerk user id in the
  // claim flows, which made it burnable against a named victim. See the
  // PUBLICLY_CALLABLE_BUCKETS allowlist in convex/rateLimit.ts.
  const allowed = await fetchAction(api.rateLimit.checkRateLimitAction, {
    bucket: "recoverIp",
    identifier: `ip:${clientIp(request)}`,
  });
  if (!allowed) {
    // Same generic shape as every other outcome here — a 429 with a
    // different body would tell a prober their IP got throttled instead of
    // just looking like any other non-match.
    return NextResponse.json(GENERIC_RESPONSE);
  }

  try {
    // Stripe verification, token minting, and the email send all happen inside
    // Convex now (convex/recoveryAction.ts). There is deliberately no return
    // value to branch on: the token must never cross a network boundary back
    // to a caller, and the link origin must never come from the request, or an
    // attacker could point a real victim's email at a domain they control.
    await fetchAction(api.recoveryAction.requestRecovery, { email });
  } catch (err) {
    console.error("Recovery email request failed:", err);
    // Fall through to the generic response either way — never reveal via
    // response shape whether an email has a purchase on file.
  }

  return NextResponse.json(GENERIC_RESPONSE);
}
