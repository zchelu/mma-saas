import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev server rejects cross-origin asset/HMR requests by default (Next 15+).
  // Needed so the site works when accessed through the cloudflared tunnel
  // (e.g. for testing kiosk pages on a phone/iPad). Update if the tunnel
  // hostname changes — quick tunnels mint a new random subdomain each run.
  allowedDevOrigins: ["banana-hung-corn-wars.trycloudflare.com"],
  // Twilio has /demo/sms-consent on file from earlier submissions, where it
  // still served the static "Add Member" checkbox mockup that was rejected.
  // Point it at the real, live member-facing consent form instead. Config-level
  // (not client-side) so the redirect happens before the filesystem route —
  // app/demo/sms-consent/page.tsx is never reached — and so a reviewer hitting
  // the old URL gets a 308 rather than a page that flashes the old content.
  //
  // The destination is a gym SLUG, resolved at request time by
  // convex/gyms.ts:getBySlug — it lives in the gyms row, editable from the
  // Convex dashboard, so renaming that gym silently turns this into a 308 to a
  // 404. Retargeted from "colorado-springs-bjj" to "demo" for that reason; if
  // the slug moves again, this line has to move with it.
  redirects() {
    return [
      {
        source: "/demo/sms-consent",
        destination: "/consent/demo",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
