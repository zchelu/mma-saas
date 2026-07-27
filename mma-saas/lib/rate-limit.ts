import { NextRequest } from "next/server";

// NextRequest.ip / .geo were removed in Next 15 — the client IP must be read
// from a header instead. Checked Vercel's current docs
// (vercel.com/docs/headers/request-headers) directly rather than assuming:
// Vercel overwrites x-forwarded-for at its edge and does not forward
// externally-supplied values, specifically to prevent IP spoofing — unless
// the project is on an Enterprise "Trusted Proxy" plan (this one isn't). So
// plain x-forwarded-for is not actually attacker-controlled on this
// project's hosting. x-vercel-forwarded-for is preferred anyway, per
// Vercel's own docs, since it stays reliable even if a proxy (e.g.
// Cloudflare) is ever added in front of Vercel later — a scenario where
// x-forwarded-for itself could get re-overwritten by that new proxy instead.
// x-real-ip is documented as identical to x-forwarded-for, not a distinct
// stronger signal, so it isn't checked separately here.
export function clientIp(request: NextRequest): string {
  return clientIpFromHeaders(request.headers);
}

// Same header-preference logic as clientIp above, taking a plain Headers
// object instead of NextRequest — for callers that only have that, like a
// Server Action reading next/headers' headers() (Route Handlers get a
// NextRequest and should keep using clientIp).
export function clientIpFromHeaders(headers: Headers): string {
  const vercelForwardedFor = headers.get("x-vercel-forwarded-for");
  const forwardedFor = headers.get("x-forwarded-for");
  return (vercelForwardedFor ?? forwardedFor)?.split(",")[0]?.trim() || "unknown";
}
