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
    <header className="flex items-center justify-between px-8 py-4 border-b border-zinc-800">
      <div className="flex items-center gap-8">
        <span className="text-xl font-bold tracking-tight">MatFlow</span>
        <nav className="flex gap-1">
          {links.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              className={`text-sm px-3 py-1.5 rounded-lg transition-colors ${
                pathname === href
                  ? "bg-zinc-800 text-white"
                  : "text-zinc-400 hover:text-white"
              }`}
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
