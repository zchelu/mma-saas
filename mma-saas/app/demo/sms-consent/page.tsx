import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "SMS Consent Preview | KombatDesk",
  description: "Preview of KombatDesk's SMS consent checkbox as shown in the Add Member form.",
};

export default function SmsConsentPreviewPage() {
  return (
    <div
      className="min-h-screen flex items-center justify-center px-4"
      style={{ backgroundColor: "#0D0D0D" }}
    >
      <div className="w-full max-w-md">
        <p className="text-xs mb-3 uppercase tracking-wider" style={{ color: "#666666" }}>
          Preview only — static reference, not a live form
        </p>
        <div className="rounded-xl p-8" style={{ backgroundColor: "#222222", border: "1px solid #333333" }}>
          <h2 className="text-xl mb-6" style={{ color: "#FFFFFF", fontWeight: 500 }}>
            Add Member
          </h2>
          <div className="flex flex-col gap-1.5 rounded-lg p-3" style={{ backgroundColor: "#1A1A1A", border: "0.5px solid #333333" }}>
            <label className="flex items-start gap-2 text-sm" style={{ color: "#CCCCCC" }}>
              <input
                type="checkbox"
                disabled
                className="mt-0.5 shrink-0"
                style={{ accentColor: "#E02020" }}
              />
              <span>
                I confirm this member has consented to receive text messages regarding
                their membership and attendance, per KombatDesk&apos;s{" "}
                <a
                  href="/terms#sms"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                  style={{ color: "#CCCCCC" }}
                >
                  Terms of Service
                </a>
                .
              </span>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}
