"use client";
import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { ErrorToast, getErrorMessage } from "../../components/error-toast";
import {
  PLACEHOLDER_DESCRIPTIONS,
  PLACEHOLDER_KEYS,
  placeholdersUsed,
} from "@/lib/documents";

export type TemplateDraft =
  | { mode: "create"; isWaiver: boolean; requiresGuardianForMinors: boolean }
  | {
      mode: "edit";
      template: {
        _id: Id<"documentTemplates">;
        title: string;
        content: string;
        isWaiver: boolean;
        requiresGuardianForMinors: boolean;
        requiredAtSignup: boolean;
      };
    };

// The editor. A plain textarea, on purpose — a rich-text editor would mean
// storing markup, and the signing screen renders the owner's text as plain
// text so gym-supplied content can never inject anything into the page a
// member signs on.
//
// isWaiver is fixed at creation and NOT editable here, matching
// convex/documents.ts:updateTemplate. Flipping it would change what gates
// check-in for the whole roster, and demoting the waiver would be a way
// around the delete block.

export default function TemplateModal({
  draft,
  onClose,
}: {
  draft: TemplateDraft;
  onClose: () => void;
}) {
  const create = useMutation(api.documents.createTemplate);
  const update = useMutation(api.documents.updateTemplate);

  const isWaiver = draft.mode === "create" ? draft.isWaiver : draft.template.isWaiver;

  const [title, setTitle] = useState(
    draft.mode === "edit" ? draft.template.title : isWaiver ? "Liability Waiver" : ""
  );
  const [content, setContent] = useState(draft.mode === "edit" ? draft.template.content : "");
  // Defaults to isWaiver, NOT to true. The waiver gates the door by definition
  // (and its toggle isn't offered — createTemplate/updateTemplate force it
  // server-side so an owner can't switch the gate off). Anything else defaults
  // to NOT blocking: a pre-ticked box would mean an owner adding a photo
  // release quietly makes it mandatory at check-in, which is the exact failure
  // convex/documents.ts:isRequired exists to prevent.
  const [requiredAtSignup, setRequiredAtSignup] = useState(
    draft.mode === "edit" ? draft.template.requiredAtSignup : isWaiver
  );
  const [requiresGuardian, setRequiresGuardian] = useState(
    draft.mode === "edit"
      ? draft.template.requiresGuardianForMinors
      : draft.requiresGuardianForMinors
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const used = placeholdersUsed(content);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (draft.mode === "edit") {
        await update({
          templateId: draft.template._id,
          title,
          content,
          requiresGuardianForMinors: requiresGuardian,
          requiredAtSignup,
        });
      } else {
        await create({
          title,
          content,
          isWaiver: draft.isWaiver,
          requiresGuardianForMinors: requiresGuardian,
          requiredAtSignup,
        });
      }
      onClose();
    } catch (err) {
      setError(getErrorMessage(err, "Couldn't save that document — try refreshing the page."));
      setSaving(false);
    }
  }

  function insertPlaceholder(key: string) {
    setContent((c) => `${c}{{${key}}}`);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ backgroundColor: "rgba(0,0,0,0.75)" }}
    >
      <div
        className="w-full max-w-3xl rounded-xl p-8 max-h-[92vh] overflow-y-auto"
        style={{ backgroundColor: "#222222", border: "1px solid #333333" }}
      >
        <h2 className="text-xl mb-1" style={{ color: "#FFFFFF", fontWeight: 500 }}>
          {draft.mode === "edit" ? "Edit Document" : isWaiver ? "Add Your Waiver" : "Add Document"}
        </h2>
        <p className="text-xs mb-6" style={{ color: "#555555" }}>
          Paste your own text. KombatDesk doesn&apos;t write or review legal language — we
          record the signature.
        </p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <label className="text-xs uppercase tracking-wider" style={{ color: "#555555" }}>
              Title
            </label>
            <input
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="input"
              placeholder="Liability Waiver"
            />
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between">
              <label className="text-xs uppercase tracking-wider" style={{ color: "#555555" }}>
                Document text
              </label>
              <span className="text-xs" style={{ color: "#555555" }}>
                {content.length.toLocaleString()} characters
              </span>
            </div>
            <textarea
              required
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={16}
              className="input font-mono"
              style={{ lineHeight: 1.6, resize: "vertical" }}
              placeholder="Paste the waiver your attorney approved. Don't have one? Bring us the paper version you already use and we'll load it for you."
            />
          </div>

          {/* THE VISIBLE PLACEHOLDER REFERENCE. Generated from
              lib/documents.ts:PLACEHOLDER_KEYS, which is the same list the
              resolver uses — so this can't drift into advertising a
              placeholder that doesn't resolve, which would print a literal
              {{token}} into a signed legal document. */}
          <div
            className="rounded-lg p-4"
            style={{ backgroundColor: "#1A1A1A", border: "1px solid #333333" }}
          >
            <p className="text-xs uppercase tracking-wider mb-3" style={{ color: "#555555" }}>
              Placeholders · tap to insert
            </p>
            <div className="flex flex-col gap-2">
              {PLACEHOLDER_KEYS.map((key) => (
                <div key={key} className="flex items-center gap-3 flex-wrap">
                  <button
                    type="button"
                    onClick={() => insertPlaceholder(key)}
                    className="rounded-md px-2 py-1 font-mono text-xs transition-colors"
                    style={{
                      backgroundColor: used.includes(key) ? "#2A0A0A" : "#222222",
                      border: `1px solid ${used.includes(key) ? "#E02020" : "#333333"}`,
                      color: used.includes(key) ? "#E02020" : "#CCCCCC",
                    }}
                  >
                    {`{{${key}}}`}
                  </button>
                  <span className="text-xs" style={{ color: "#555555" }}>
                    {PLACEHOLDER_DESCRIPTIONS[key]}
                  </span>
                </div>
              ))}
            </div>
            <p className="text-xs mt-3" style={{ color: "#555555" }}>
              These fill in when the member signs, and the filled-in version is what gets
              stored. Editing this text later never changes a document someone already signed.
            </p>
          </div>

          {!isWaiver && (
            <label
              className="flex items-start gap-3 rounded-lg p-4 cursor-pointer"
              style={{ backgroundColor: "#1A1A1A", border: "1px solid #333333" }}
            >
              <input
                type="checkbox"
                checked={requiredAtSignup}
                onChange={(e) => setRequiredAtSignup(e.target.checked)}
                className="mt-0.5 shrink-0"
                style={{ accentColor: "#E02020" }}
              />
              <span className="text-sm" style={{ color: "#CCCCCC" }}>
                Members must sign this before they can check in.
                <span className="block text-xs mt-1" style={{ color: "#555555" }}>
                  Leave this off and the document is still collected when a new member
                  signs up — it just won&apos;t stop anyone at the door.
                </span>
              </span>
            </label>
          )}

          <label
            className="flex items-start gap-3 rounded-lg p-4 cursor-pointer"
            style={{ backgroundColor: "#1A1A1A", border: "1px solid #333333" }}
          >
            <input
              type="checkbox"
              checked={requiresGuardian}
              onChange={(e) => setRequiresGuardian(e.target.checked)}
              className="mt-0.5 shrink-0"
              style={{ accentColor: "#E02020" }}
            />
            <span className="text-sm" style={{ color: "#CCCCCC" }}>
              A parent or guardian must also sign for minors.
              <span className="block text-xs mt-1" style={{ color: "#555555" }}>
                With this on, a member under your minor age can&apos;t complete this document
                without a second signature — and we&apos;ll ask for their date of birth first
                if we don&apos;t have it.
              </span>
            </span>
          </label>

          {isWaiver && (
            <p className="text-xs" style={{ color: "#555555" }}>
              This is your waiver. It always has to be signed before check-in, and it
              can&apos;t be deleted — edit the text here instead.
            </p>
          )}

          {error && <ErrorToast message={error} />}

          <div className="flex gap-3 mt-2">
            <button
              type="submit"
              disabled={saving}
              className="flex-1 rounded-lg font-semibold py-2 transition-colors disabled:opacity-50"
              style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
            >
              {saving ? "Saving…" : draft.mode === "edit" ? "Save Changes" : "Add Document"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-lg font-semibold py-2 transition-colors"
              style={{ backgroundColor: "#1A1A1A", color: "#FFFFFF", border: "0.5px solid #333333" }}
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
