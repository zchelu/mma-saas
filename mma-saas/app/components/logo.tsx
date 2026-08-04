import Link from "next/link";

/**
 * The KombatDesk lockup.
 *
 * The wordmark inside the SVG is outlined vector paths, not live text, so it
 * renders identically everywhere without loading Anton at runtime. Do not
 * "fix" that by swapping in a webfont — the whole point is that the logo has
 * no font dependency.
 *
 * Deliberately a plain <img>, not next/image: the asset is a static SVG in
 * /public, next/image does not optimize SVG anyway, and its wrapper element
 * fights the fixed-height flex headers this sits in.
 *
 * `dark` = light type on a dark background (every surface we currently ship).
 * `light` is for anything on white — invoices, print, a future light theme.
 */

// Must match the viewBox in public/kombatdesk-lockup-*.svg, which is
// "0 0 1735 300". The generator's exact width is 1734.703: brand/source/build.py
// writes the viewBox rounded (1735) but used to *print* it truncated (1734), and
// this constant was originally copied off that console line. Read the SVG, not
// the build log.
const RATIO = 1735 / 300;

export function Logo({
  variant = "dark",
  height = 28,
  href = "/",
}: {
  variant?: "dark" | "light";
  height?: number;
  /** Pass null to render the mark without wrapping it in a link. */
  href?: string | null;
}) {
  const img = (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/kombatdesk-lockup-${variant}.svg`}
      alt="KombatDesk"
      width={Math.round(height * RATIO)}
      height={height}
      style={{ height, width: "auto", display: "block" }}
    />
  );

  if (href === null) return img;

  return (
    <Link
      href={href}
      prefetch={false}
      aria-label="KombatDesk home"
      className="shrink-0"
    >
      {img}
    </Link>
  );
}
