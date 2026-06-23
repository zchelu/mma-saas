"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserButton } from "@clerk/nextjs";

const links = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/members", label: "Members" },
  { href: "/classes", label: "Classes" },
  { href: "/invoices", label: "Invoices" },
];

export default function AppHeader() {
  const pathname = usePathname();

  return (
    <header className="flex items-center justify-between px-8 py-4" style={{ backgroundColor: "#1A1A1A", borderBottom: "1px solid #333333" }}>
      <div className="flex items-center gap-8">
        <span className="text-xl font-bold tracking-tight" style={{ color: "#E02020" }}>KombatDesk</span>
        <nav className="flex gap-1">
          {links.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
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
