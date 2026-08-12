"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import SignaturePad from "./signature-pad";
import { getErrorMessage } from "./error-toast";
import { useLocalDate } from "./use-local-date";

// The signing step, shared by BOTH kiosk entry points:
//   - app/kiosk/signup — a new member, immediately after their row is created
//   - app/checkin      — an existing member with an unsigned waiver, stopped
//                        at the door before their check-in completes
//
// One component on purpose. The scroll gate, the guardian rule and the
// signature payload are the parts with legal weight, and two copies of them
// is how one quietly stops requiring a guardian.
//
// Sized for a tablet used standing up, by someone holding a gym bag: large
// type, large tap targets, one decision per screen.
//
// WHY THE DETAILS ARE A SEPARATE SCREEN. A member whose row has no date of
// birth — or no address, for a waiver that prints one — has to supply it
// before the document can be rendered with their details in it. The rendered
// preview comes from the server, keyed on those values, so that what is on
// screen is exactly what gets stored. Feeding a live-typed value into a Convex
// query argument would change the args on every keystroke, and Convex returns
// `undefined` for args it has no cached result for: the whole tree would
// unmount mid-word, taking the focus, the iOS keyboard, and any signature
// already captured with it. Collecting the details first and committing them
// once means the query args change exactly ONCE, before any pad is enabled.

type Props = {
  /** The kiosk device's token — see convex/gyms.ts:tryGetKioskGym. */
  kioskToken: string;
  memberId: Id<"members">;
  /**
   * New-member signup collects every outstanding document; the check-in gate
   * collects only the required one, because the door must not be blocked by a
   * photo release. See convex/documents.ts:isRequired.
   */
  includeOptional?: boolean;
  /** Called once every outstanding document has been signed. */
  onDone: () => void;
  /** Back out — the kiosk returns to idle. Nothing is signed. */
  onCancel: () => void;
  cancelLabel?: string;
};

type Details = { dob?: string; address?: string };

export default function WaiverStep({
  kioskToken,
  memberId,
  includeOptional = false,
  onDone,
  onCancel,
  cancelLabel = "Cancel",
}: Props) {
  // The tablet's own calendar date, never the server's — lib/localDate.ts.
  // Null during SSR; see use-local-date.ts.
  const today = useLocalDate();

  // Committed once, by the Continue button on the details screen. Never bound
  // directly to an input — see the header comment.
  const [details, setDetails] = useState<Details | null>(null);

  const data = useQuery(
    api.documents.getUnsignedRequiredDocs,
    today
      ? {
          kioskToken,
          memberId,
          todayLocalDate: today,
          includeOptional,
          ...(details?.dob ? { dobDraft: details.dob } : {}),
          ...(details?.address ? { addressDraft: details.address } : {}),
        }
      : "skip"
  );

  const signDocument = useMutation(api.documents.signDocument);

  // Documents already signed in THIS session. The server query removes a
  // document as soon as it's signed, so the list shrinks under us — advancing
  // an index into a shrinking array walks off the end and strands the kiosk.
  // Tracking what we've signed and always taking the first remaining item is
  // correct for both the shrink and the instant before the query catches up.
  const [signedIds, setSignedIds] = useState<Set<string>>(() => new Set());
  // null means "the signer hasn't touched this yet", which lets the field
  // default to the roster name WITHOUT an effect that writes state (the
  // react-hooks/set-state-in-effect shape this codebase documents avoiding).
  const [signerNameDraft, setSignerNameDraft] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [guardianName, setGuardianName] = useState("");
  const [guardianSignature, setGuardianSignature] = useState<string | null>(null);
  // Holds the exact document text that was scrolled to the end, not a boolean,
  // so the gate can't be satisfied for one document and silently carry over to
  // the next. It does NOT defend against the owner editing a template while
  // someone is mid-read: DocumentScroller is keyed on the document id, so the
  // box keeps its scroll position across a text change, and a reader already
  // at the bottom re-satisfies the gate immediately. Narrow, and the fix is to
  // key the scroller on the text as well — not done, because remounting on
  // every keystroke of a concurrent edit is worse than the case it prevents.
  const [scrolledText, setScrolledText] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stable, so DocumentScroller's effect doesn't tear down and rebuild its
  // ResizeObserver on every parent render.
  const handleReachedEnd = useCallback((text: string) => setScrolledText(text), []);

  const remaining = (data?.documents ?? []).filter((d) => !signedIds.has(d._id));
  const current = remaining[0];
  const isMinor = data?.isMinor === true;
  const needsGuardian = isMinor && !!current?.requiresGuardianForMinors;

  // Starting total = still outstanding + already signed this session. Derived
  // rather than stashed, so "Document 2 of 3" doesn't count down.
  const total = remaining.length + signedIds.size;
  const position = signedIds.size + 1;

  const signerName = signerNameDraft ?? data?.memberName ?? "";

  // Nothing outstanding — a member who already signed, a gym with no waiver
  // configured, or the last document of this session just went through.
  //
  // Fired at most ONCE. onDone is a fresh closure on every parent render, so
  // without the latch this effect re-runs and calls it repeatedly — and in
  // /checkin onDone records the check-in, which would log a second visit.
  const doneRef = useRef(false);
  useEffect(() => {
    if (!data || remaining.length > 0 || doneRef.current) return;
    doneRef.current = true;
    onDone();
  }, [data, remaining.length, onDone]);

  async function handleSubmit() {
    if (!current || !signature || !today) return;
    setSubmitting(true);
    setError(null);
    try {
      await signDocument({
        kioskToken,
        memberId,
        templateId: current._id,
        signatureData: signature,
        signerName,
        todayLocalDate: today,
        ...(needsGuardian && guardianSignature
          ? { guardianName, guardianSignatureData: guardianSignature }
          : {}),
        ...(details?.dob ? { dob: details.dob } : {}),
        ...(details?.address ? { address: details.address } : {}),
      });

      // Reset every per-document field before advancing. A signature carried
      // over to the next document would be the same image attached to two
      // different agreements.
      setSignature(null);
      setGuardianSignature(null);
      setGuardianName("");
      setScrolledText(null);
      // Advancing is subtractive, not an index bump — see signedIds above.
      // The effect watching `remaining` calls onDone when this empties it.
      setSignedIds((prev) => new Set(prev).add(current._id));
    } catch (err) {
      setError(
        getErrorMessage(err, "Couldn't save that signature — check the connection and try again.")
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (data === undefined) {
    return (
      <KioskShell>
        <p className="text-2xl" style={{ color: "#555555" }}>Loading…</p>
      </KioskShell>
    );
  }

  if (data === null) {
    return (
      <KioskShell>
        <p className="text-2xl mb-8" style={{ color: "#888888" }}>
          We couldn&apos;t find that member.
        </p>
        <SecondaryButton onClick={onCancel}>{cancelLabel}</SecondaryButton>
      </KioskShell>
    );
  }

  // Details screen. Rendered before the document appears, so the single
  // query-args change it causes can't disturb a signature or a scroll
  // position — there aren't any yet.
  if ((data.needsDob || data.needsAddress) && details === null) {
    return (
      <DetailsStep
        memberName={data.memberName}
        needsDob={data.needsDob}
        needsAddress={data.needsAddress}
        minorAgeThreshold={data.minorAgeThreshold}
        cancelLabel={cancelLabel}
        onCancel={onCancel}
        onContinue={setDetails}
      />
    );
  }

  if (!current) {
    return (
      <KioskShell>
        <p className="text-2xl" style={{ color: "#555555" }}>Finishing up…</p>
      </KioskShell>
    );
  }

  const canSign = scrolledText === current.renderedContent;
  const guardianComplete = !needsGuardian || (!!guardianSignature && !!guardianName.trim());
  const canSubmit = !!signature && !!signerName.trim() && guardianComplete && !submitting;

  return (
    <div className="min-h-screen" style={{ backgroundColor: "#0D0D0D" }}>
      <div className="max-w-3xl mx-auto px-6 py-10">
        <div className="flex items-start justify-between gap-4 mb-8">
          <div>
            <p
              className="text-sm font-semibold uppercase tracking-widest mb-2"
              style={{ color: "#E02020" }}
            >
              {total > 1 ? `Document ${position} of ${total}` : "Before you train"}
            </p>
            <h1 className="text-4xl font-extrabold tracking-tight" style={{ color: "#FFFFFF" }}>
              {current.title}
            </h1>
            <p className="text-lg mt-2" style={{ color: "#888888" }}>
              {data.memberName}
              {isMinor && (
                <span className="ml-3 text-base font-semibold" style={{ color: "#FBBF24" }}>
                  Under {data.minorAgeThreshold} · guardian signature required
                </span>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="text-base py-3 px-4 rounded-xl shrink-0"
            style={{ color: "#888888" }}
          >
            {cancelLabel}
          </button>
        </div>

        {/* Keyed on the document id so moving to the next one remounts a
            fresh, unscrolled box — a reused scroller would already be at the
            bottom and the gate would be satisfied before anyone read it. */}
        <DocumentScroller
          key={current._id}
          text={current.renderedContent}
          onReachedEnd={handleReachedEnd}
        />

        {!canSign && (
          <p className="text-center text-base mt-4" style={{ color: "#FBBF24" }}>
            Scroll to the end of the document to continue.
          </p>
        )}

        <div
          className="mt-8 flex flex-col gap-8 rounded-2xl p-6"
          style={{
            backgroundColor: "#1A1A1A",
            border: "1px solid #333333",
            opacity: canSign ? 1 : 0.45,
          }}
        >
          <div className="flex flex-col gap-4">
            <KioskField label={needsGuardian ? "Member's printed name" : "Your printed name"}>
              <input
                type="text"
                value={signerName}
                onChange={(e) => setSignerNameDraft(e.target.value)}
                disabled={!canSign}
                className="input"
                style={{ fontSize: "1.25rem", padding: "0.9rem 1rem" }}
              />
            </KioskField>
            {/* Keyed for the same reason as the scroller: the pad owns its own
                ink and "accepted" state, so without a remount the previous
                document's signature would still be on screen — and shown as
                accepted — for the next one. */}
            <SignaturePad
              key={`member-${current._id}`}
              label={needsGuardian ? "Member signature" : "Signature"}
              disabled={!canSign}
              onChange={setSignature}
            />
          </div>

          {needsGuardian && (
            <div className="flex flex-col gap-4 pt-8" style={{ borderTop: "1px dashed #444444" }}>
              <p className="text-base" style={{ color: "#FBBF24" }}>
                {data.memberName} is under {data.minorAgeThreshold}. A parent or legal guardian
                must print their name and sign below.
              </p>
              <KioskField label="Parent / guardian printed name">
                <input
                  type="text"
                  value={guardianName}
                  onChange={(e) => setGuardianName(e.target.value)}
                  disabled={!canSign}
                  className="input"
                  style={{ fontSize: "1.25rem", padding: "0.9rem 1rem" }}
                />
              </KioskField>
              <SignaturePad
                key={`guardian-${current._id}`}
                label="Parent / guardian signature"
                disabled={!canSign}
                onChange={setGuardianSignature}
              />
            </div>
          )}
        </div>

        {error && (
          <div className="mt-6 flex flex-col gap-3">
            <p
              className="text-base px-4 py-3 rounded-xl"
              style={{ backgroundColor: "#2A0A0A", border: "1px solid #F87171", color: "#F87171" }}
            >
              {error}
            </p>
            {/* THE ESCAPE HATCH. Once details are committed this component can
                never route back to DetailsStep on its own, so a server-side
                rejection of what was typed there — a date of birth the server
                won't parse, most likely — left the kiosk with an error naming
                a field that is no longer on screen and no way to fix it but
                Cancel. Only offered when there is something to go back TO. */}
            {details !== null && (
              <button
                type="button"
                onClick={() => {
                  setDetails(null);
                  setError(null);
                }}
                className="self-start rounded-xl px-6 py-3 text-base font-semibold"
                style={{ backgroundColor: "#222222", border: "1px solid #333333", color: "#FFFFFF" }}
              >
                Change the details I entered
              </button>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="w-full mt-8 rounded-2xl text-2xl font-bold py-6 transition-all active:scale-[0.99] disabled:opacity-40"
          style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
        >
          {submitting
            ? "Saving…"
            : remaining.length <= 1
            ? "Submit and finish"
            : "Submit and continue"}
        </button>
        <p className="text-center text-sm mt-4" style={{ color: "#555555" }}>
          Signing records the document exactly as shown above, with today&apos;s date.
        </p>
      </div>
    </div>
  );
}

/**
 * Collects the details the member's row is missing, and commits them in one
 * go. Local state only — nothing here reaches a Convex query argument until
 * Continue is pressed. See the header comment for why that matters.
 */
function DetailsStep({
  memberName,
  needsDob,
  needsAddress,
  minorAgeThreshold,
  cancelLabel,
  onCancel,
  onContinue,
}: {
  memberName: string;
  needsDob: boolean;
  needsAddress: boolean;
  minorAgeThreshold: number;
  cancelLabel: string;
  onCancel: () => void;
  onContinue: (details: Details) => void;
}) {
  const [dob, setDob] = useState("");
  const [address, setAddress] = useState("");

  const ready = (!needsDob || dob !== "") && (!needsAddress || address.trim() !== "");

  return (
    <div className="min-h-screen" style={{ backgroundColor: "#0D0D0D" }}>
      <div className="max-w-2xl mx-auto px-6 py-14">
        <div className="flex items-start justify-between gap-4 mb-8">
          <div>
            <p
              className="text-sm font-semibold uppercase tracking-widest mb-2"
              style={{ color: "#E02020" }}
            >
              One moment
            </p>
            <h1 className="text-4xl font-extrabold tracking-tight" style={{ color: "#FFFFFF" }}>
              A couple of details
            </h1>
            <p className="text-lg mt-2" style={{ color: "#888888" }}>
              {memberName}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="text-base py-3 px-4 rounded-xl shrink-0"
            style={{ color: "#888888" }}
          >
            {cancelLabel}
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!ready) return;
            onContinue({ dob: dob || undefined, address: address.trim() || undefined });
          }}
          className="flex flex-col gap-6"
        >
          {needsDob && (
            <KioskField label="Date of birth">
              <input
                required
                autoFocus
                type="date"
                value={dob}
                onChange={(e) => setDob(e.target.value)}
                className="input"
                style={{ fontSize: "1.35rem", padding: "1rem 1.1rem" }}
              />
              <p className="text-sm" style={{ color: "#888888" }}>
                Anyone under {minorAgeThreshold} needs a parent or guardian to sign as well,
                so we have to ask.
              </p>
            </KioskField>
          )}

          {needsAddress && (
            <KioskField label="Address">
              <input
                required
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="1200 N Nevada Ave, Colorado Springs, CO"
                className="input"
                style={{ fontSize: "1.35rem", padding: "1rem 1.1rem" }}
              />
              <p className="text-sm" style={{ color: "#888888" }}>
                This appears in the document you&apos;re about to sign.
              </p>
            </KioskField>
          )}

          <button
            type="submit"
            disabled={!ready}
            className="w-full rounded-2xl text-2xl font-bold py-6 mt-2 transition-all active:scale-[0.99] disabled:opacity-40"
            style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
          >
            Continue
          </button>
        </form>
      </div>
    </div>
  );
}

/**
 * The document, in a box the signer must scroll to the end of.
 *
 * The gate is genuinely load-bearing — "I was never shown the terms" is the
 * first thing a liability claim argues — so it also handles the case that
 * silently defeats it: a document SHORTER than the box, which can never be
 * scrolled and would otherwise leave the pad disabled forever. Measured on
 * mount and on resize (an iPad rotating), not just on scroll.
 *
 * Reports the text it reached the end OF, rather than a bare `true`, so the
 * parent's gate is tied to specific content instead of to "some scrolling
 * happened somewhere".
 */
function DocumentScroller({
  text,
  onReachedEnd,
}: {
  text: string;
  onReachedEnd: (text: string) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  const check = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // 8px of slack: sub-pixel layout and iOS rubber-band scrolling both make
    // an exact equality check unreachable on a real device.
    const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
    if (atEnd) onReachedEnd(text);
  }, [onReachedEnd, text]);

  useEffect(() => {
    check();
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => check());
    observer.observe(el);
    return () => observer.disconnect();
  }, [check]);

  return (
    <div
      ref={ref}
      onScroll={check}
      className="rounded-2xl px-6 py-6 overflow-y-auto"
      style={{
        backgroundColor: "#FFFFFF",
        color: "#1A1A1A",
        maxHeight: "45vh",
        // Momentum scrolling on iOS; without it a long waiver feels broken.
        WebkitOverflowScrolling: "touch",
        lineHeight: 1.7,
        fontSize: "1.05rem",
        // The owner's text is rendered as plain text, never as HTML — this is
        // gym-supplied content and must not be able to inject markup into the
        // signing screen. whitespace-pre-wrap preserves their paragraphs.
        whiteSpace: "pre-wrap",
      }}
    >
      {text}
    </div>
  );
}

function KioskField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm uppercase tracking-widest" style={{ color: "#888888" }}>
        {label}
      </label>
      {children}
    </div>
  );
}

function KioskShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center text-center px-8"
      style={{ backgroundColor: "#0D0D0D" }}
    >
      {children}
    </div>
  );
}

function SecondaryButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-xl px-8 py-4 text-lg font-semibold"
      style={{ backgroundColor: "#222222", border: "1px solid #333333", color: "#FFFFFF" }}
    >
      {children}
    </button>
  );
}
