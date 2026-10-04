// Single place to change tier names, prices, and slugs for the pricing page. As
// of the starter/pro/elite -> academy/fightteam/blackbelt rename, these slugs are
// what the onboarding wizard and Stripe webhook use too.
//
// THIS LIVES OUTSIDE page.tsx ON PURPOSE — do not move it back. This version of
// Next.js validates that a page file exports only the page exports it knows
// (default, metadata, dynamic, generateStaticParams, and friends) and rejects
// any other named export. `export const PRICING_TIERS` in app/pricing/page.tsx
// therefore failed `tsc --noEmit` with a TS2344 on the generated
// .next/dev/types/app/pricing/page.ts — one permanent error that made a red
// typecheck the normal state of the repo, which is how a real type error in new
// work goes unnoticed.
//
// Deliberately NOT folded into lib/plans.ts, which convex/stripeWebhookAction.ts
// imports: that module is billing logic pulled into the Convex bundle, and this
// is marketing copy for one page. Keeping them apart is the same reasoning that
// split lib/foundingOffer.ts out of lib/plans.ts.
//
// BULLETS ON EVERY CARD (2026-10-04). Until now only Black Belt listed any, so
// the two cheaper cards read as empty next to it. Academy and Fight Team now
// carry the same three, because they ARE the same product — the tiers differ
// by gym size, not by feature (see CTA_LABEL's comment in page.tsx). Each one
// restates a line from INCLUDED_IN_EVERY_PLAN in page.tsx; do not add a bullet
// here that is not true of every plan. Black Belt's first bullet says it
// includes all of that, then lists the three things only it has.
const CORE_PERKS = [
  "Cold members flagged by name",
  "Automatic winback texts",
  "Setup call with me",
];

export const PRICING_TIERS = [
  {
    slug: "academy",
    name: "Academy",
    size: "Up to 100 members",
    price: 99,
    perks: CORE_PERKS,
    roiLine: "Save one member a year and it's paid for itself.",
  },
  {
    slug: "fightteam",
    name: "Fight Team",
    size: "101–250 members",
    price: 179,
    perks: CORE_PERKS,
    badge: "MOST POPULAR",
    highlighted: true,
    roiLine:
      "Save two members a year and it's paid for itself. Built for the range where silent quitters stop being names you'd notice.",
  },
  {
    slug: "blackbelt",
    name: "Black Belt",
    size: "251+ members",
    price: 299,
    perks: [
      "Everything in Fight Team",
      "Done-for-you roster import",
      "Monthly revenue review call with me",
      "Direct line to me",
    ] as string[],
  },
];
