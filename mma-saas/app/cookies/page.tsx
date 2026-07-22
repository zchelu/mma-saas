import type { Metadata } from "next";
import { LegalPage } from "@/app/components/legal-page";
import { readLegalContent } from "@/app/lib/legal-content";

export const metadata: Metadata = {
  title: "Cookie Policy | KombatDesk",
  description: "KombatDesk's Cookie Policy.",
};

export default function CookiesPage() {
  return <LegalPage html={readLegalContent("cookie-policy.html")} />;
}
