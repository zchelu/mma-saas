import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Twilio has /demo/sms-consent on file from earlier submissions, where it
  // still served the static "Add Member" checkbox mockup that was rejected.
  // Point it at the real, live member-facing consent form instead. Config-level
  // (not client-side) so the redirect happens before the filesystem route —
  // app/demo/sms-consent/page.tsx is never reached — and so a reviewer hitting
  // the old URL gets a 308 rather than a page that flashes the old content.
  redirects() {
    return [
      {
        source: "/demo/sms-consent",
        destination: "/consent/colorado-springs-bjj",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
