"use client";
import { useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { ErrorToast, getErrorMessage } from "../../components/error-toast";
import {
  PLACEHOLDER_DESCRIPTIONS,
  PLACEHOLDER_KEYS,
  placeholdersUsed,
} from "@/lib/documents";
import {
  firstBlankRange,
  STARTER_LIBRARY,
  STARTER_NOTICE,
  unfilledBlanks,
  type StarterDocument,
} from "@/lib/documentStarters";

// `starter`, on either mode, opens the editor with that starter template
// already loaded — the library cards on the settings page use it. In edit mode
// it REPLACES the text shown for an existing document (how a gym swaps its
// waiver for the starter one), and like every other edit nothing is written
// until the owner presses Save.
export type TemplateDraft =
  | {
      mode: "create";
      isWaiver: boolean;
      requiresGuardianForMinors: boolean;
      starter?: StarterDocument;
    }
  | {
      mode: "edit";
      starter?: StarterDocument;
      template: {
        _id: Id<"documentTemplates">;
        title: string;
        content: string;
        isWaiver: boolean;
        requiresGuardianForMinors: boolean;
        requiredAtSignup: boolean;
      };
    };

// The editor. The owner pastes their own text or loads a starter template and
// edits it; either way what they save is THEIR document. See the header of
// lib/documentStarters.ts for what a starter is and is not.
//
// A plain textarea, on purpose — a rich-text editor would mean
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

  const initialStarter = draft.starter ?? null;

  const [title, setTitle] = useState(
    initialStarter
      ? initialStarter.title
      : draft.mode === "edit"
        ? draft.template.title
        : isWaiver
          ? "Liability Waiver"
          : ""
  );
  const [content, setContent] = useState(
    initialStarter ? initialStarter.content : draft.mode === "edit" ? draft.template.content : ""
  );
  // Which starter the text in the editor came from, if any. Drives the notice
  // and the "check these before members sign" list; it is display state only
  // and is never sent to the server.
  const [loadedStarter, setLoadedStarter] = useState<StarterDocument | null>(initialStarter);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Defaults to isWaiver, NOT to true. The waiver gates the door by definition
  // (and its toggle isn't offered — createTemplate/updateTemplate force it
  // server-side so an owner can't switch the gate off). Anything else defaults
  // to NOT blocking: a pre-ticked box would mean an owner adding a photo
  // release quietly makes it mandatory at check-in, which is the exact failure
  // convex/documents.ts:isRequired exists to prevent.
  //
  // A starter never overrides that in edit mode: the owner already decided
  // whether this document stops people at the door.
  const [requiredAtSignup, setRequiredAtSignup] = useState(
    draft.mode === "edit"
      ? draft.template.requiredAtSignup
      : initialStarter
        ? initialStarter.requiredAtSignup || isWaiver
        : isWaiver
  );
  const [requiresGuardian, setRequiresGuardian] = useState(
    initialStarter
      ? initialStarter.requiresGuardianForMinors
      : draft.mode === "edit"
        ? draft.template.requiresGuardianForMinors
        : draft.requiresGuardianForMinors
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const used = placeholdersUsed(content);
  // [FILL IN: ...] blanks the owner hasn't answered yet. Save stays disabled
  // while any remain; convex/documents.ts refuses them too.
  const blanks = unfilledBlanks(content);
  // isWaiver is fixed for this editor (see above), so only starters of the
  // same kind can be loaded into it — the waiver starter into the waiver, the
  // rest into an ordinary document.
  const availableStarters = STARTER_LIBRARY.filter((s) => s.isWaiver === isWaiver);

  function loadStarter(starter: StarterDocument) {
    const hasOwnText = content.trim().length > 0 && content !== starter.content;
    if (
      hasOwnText &&
      !confirm(
        `Replace the text in the editor with the "${starter.title}" template? Nothing is saved until you press Save.`
      )
    ) {
      return;
    }
    setTitle(starter.title);
    setContent(starter.content);
    setRequiresGuardian(starter.requiresGuardianForMinors);
    if (draft.mode === "create") setRequiredAtSignup(starter.requiredAtSignup || isWaiver);
    setLoadedStarter(starter);
    setError(null);
  }

  // Select the next blank in the textarea so typing replaces it. The scroll is
  // set by hand: focusing a textarea with a selection far down the text does
  // not reliably bring it into view.
  function jumpToNextBlank() {
    const el = textareaRef.current;
    const range = firstBlankRange(content);
    if (!el || !range) return;
    el.focus();
    el.setSelectionRange(range.start, range.end);
    const ratio = content.length > 0 ? range.start / content.length : 0;
    el.scrollTop = Math.max(0, ratio * el.scrollHeight - el.clientHeight / 2);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (blanks.length > 0) {
      jumpToNextBlank();
      return;
    }
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
          Paste your own text, or start from a template and make it yours. KombatDesk
          records the signature — it doesn&apos;t give legal advice.
        </p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          {availableStarters.length > 0 && (
            <div
              className="rounded-lg p-4"
              style={{ backgroundColor: "#1A1A1A", border: "1px solid #333333" }}
            >
              <p className="text-xs uppercase tracking-wider mb-3" style={{ color: "#555555" }}>
                Start from a template
              </p>
              <div className="flex flex-wrap gap-2">
                {availableStarters.map((s) => {
                  const active = loadedStarter?.key === s.key;
                  return (
                    <button
                      key={s.key}
                      type="button"
                      onClick={() => loadStarter(s)}
                      title={s.summary}
                      className="rounded-md px-3 py-1.5 text-xs font-semibold transition-colors"
                      style={{
                        backgroundColor: active ? "#2A0A0A" : "#222222",
                        border: `1px solid ${active ? "#E02020" : "#333333"}`,
                        color: active ? "#E02020" : "#CCCCCC",
                      }}
                    >
                      {s.title}
                    </button>
                  );
                })}
              </div>
              {loadedStarter && (
                <div className="mt-4">
                  <p className="text-xs" style={{ color: "#FBBF24" }}>
                    {STARTER_NOTICE}
                  </p>
                  <ul className="mt-2 flex flex-col gap-1">
                    {loadedStarter.reviewNotes.map((note) => (
                      <li key={note} className="text-xs" style={{ color: "#888888" }}>
                        • {note}
                      </li>
                    ))}
                  </ul>
                  {/* Signed-ness is keyed on the template row, not on its text
                      (there is no template versioning — see signDocument's
                      one-per-member-per-document rule). So replacing an
                      existing document's text never re-asks anyone. For a typo
                      that is the point; for swapping a waiver for a whole
                      membership contract it means the existing roster has not
                      agreed to the new terms, and the owner has to be told. */}
                  {draft.mode === "edit" && (
                    <p className="text-xs mt-3" style={{ color: "#FBBF24" }}>
                      Heads up: members who already signed this document won&apos;t be asked to
                      sign the new text. Their signed copies keep the old wording.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

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
              ref={textareaRef}
              required
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={16}
              className="input font-mono"
              style={{ lineHeight: 1.6, resize: "vertical" }}
              placeholder="Paste the document you already use, or pick a template above and edit it."
            />
          </div>

          {/* A starter's blanks are the gym's own terms — how to cancel, how
              long a freeze lasts — which nobody but the owner can supply. A
              member must never be shown "[FILL IN: ...]" on the tablet, so the
              document can't be saved while one remains. */}
          {blanks.length > 0 && (
            <div
              className="rounded-lg p-4"
              style={{ backgroundColor: "#2A1F0A", border: "1px solid #FBBF24" }}
            >
              <div className="flex items-start justify-between gap-4">
                <p className="text-sm" style={{ color: "#FBBF24" }}>
                  {blanks.length === 1
                    ? "1 blank to fill in before you can save."
                    : `${blanks.length} blanks to fill in before you can save.`}
                </p>
                <button
                  type="button"
                  onClick={jumpToNextBlank}
                  className="rounded-md px-3 py-1.5 text-xs font-semibold shrink-0"
                  style={{ backgroundColor: "#FBBF24", color: "#0D0D0D" }}
                >
                  Go to next blank
                </button>
              </div>
              <ul className="mt-2 flex flex-col gap-1">
                {blanks.map((label) => (
                  <li key={label} className="text-xs" style={{ color: "#FBBF24" }}>
                    • {label}
                  </li>
                ))}
              </ul>
              <p className="text-xs mt-2" style={{ color: "#888888" }}>
                Replace each [FILL IN: …] in the text with your own terms, brackets and all.
              </p>
            </div>
          )}

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
              disabled={saving || blanks.length > 0}
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
