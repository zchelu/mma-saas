// Rendered by Next.js when page.tsx calls notFound() (unknown/malformed
// gymSlug) — gives a real 404 HTTP status while still showing copy written
// for a gym member who mistyped or followed a stale link, not a generic
// framework 404 page. Wording/styling carried over unchanged from what used
// to be page.tsx's inline "Link not found" branch.
export default function ConsentNotFound() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center text-center px-8" style={{ backgroundColor: "#0D0D0D" }}>
      <h1 className="text-2xl font-bold mb-3" style={{ color: "#FFFFFF" }}>Link not found</h1>
      <p className="text-base max-w-sm" style={{ color: "#888888" }}>
        This consent link isn&apos;t valid anymore. Contact your gym for a new one.
      </p>
    </div>
  );
}
