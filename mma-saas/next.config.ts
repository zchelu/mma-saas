import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
