"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { getErrorMessage } from "../components/error-toast";

// The two URLs a gym owner has to hand out, plus the consent gap those URLs
// silently create.
//
// WHY THIS EXISTS. Nothing in the app linked to /consent/[gymSlug] or to the
// check-in kiosk. The only way to produce either URL was to read the gyms table
// in the Convex dashboard and assemble it by hand — which meant the founder had
// to do it for every gym, and an owner who lost the link had no way to recover
// it. A gym that can't collect member consent can never send a single retention
// text, so "owner lost their consent link" and "gym is dead" are the same event.
//
// The kiosk URLs are /checkin?k=<kioskToken> and /kiosk/signup?k=<kioskToken>.
// The token is the device credential (gyms.kioskToken, 96 CSPRNG bits) and is
// rotatable from this card. Anyone with the current link can check anyone in
// and can see the roster; it is a front-desk tablet, same trust model as a
// paper sign-in sheet. Worth knowing before it gets shared more widely than
// that — and why the regenerate button sits right next to it.

const CARD = { backgroundColor: "#222222", border: "1px solid #333333" };

// `gymId` is still accepted and deliberately unused. The dashboard passes it,
// and that file belongs to another lane's uncommitted work right now — keeping
// the prop optional lets this change land without touching theirs. The kiosk
// links no longer contain a gym id at all; they carry the rotatable token
// below. Drop the prop when the lanes next meet.
export default function OwnerLinks({ slug }: { slug: string | null; gymId?: string | null }) {
  // Rendered client-side because both URLs need the real origin, and because
  // hardcoding a base URL is how a link ends up pointing at the wrong
  // environment. window.location is the one source that can't be stale.
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  // THE KIOSK LINKS CARRY A ROTATABLE TOKEN, NOT THE GYM ID.
  //
  // They used to embed the gym's raw document id, which made a bookmarked
  // kiosk URL the whole credential: anyone holding one could list the roster
  // and read every member's date of birth, home address and minor status
  // through the documents endpoints. Now the tablet carries a token the owner
  // can regenerate — see the schema comment on gyms.kioskToken.
  const kiosk = useQuery(api.gyms.getKioskToken);
  const rotate = useMutation(api.gyms.rotateKioskToken);
  const [rotating, setRotating] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);

  const token = kiosk?.kioskToken ?? null;
  const consentUrl = slug ? `${origin}/consent/${slug}` : null;
  const kioskUrl = token ? `${origin}/checkin?k=${token}` : null;
  const signupUrl = token ? `${origin}/kiosk/signup?k=${token}` : null;

  async function handleRotate(firstTime: boolean) {
    if (
      !firstTime &&
      !confirm(
        "Regenerate the kiosk code? Every tablet bookmarked to the old link stops working immediately and will need the new one."
      )
    )
      return;
    setRotating(true);
    setRotateError(null);
    try {
      await rotate({});
    } catch (err) {
      setRotateError(
        getErrorMessage(err, "Couldn't generate a kiosk code — try refreshing the page.")
      );
    } finally {
      setRotating(false);
    }
  }

  return (
    <div className="mt-12">
      <h2 className="text-xl mb-1" style={{ color: "#FFFFFF", fontWeight: 500 }}>
        Your gym&apos;s links
      </h2>
      <p className="text-sm mb-6" style={{ color: "#888888" }}>
        Hand these out. The first one is how members opt in to texts — nobody can be
        texted until they do.
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <LinkCard
          title="Member opt-in page"
          blurb="Send this to your members. Until someone opts in here, KombatDesk will not text them."
          url={consentUrl}
          missing="Finish setting up your gym name to generate this link."
        />
        <LinkCard
          title="Front-desk check-in kiosk"
          blurb="Open this on the tablet at your door. Members tap their name on the way in."
          url={kioskUrl}
          missing="Generate your kiosk code below to create this link."
        />
        <LinkCard
          title="New-member signup kiosk"
          blurb="Hand the tablet to someone walking in off the street. They sign your waiver before they step on the mat."
          url={signupUrl}
          missing="Generate your kiosk code below to create this link."
        />
      </div>

      <div
        className="mt-6 rounded-xl px-5 py-4 flex flex-wrap items-center gap-x-6 gap-y-3"
        style={{ backgroundColor: "#1A1A1A", border: "1px solid #333333" }}
      >
        <div className="min-w-0">
          <p className="text-sm font-medium" style={{ color: "#FFFFFF" }}>
            {token ? "Your kiosk code" : "No kiosk code yet"}
          </p>
          <p className="text-xs mt-1 max-w-xl" style={{ color: "#555555" }}>
            {token
              ? "Both kiosk links above carry this code. Regenerate it if a tablet goes missing or someone who shouldn't have the link still does — every old bookmark stops working the moment you do."
              : "The tablet at your door needs a code to talk to your gym. Generate one to create the two kiosk links above."}
          </p>
          {rotateError && (
            <p className="text-xs mt-2" style={{ color: "#F87171" }}>
              {rotateError}
            </p>
          )}
        </div>
        <button
          onClick={() => handleRotate(!token)}
          disabled={rotating || kiosk === undefined}
          className="rounded-lg text-sm font-semibold px-4 py-2 transition-colors ml-auto disabled:opacity-50"
          style={{
            backgroundColor: token ? "#222222" : "#E02020",
            border: token ? "1px solid #333333" : undefined,
            color: "#FFFFFF",
          }}
        >
          {rotating ? "Working…" : token ? "Regenerate code" : "Generate kiosk code"}
        </button>
      </div>

      <ConsentGap />
      <AutomaticMessage />
    </div>
  );
}

const DEFAULT_PREVIEW =
  "Hey Alex, we missed you at the gym! Come back this week and keep that momentum going. - Your Gym.";

// The automatic winback text is the only message that goes out in the owner's
// name without them writing it. Until this field existed it was hardcoded at
// convex/sendRetentionTexts.ts:202 and changing it meant a deploy.
function AutomaticMessage() {
  const saved = useQuery(api.gyms.getRetentionMessageTemplate);
  const save = useMutation(api.gyms.setRetentionMessageTemplate);

  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  // `saved` is undefined while loading and null when unset. Only adopt it as
  // the draft once, on first load — re-syncing on every query update would
  // wipe what the owner is mid-way through typing.
  const value = draft ?? saved ?? "";

  async function onSave() {
    if (saving) return;
    setSaving(true);
    setStatus(null);
    try {
      await save({ template: value });
      setStatus(
        value.trim().length === 0
          ? "Cleared — back to the default wording."
          : "Saved. This goes out on the next automatic send."
      );
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Couldn't save that. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl p-6 mt-6" style={{ backgroundColor: "#222222", border: "1px solid #333333" }}>
      <p className="text-sm font-semibold mb-1" style={{ color: "#FFFFFF" }}>
        Your automatic check-in text
      </p>
      <p className="text-xs mb-4 leading-relaxed" style={{ color: "#888888" }}>
        Sent in your name when a member goes quiet. Use <code style={{ color: "#CCCCCC" }}>{"{name}"}</code> and
        it fills in their first name. Leave it empty to use the default.
      </p>

      <textarea
        value={value}
        onChange={(e) => setDraft(e.target.value)}
        rows={3}
        maxLength={480}
        placeholder={DEFAULT_PREVIEW}
        className="w-full rounded-lg px-4 py-3 text-sm focus:outline-none"
        style={{ backgroundColor: "#1A1A1A", border: "1px solid #333333", color: "#FFFFFF" }}
      />

      <p className="text-xs mt-2" style={{ color: "#555555" }}>
        &ldquo;Reply STOP to opt out.&rdquo; is added automatically to every message — you don&apos;t
        need to type it, and it can&apos;t be removed.
      </p>

      <div className="flex items-center gap-3 mt-4">
        <button
          type="button"
          onClick={onSave}
          disabled={saving || saved === undefined}
          className="text-xs font-semibold rounded-lg px-4 py-2 disabled:opacity-40"
          style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
        >
          {saving ? "Saving…" : "Save message"}
        </button>
        {status && <span className="text-xs" style={{ color: "#888888" }}>{status}</span>}
      </div>
    </div>
  );
}

function LinkCard({
  title,
  blurb,
  url,
  missing,
}: {
  title: string;
  blurb: string;
  url: string | null;
  missing: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked by permissions or a non-secure context. The
      // URL is on screen and selectable either way, so failing quietly is
      // better than an error the owner can do nothing about.
    }
  }

  return (
    <div className="rounded-xl p-6" style={CARD}>
      <p className="text-sm font-semibold mb-1" style={{ color: "#FFFFFF" }}>{title}</p>
      <p className="text-xs mb-4 leading-relaxed" style={{ color: "#888888" }}>{blurb}</p>

      {url ? (
        <div className="flex items-center gap-2">
          <code
            className="flex-1 text-xs rounded-lg px-3 py-2 overflow-x-auto whitespace-nowrap"
            style={{ backgroundColor: "#1A1A1A", color: "#CCCCCC", border: "1px solid #333333" }}
          >
            {url}
          </code>
          <button
            type="button"
            onClick={copy}
            className="text-xs font-semibold rounded-lg px-3 py-2 shrink-0"
            style={{ backgroundColor: copied ? "#1A1A1A" : "#E02020", color: "#FFFFFF" }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      ) : (
        <p className="text-xs" style={{ color: "#FF6B6B" }}>{missing}</p>
      )}
    </div>
  );
}

// The consent gap. See convex/consent.ts:listPendingConsent for the full
// reasoning — in short, a consent submission only takes effect if the phone
// number already matched a roster member at the moment it was submitted, and
// nothing anywhere told the owner when it didn't.
function ConsentGap() {
  const pending = useQuery(api.consent.listPendingConsent);
  const applyPending = useMutation(api.consent.applyPendingConsent);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  if (!pending || pending.length === 0) return null;

  const onRoster = pending.filter((p) => p.nowOnRoster);
  const notOnRoster = pending.filter((p) => !p.nowOnRoster);

  async function apply() {
    if (applying) return;
    setApplying(true);
    setResult(null);
    try {
      const { applied } = await applyPending({});
      setResult(
        applied === 0
          ? "Nothing to apply — those members already had consent recorded."
          : `Consent applied to ${applied} member${applied === 1 ? "" : "s"}. They can be texted now.`
      );
    } catch {
      setResult("Couldn't apply that just now. Try again in a moment.");
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="rounded-xl p-6 mt-6" style={{ backgroundColor: "#1A1A1A", border: "1px solid #E02020" }}>
      <p className="text-sm font-semibold mb-1" style={{ color: "#FFFFFF" }}>
        {pending.length} opt-in{pending.length === 1 ? "" : "s"} didn&apos;t reach a member
      </p>
      <p className="text-xs mb-5 leading-relaxed" style={{ color: "#CCCCCC" }}>
        These people filled in your opt-in page, but the phone number they typed didn&apos;t
        match anyone on your roster at the time — so KombatDesk still can&apos;t text them.
        They think they signed up.
      </p>

      {onRoster.length > 0 && (
        <div className="mb-5">
          <p className="text-xs font-semibold mb-2" style={{ color: "#FFFFFF" }}>
            {onRoster.length} {onRoster.length === 1 ? "is" : "are"} on your roster now
          </p>
          <p className="text-xs mb-3" style={{ color: "#888888" }}>
            You added them after they opted in. Their consent just needs applying.
          </p>
          <PendingList rows={onRoster} />
          <button
            type="button"
            onClick={apply}
            disabled={applying}
            className="mt-3 text-xs font-semibold rounded-lg px-4 py-2 disabled:opacity-40"
            style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
          >
            {applying ? "Applying…" : `Apply consent to ${onRoster.length}`}
          </button>
        </div>
      )}

      {notOnRoster.length > 0 && (
        <div>
          <p className="text-xs font-semibold mb-2" style={{ color: "#FFFFFF" }}>
            {notOnRoster.length} {notOnRoster.length === 1 ? "isn't" : "aren't"} on your roster
          </p>
          <p className="text-xs mb-3" style={{ color: "#888888" }}>
            Add them as members with this exact phone number, then come back and apply their
            consent.
          </p>
          <PendingList rows={notOnRoster} />
        </div>
      )}

      {result && (
        <p className="text-xs mt-4" style={{ color: "#CCCCCC" }}>{result}</p>
      )}
    </div>
  );
}

function PendingList({
  rows,
}: {
  rows: { submittedName: string; submittedPhone: string; consentedAt: number }[];
}) {
  return (
    <ul className="flex flex-col gap-1">
      {rows.slice(0, 10).map((r) => (
        <li
          key={`${r.submittedPhone}-${r.consentedAt}`}
          className="flex items-center justify-between text-xs rounded-lg px-3 py-2"
          style={{ backgroundColor: "#222222" }}
        >
          <span style={{ color: "#FFFFFF" }}>{r.submittedName}</span>
          <span style={{ color: "#888888" }}>{r.submittedPhone}</span>
        </li>
      ))}
      {rows.length > 10 && (
        <li className="text-xs px-3 py-1" style={{ color: "#888888" }}>
          + {rows.length - 10} more
        </li>
      )}
    </ul>
  );
}
