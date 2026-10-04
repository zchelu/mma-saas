import Link from "next/link";
import type { PRICING_TIERS } from "./tiers";

// The one tier card, shared by /pricing and /founding so the two pages cannot
// drift apart. /founding is meant to be /pricing's cards and nothing else, at
// different prices — a second hand-copied card component is exactly how the
// founding page would end up with last month's perks or badge.
//
// Lives outside page.tsx for the same reason tiers.ts does: this version of
// Next.js rejects any export from a page file that isn't a page export.
export function TierCard({
  tier,
  href,
  ctaLabel,
  foundingPrice,
}: {
  tier: (typeof PRICING_TIERS)[number];
  href: string;
  ctaLabel: string;
  // Set only on /founding. The card then shows the list price crossed out
  // and faded, this price big and bold beside it, and says what the price is. Passed in
  // rather than read here because the number comes off the Stripe coupon
  // (app/founding/page.tsx), never from a constant on this side.
  foundingPrice?: number;
}) {
  const badge = "badge" in tier ? tier.badge : undefined;
  const highlighted = "highlighted" in tier && tier.highlighted;
  const roiLine = "roiLine" in tier ? tier.roiLine : undefined;
  const isFounding = foundingPrice !== undefined;

  return (
    <div
      className="rounded-xl p-8 flex flex-col text-left relative"
      style={{
        backgroundColor: "#222222",
        border: highlighted ? "2px solid #FF3B3B" : "1px solid #333333",
      }}
    >
      {badge && (
        <span
          className="absolute -top-3 left-1/2 -translate-x-1/2 text-xs font-bold tracking-widest uppercase px-3 py-1 rounded-full whitespace-nowrap"
          style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
        >
          {badge}
        </span>
      )}
      <p className="text-xs font-semibold tracking-widest uppercase mb-2" style={{ color: "#E02020" }}>
        {tier.name}
      </p>
      <p className="text-sm mb-5" style={{ color: "#888888" }}>
        {tier.size}
      </p>

      {/* On /founding the list price comes FIRST, struck through and faded
          almost out, and the founding price lands after it bigger and bolder
          than the list price ever is on /pricing: "was $99, now $50" read left
          to right. The faded number is still the anchor — it is what makes
          $50 read as a deal rather than as a cheap product — so it stays
          legible, just clearly dead. */}
      {/* flex-wrap, and the price is grouped with its "/mo": on a narrow card
          (three columns start at 640px, so an iPad held upright) the crossed-out
          price and the founding price do not fit on one line. Without the wrap
          the row ran out past the card's edge — measured at 768px on
          2026-10-04, Fight Team 248px of content in a 215px card. Wrapped, the
          list price sits on its own line above and the founding price drops
          below it, still "was, now". */}
      <div className={`flex flex-wrap items-baseline gap-x-1 ${isFounding ? "mb-2" : "mb-6"}`}>
        {isFounding && (
          <span
            className="text-2xl font-semibold line-through mr-2"
            style={{ color: "#555555", textDecorationThickness: "2px" }}
          >
            {`$${tier.price}`}
          </span>
        )}
        <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
          <span
            className={isFounding ? "text-5xl sm:text-4xl md:text-5xl font-black" : "text-4xl font-extrabold"}
            style={{ color: "#FFFFFF" }}
          >
            {`$${isFounding ? foundingPrice : tier.price}`}
          </span>
          <span className="text-sm" style={{ color: "#888888" }}>
            /mo
          </span>
        </span>
      </div>

      {isFounding && (
        <p className="text-xs font-semibold tracking-wide uppercase mb-6" style={{ color: "#E02020" }}>
          Founding price. Locked for life.
        </p>
      )}

      {roiLine && (
        <p className="text-sm leading-relaxed mb-6" style={{ color: "#CCCCCC" }}>
          {roiLine}
        </p>
      )}

      {tier.perks.length > 0 && (
        <ul className="flex flex-col gap-3 mb-6">
          {tier.perks.map((perk) => (
            <li key={perk} className="flex items-start gap-2 text-sm leading-snug" style={{ color: "#CCCCCC" }}>
              <span className="font-bold flex-shrink-0" style={{ color: "#E02020" }}>
                +
              </span>
              {perk}
            </li>
          ))}
        </ul>
      )}

      <Link
        href={href}
        className="mt-auto rounded-lg font-semibold px-6 py-3 text-sm text-center transition-colors"
        style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
      >
        {ctaLabel}
      </Link>
    </div>
  );
}
