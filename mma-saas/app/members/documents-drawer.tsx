"use client";
import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";

// The member's Documents tab — every document this member has signed, and
// what they actually signed.
//
// Everything shown here comes from signedDocuments.renderedContent, the copy
// frozen at signing time. It is deliberately NOT re-rendered from the current
// template: if the owner edited the waiver last week, this must still show
// what was on the tablet when the member put their finger on it. That is the
// entire evidentiary value of the record.
//
// Same drawer shape as check-in-history-drawer.tsx, wider because a waiver is
// a wall of text.

type Props = {
  memberId: Id<"members">;
  memberName: string;
  onClose: () => void;
};

type SignedDoc = {
  _id: Id<"signedDocuments">;
  title: string;
  isWaiver: boolean;
  renderedContent: string;
  signatureData: string;
  signerName: string;
  guardianName?: string;
  guardianSignatureData?: string;
  signedAt: number;
};

function formatSignedAt(timestamp: number): string {
  const d = new Date(timestamp);
  return (
    d.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    }) +
    " at " +
    d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
  );
}

export default function DocumentsDrawer({ memberId, memberName, onClose }: Props) {
  const documents = useQuery(api.documents.listSignedDocuments, { memberId });
  const [viewing, setViewing] = useState<SignedDoc | null>(null);

  const list = (documents ?? []) as SignedDoc[];

  return (
    <>
      <div
        className="fixed inset-0 z-40"
        style={{ backgroundColor: "rgba(0,0,0,0.6)" }}
        onClick={onClose}
      />
      <div
        className="fixed right-0 top-0 h-full z-50 flex flex-col"
        style={{ width: 420, backgroundColor: "#111111", borderLeft: "1px solid #333333" }}
      >
        <div
          className="flex items-center justify-between px-6 py-5"
          style={{ borderBottom: "1px solid #333333" }}
        >
          <div>
            <p className="text-xs uppercase tracking-widest mb-1" style={{ color: "#555555" }}>
              Documents
            </p>
            <h2 className="text-lg font-semibold" style={{ color: "#FFFFFF" }}>
              {memberName}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors text-sm"
            style={{ color: "#888888", backgroundColor: "#1A1A1A" }}
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {documents === undefined ? (
            <p className="text-sm" style={{ color: "#555555" }}>
              Loading…
            </p>
          ) : list.length === 0 ? (
            <p className="text-sm" style={{ color: "#555555" }}>
              Nothing signed yet. {memberName.trim().split(/\s+/)[0]} will be asked to sign at
              the kiosk on their next check-in.
            </p>
          ) : (
            <ul className="space-y-3">
              {list.map((doc) => (
                <li key={doc._id}>
                  <button
                    onClick={() => setViewing(doc)}
                    className="w-full text-left py-4 px-4 rounded-lg transition-colors"
                    style={{
                      backgroundColor: "#1A1A1A",
                      borderLeft: `3px solid ${doc.isWaiver ? "#E02020" : "#555555"}`,
                    }}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium" style={{ color: "#FFFFFF" }}>
                        {doc.title}
                      </span>
                      {doc.guardianName && (
                        <span
                          className="text-xs px-2 py-0.5 rounded-full font-semibold"
                          style={{ backgroundColor: "#2A1F0A", color: "#FBBF24" }}
                        >
                          Guardian signed
                        </span>
                      )}
                    </div>
                    <p className="text-xs mt-1.5" style={{ color: "#888888" }}>
                      {formatSignedAt(doc.signedAt)}
                    </p>
                    <p className="text-xs mt-0.5" style={{ color: "#555555" }}>
                      Signed by {doc.signerName}
                      {doc.guardianName ? ` · guardian ${doc.guardianName}` : ""}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {viewing && <ViewModal doc={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}

function ViewModal({ doc, onClose }: { doc: SignedDoc; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center px-4"
      style={{ backgroundColor: "rgba(0,0,0,0.8)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-xl max-h-[90vh] flex flex-col"
        style={{ backgroundColor: "#222222", border: "1px solid #333333" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-start justify-between gap-4 px-8 py-6"
          style={{ borderBottom: "1px solid #333333" }}
        >
          <div>
            <h3 className="text-lg font-semibold" style={{ color: "#FFFFFF" }}>
              {doc.title}
            </h3>
            <p className="text-xs mt-1" style={{ color: "#888888" }}>
              Signed {formatSignedAt(doc.signedAt)}
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg shrink-0 text-sm"
            style={{ color: "#888888", backgroundColor: "#1A1A1A" }}
          >
            ✕
          </button>
        </div>

        <div className="overflow-y-auto px-8 py-6 flex flex-col gap-6">
          {/* The frozen copy. Plain text, never HTML — the source is
              gym-supplied content and rendering it as markup would make an
              owner's waiver an injection vector on their own dashboard. */}
          <div
            className="rounded-lg px-5 py-5"
            style={{
              backgroundColor: "#FFFFFF",
              color: "#1A1A1A",
              whiteSpace: "pre-wrap",
              lineHeight: 1.7,
              fontSize: "0.9rem",
            }}
          >
            {doc.renderedContent}
          </div>

          <SignatureBlock
            label="Signature"
            name={doc.signerName}
            dataUrl={doc.signatureData}
          />

          {doc.guardianName && doc.guardianSignatureData && (
            <SignatureBlock
              label="Parent / guardian signature"
              name={doc.guardianName}
              dataUrl={doc.guardianSignatureData}
              accent="#FBBF24"
            />
          )}

          <p className="text-xs" style={{ color: "#555555" }}>
            This is the document exactly as it appeared when it was signed. Editing the
            template afterwards does not change it.
          </p>
        </div>
      </div>
    </div>
  );
}

function SignatureBlock({
  label,
  name,
  dataUrl,
  accent = "#888888",
}: {
  label: string;
  name: string;
  dataUrl: string;
  accent?: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs uppercase tracking-widest" style={{ color: accent }}>
        {label}
      </p>
      <div
        className="rounded-lg px-4 py-3"
        style={{ backgroundColor: "#FFFFFF", border: "1px solid #333333" }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- a base64 data
            URL, not a remote asset; next/image would add no optimisation and
            cannot handle a data URL of unknown intrinsic size. */}
        <img src={dataUrl} alt={`${label} of ${name}`} style={{ width: "100%", maxWidth: 420 }} />
      </div>
      <p className="text-xs" style={{ color: "#888888" }}>
        {name}
      </p>
    </div>
  );
}
