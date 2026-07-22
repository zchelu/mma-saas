import Link from "next/link";

export function Footer() {
  return (
    <footer
      className="flex flex-col sm:flex-row items-center justify-center gap-2 sm:gap-4 px-8 py-5 text-center text-xs"
      style={{ borderTop: "1px solid #333333", color: "#555555" }}
    >
      <span>© {new Date().getFullYear()} KombatDesk LLC. All rights reserved.</span>
      <span className="flex items-center gap-2">
        <Link href="/terms" className="transition-colors hover:text-white" style={{ color: "#555555" }}>
          Terms
        </Link>
        <span aria-hidden="true">·</span>
        <Link href="/privacy" className="transition-colors hover:text-white" style={{ color: "#555555" }}>
          Privacy
        </Link>
        <span aria-hidden="true">·</span>
        <Link href="/cookies" className="transition-colors hover:text-white" style={{ color: "#555555" }}>
          Cookies
        </Link>
      </span>
    </footer>
  );
}
