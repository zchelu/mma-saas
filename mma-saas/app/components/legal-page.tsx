import Link from "next/link";

export function LegalPage({ html }: { html: string }) {
  return (
    <div className="min-h-screen px-6 py-12" style={{ backgroundColor: "#0D0D0D" }}>
      <div className="w-full max-w-[720px] mx-auto">
        <Link href="/" className="text-sm underline transition-colors hover:text-white" style={{ color: "#888888" }}>
          &larr; Back to KombatDesk
        </Link>

        <div className="legal-content mt-6" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}
