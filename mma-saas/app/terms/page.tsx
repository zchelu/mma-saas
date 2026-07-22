import type { Metadata } from "next";
import { LegalPage } from "@/app/components/legal-page";
import { readLegalContent } from "@/app/lib/legal-content";

export const metadata: Metadata = {
  title: "Terms of Service | KombatDesk",
  description: "KombatDesk's Terms of Service.",
};

export default function TermsPage() {
  return <LegalPage html={readLegalContent("terms.html")} />;
}
