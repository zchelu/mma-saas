import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";
import { fetchAction } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { clientIp } from "@/lib/rate-limit";
import { readJsonBody } from "@/lib/http";

const GENERIC_RESPONSE = {
  message: "If that email has a purchase on file, we've sent a link to finish setting up your account.",
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// KNOWN LIMITATION, accepted at current scale: the matched-email branch below
// does real work (Stripe subscription lookups, a Resend email send) that the
// non-match branch skips, so response *timing* differs even though the
// response *body* is always GENERIC_RESPONSE either way. A patient attacker
// could in principle use that timing gap to statistically distinguish real
// accounts from non-accounts despite the identical response text. Not fixed
// here — revisit if this app ever handles data sensitive enough to justify
// constant-time responses (e.g. padding the fast path to match the slow one).
export async function POST(request: NextRequest) {
  const body = await readJsonBody<{ email?: string }>(request);
  const email = body?.email;
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }

  // "auth" bucket — same 5-attempts/15-min ceiling as every other route that
  // verifies or issues a credential in this app. checkRateLimit is
  // internalMutation now, so this goes through the checkRateLimitAction
  // wrapper instead of fetchMutation — see convex/rateLimit.ts for why.
  const allowed = await fetchAction(api.rateLimit.checkRateLimitAction, {
    bucket: "auth",
    identifier: `ip:${clientIp(request)}`,
  });
  if (!allowed) {
    // Same generic shape as every other outcome here — a 429 with a
    // different body would tell a prober their IP got throttled instead of
    // just looking like any other non-match.
    return NextResponse.json(GENERIC_RESPONSE);
  }

  try {
    // Stripe ownership verification + recovery-token minting both happen
    // inside this action now (convex/recoveryAction.ts) — this route no
    // longer touches Stripe or calls createRecoveryToken directly.
    const { token } = await fetchAction(api.recoveryAction.requestRecovery, { email });

    if (token) {
      const origin = new URL(request.url).origin;
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: "KombatDesk <billing@kombatdesk.com>",
        to: email,
        subject: "Finish setting up your KombatDesk account",
        text: [
          `We found a payment on file for this email but no account linked to it yet.`,
          ``,
          `Finish setting up your account here (link expires in 30 minutes):`,
          `${origin}/welcome?token=${token}`,
          ``,
          `If you didn't request this, you can ignore this email.`,
        ].join("\n"),
      });
    }
  } catch (err) {
    console.error("Recovery email request failed:", err);
    // Fall through to the generic response either way — never reveal via
    // response shape whether an email has a purchase on file.
  }

  return NextResponse.json(GENERIC_RESPONSE);
}
