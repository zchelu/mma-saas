import Link from "next/link";

// The founding (comped) trial's only surface on /dashboard: the END of it.
//
// THERE IS DELIBERATELY NO COUNTDOWN while the trial is running. An earlier
// version rendered "N days left… nothing will be charged on <date>" every day
// of the trial, and it was removed on request: the founding gym is being
// walked through the product by Zain personally, already knows it is free, and
// a running clock over their own dashboard sells against the product every
// time they open it. /billing still states the trial and its end date for
// anyone who goes looking — see FoundingTrialCard there.
//
// What CANNOT be removed is this: the comped trial ends by doing nothing at
// all. There is no Stripe subscription behind it, so no invoice, no receipt
// and no failed-payment email will ever tell the owner it is over — the only
// signal is that writes start failing (convex/gyms.ts:hasWriteAccess). Without
// this banner the first customer's experience of day 61 is the app silently
// breaking.
//
// WHY A BANNER RATHER THAN A HARD BLOCK. By then the gym has a real roster,
// real attendance history and real consent records in here. Locking them out
// of the page would make their own data look lost at the exact moment we are
// asking them to pay for it. convex/gyms.ts keeps READ access and revokes
// WRITE access; this explains the state they are actually in, and
// requireWriteAccess carries the matching sentence if they try to change
// something.
export default function FoundingTrialBanner({
  endsAt,
  ended,
}: {
  endsAt: number;
  ended: boolean;
}) {
  if (!ended) return null;

  return (
    <div
      className="flex flex-col gap-3 rounded-lg px-6 py-5 mb-12 sm:flex-row sm:items-center sm:justify-between"
      style={{ border: "1px solid #E02020", backgroundColor: "#1A0E0E" }}
    >
      <div className="flex flex-col gap-1">
        <span style={{ color: "#FFFFFF", fontWeight: 600 }}>
          Your free founding trial ended on {new Date(endsAt).toLocaleDateString()}
        </span>
        <span className="text-sm" style={{ color: "#CCCCCC" }}>
          Nothing was charged — we never took a card. Everything you&apos;ve added is
          still here and still readable; choose a plan to start making changes again.
        </span>
      </div>
      {/* /founding, not /pricing: a gym on the comped founding trial is a
          founding gym and is owed the founding price. /founding sends them on
          to /pricing by itself if the program is no longer open. */}
      <Link
        href="/founding"
        className="shrink-0 rounded-lg font-semibold px-6 py-3 text-sm text-center"
        style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
      >
        Choose a plan
      </Link>
    </div>
  );
}
