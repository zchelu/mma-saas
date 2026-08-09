"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserButton } from "@clerk/nextjs";
import { Logo } from "./logo";

// "/invoices" is deliberately ABSENT from this nav — do not restore it.
//
// convex/invoices.ts is a manual ledger: an owner types an amount and a due
// date, then toggles status paid/unpaid by hand. No processor, no payment
// link, no reconciliation. Shipping it in the nav puts an "Invoices" tab in
// front of a gym owner on a demo call who clicks it expecting billing and
// finds a spreadsheet he has to maintain himself — a promise the product
// makes and does not keep, on the screen a skeptical buyer pokes at first.
//
// The route, the schema table and the data are all intentionally left intact
// and untouched. This is a one-line hide, not a teardown, because Stripe
// Connect member billing revives this exact surface — see the project doc
// claude/spec-connect-member-billing-v1.md. Restore this entry in the same
// change that makes the tab able to take a payment, and not before.
const links = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/members", label: "Members" },
  { href: "/classes", label: "Classes" },
  { href: "/billing", label: "Billing" },
];

export default function AppHeader() {
  const pathname = usePathname();

  return (
    <header className="flex items-center justify-between px-8 py-4" style={{ backgroundColor: "#1A1A1A", borderBottom: "1px solid #333333" }}>
      <div className="flex items-center gap-8">
        <Logo href="/dashboard" height={24} />
        <nav className="flex gap-1">
          {links.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              prefetch={false}
              className="text-sm px-3 py-1.5 rounded-lg transition-colors"
              style={
                pathname === href
                  ? { backgroundColor: "#222222", color: "#FFFFFF" }
                  : { color: "#888888" }
              }
            >
              {label}
            </Link>
          ))}
        </nav>
      </div>
      <UserButton />
    </header>
  );
}
