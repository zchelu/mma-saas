"use client";
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import AppHeader from "../../components/app-header";
import { ErrorToast, getErrorMessage } from "../../components/error-toast";
import TemplateModal, { type TemplateDraft } from "./template-modal";

// Owner-facing document management. The gym pastes in their own waiver text;
// KombatDesk supplies the signing rail and never the legal language. Nothing
// on this screen offers to write, suggest or "improve" a waiver, and nothing
// added to it should.

type Template = {
  _id: Id<"documentTemplates">;
  title: string;
  content: string;
  isWaiver: boolean;
  requiresGuardianForMinors: boolean;
  requiredAtSignup: boolean;
  createdAt: number;
};

export default function DocumentsSettingsPage() {
  const templates = useQuery(api.documents.listTemplates);
  const settings = useQuery(api.documents.getDocumentSettings);
  const unsignedCount = useQuery(api.documents.getUnsignedWaiverCount);
  const deleteTemplate = useMutation(api.documents.deleteTemplate);
  const setThreshold = useMutation(api.documents.setMinorAgeThreshold);

  const [modal, setModal] = useState<null | TemplateDraft>(null);
  const [error, setError] = useState<string | null>(null);

  const list = (templates ?? []) as Template[];
  const waiver = list.find((t) => t.isWaiver);

  async function handleDelete(t: Template) {
    if (!confirm(`Delete "${t.title}"? Documents members already signed are kept.`)) return;
    setError(null);
    try {
      await deleteTemplate({ templateId: t._id });
    } catch (err) {
      setError(getErrorMessage(err, "Couldn't delete that document — try refreshing the page."));
    }
  }

  async function handleThresholdChange(value: string) {
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    setError(null);
    try {
      await setThreshold({ minorAgeThreshold: n });
    } catch (err) {
      setError(getErrorMessage(err, "Couldn't save that — try refreshing the page."));
    }
  }

  return (
    <div className="min-h-screen text-white" style={{ backgroundColor: "#0D0D0D" }}>
      <AppHeader />
      <main className="max-w-5xl mx-auto px-8 py-12">
        <div className="flex items-start justify-between gap-6 mb-2">
          <div>
            <h1 className="text-3xl" style={{ color: "#FFFFFF", fontWeight: 500 }}>
              Documents & Waivers
            </h1>
            <p className="text-sm mt-2 max-w-xl" style={{ color: "#888888" }}>
              Your waiver, in your words. Members sign it on the tablet at the door — and
              anyone who hasn&apos;t signed is stopped at check-in until they do. Other
              documents are collected when a new member signs up; mark one
              &ldquo;required&rdquo; and it stops people at the door too.
            </p>
          </div>
          <button
            onClick={() =>
              setModal({
              mode: "create",
              isWaiver: !waiver,
              requiresGuardianForMinors: true,
            })
            }
            className="rounded-lg text-sm font-semibold px-4 py-2 transition-colors shrink-0"
            style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "#B91C1C")}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "#E02020")}
          >
            {waiver ? "+ Add Document" : "+ Add Your Waiver"}
          </button>
        </div>

        {error && <div className="my-6"><ErrorToast message={error} /></div>}

        {/* The number that tells an owner whether this feature is actually
            doing anything. Null means nothing is marked required yet, which is
            a different state from "everyone has signed" and must not render as
            a reassuring zero. */}
        {typeof unsignedCount === "number" && unsignedCount > 0 && (
          <div
            className="rounded-xl px-5 py-4 mt-6 flex items-center gap-3"
            style={{ backgroundColor: "#2A1F0A", border: "1px solid #FBBF24" }}
          >
            <span className="text-lg" style={{ color: "#FBBF24" }}>⚠</span>
            <p className="text-sm" style={{ color: "#FBBF24" }}>
              <strong>{unsignedCount}</strong>{" "}
              {unsignedCount === 1 ? "member hasn't" : "members haven't"} signed everything
              you&apos;ve marked required. They&apos;ll be asked at their next check-in.
            </p>
          </div>
        )}

        <section className="mt-10">
          <div
            className="rounded-xl p-6 flex flex-wrap items-center gap-x-6 gap-y-3"
            style={{ backgroundColor: "#1A1A1A", border: "1px solid #333333" }}
          >
            <div>
              <p className="text-sm font-medium" style={{ color: "#FFFFFF" }}>
                A member is a minor under age
              </p>
              <p className="text-xs mt-1 max-w-md" style={{ color: "#555555" }}>
                Anyone below this age needs a parent or guardian signature on documents
                marked &ldquo;guardian required&rdquo;. Set it to match your waiver and your
                state&apos;s rule — we can&apos;t advise on which it is.
              </p>
            </div>
            <select
              value={settings?.minorAgeThreshold ?? 18}
              onChange={(e) => handleThresholdChange(e.target.value)}
              disabled={!settings}
              className="input w-24 ml-auto"
            >
              {Array.from({ length: 13 }, (_, i) => 13 + i).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
        </section>

        <section className="mt-8">
          <div className="rounded-xl overflow-hidden" style={{ border: "1px solid #333333" }}>
            {templates === undefined ? (
              <p className="px-6 py-10 text-center text-sm" style={{ color: "#555555" }}>
                Loading…
              </p>
            ) : list.length === 0 ? (
              <EmptyState onAdd={() => setModal({ mode: "create", isWaiver: true, requiresGuardianForMinors: true })} />
            ) : (
              list.map((t, i) => (
                <div
                  key={t._id}
                  className="flex items-start gap-4 px-6 py-5"
                  style={{ borderTop: i === 0 ? undefined : "1px solid #333333" }}
                >
                  <div className="shrink-0 mt-0.5">
                    {t.isWaiver ? <LockIcon /> : <DocIcon />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="font-medium" style={{ color: "#FFFFFF" }}>
                        {t.title}
                      </span>
                      {/* The waiver is required by definition, so it gets one
                          chip rather than two saying the same thing. */}
                      {t.isWaiver ? (
                        <Chip color="#E02020" bg="#2A0A0A">Waiver · required</Chip>
                      ) : t.requiredAtSignup ? (
                        <Chip color="#E02020" bg="#2A0A0A">Required before check-in</Chip>
                      ) : (
                        <Chip color="#888888" bg="#1A1A1A">Collected at signup</Chip>
                      )}
                      {t.requiresGuardianForMinors && (
                        <Chip color="#FBBF24" bg="#2A1F0A">Guardian required for minors</Chip>
                      )}
                    </div>
                    <p
                      className="text-xs mt-2 truncate"
                      style={{ color: "#555555" }}
                      title={t.content}
                    >
                      {t.content.replace(/\s+/g, " ").slice(0, 140) || "No text yet"}
                    </p>
                  </div>
                  <div className="flex gap-3 shrink-0">
                    <button
                      onClick={() => setModal({ mode: "edit", template: t })}
                      className="text-xs transition-colors hover:text-white"
                      style={{ color: "#888888" }}
                    >
                      Edit
                    </button>
                    {t.isWaiver ? (
                      // The lock is the explanation, not just decoration: the
                      // waiver is what gates check-in, so deleting it would
                      // silently switch the gate off for the whole roster.
                      // deleteTemplate refuses it server-side too.
                      <span
                        className="text-xs"
                        style={{ color: "#555555" }}
                        title="The waiver can't be deleted — it's what gates check-in. Edit its text instead."
                      >
                        Locked
                      </span>
                    ) : (
                      <button
                        onClick={() => handleDelete(t)}
                        className="text-xs transition-colors"
                        style={{ color: "#F87171" }}
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </main>

      {modal && <TemplateModal draft={modal} onClose={() => setModal(null)} />}
    </div>
  );
}

function Chip({ children, color, bg }: { children: React.ReactNode; color: string; bg: string }) {
  return (
    <span
      className="inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold"
      style={{ backgroundColor: bg, color }}
    >
      {children}
    </span>
  );
}

function LockIcon() {
  return (
    <svg
      className="w-5 h-5"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.7}
      style={{ color: "#E02020" }}
      aria-label="Locked"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"
      />
    </svg>
  );
}

function DocIcon() {
  return (
    <svg
      className="w-5 h-5"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.7}
      style={{ color: "#555555" }}
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M19.5 14.25v-8.25A2.25 2.25 0 0017.25 3.75h-10.5A2.25 2.25 0 004.5 6v12a2.25 2.25 0 002.25 2.25h6M8.25 8.25h7.5M8.25 12h7.5M8.25 15.75h4.5"
      />
    </svg>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center gap-4 py-20 text-center px-8">
      <div
        className="w-14 h-14 rounded-full flex items-center justify-center"
        style={{ backgroundColor: "#222222" }}
      >
        <LockIcon />
      </div>
      <div>
        <p className="font-medium text-lg" style={{ color: "#FFFFFF" }}>
          No waiver yet
        </p>
        <p className="text-sm mt-1 max-w-md" style={{ color: "#555555" }}>
          Paste in the waiver you already use. We won&apos;t write it for you — we don&apos;t
          give legal advice — but once it&apos;s here, every member signs it on the tablet and
          you never chase a piece of paper again.
        </p>
      </div>
      <button
        onClick={onAdd}
        className="rounded-lg text-sm font-semibold px-4 py-2 transition-colors"
        style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
      >
        + Add Your Waiver
      </button>
    </div>
  );
}
