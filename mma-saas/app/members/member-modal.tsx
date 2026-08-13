"use client";
import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { ErrorToast, getErrorMessage } from "../components/error-toast";

type Member = {
  _id: Id<"members">;
  name: string;
  plan: string;
  status: "active" | "inactive";
  email?: string;
  phone?: string;
  beltRank?: string;
  dob?: string;
  dobUnverified?: boolean;
  address?: string;
  smsConsentConfirmed?: boolean;
  smsConsentConfirmedAt?: number;
};

type Props = {
  member?: Member;
  onClose: () => void;
};

export default function MemberModal({ member, onClose }: Props) {
  const add = useMutation(api.members.add);
  const update = useMutation(api.members.update);
  const confirmDob = useMutation(api.members.confirmDob);

  const [name, setName] = useState(member?.name ?? "");
  const [plan, setPlan] = useState(member?.plan ?? "");
  const [status, setStatus] = useState<"active" | "inactive">(member?.status ?? "active");
  const [email, setEmail] = useState(member?.email ?? "");
  const [phone, setPhone] = useState(member?.phone ?? "");
  const [beltRank, setBeltRank] = useState(member?.beltRank ?? "");
  // "YYYY-MM-DD", which is exactly what <input type="date"> reads and writes —
  // no parsing, no formatting, no Date object anywhere near it. See the schema
  // comment on members.dob for why that matters.
  const [dob, setDob] = useState(member?.dob ?? "");
  const [address, setAddress] = useState(member?.address ?? "");
  const [smsConsent, setSmsConsent] = useState(false);
  const [consentError, setConsentError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Local, so the prompt disappears the instant it's confirmed rather than
  // after the members query round-trips. Also suppressed the moment the owner
  // edits the date at all — at that point they are clearly looking at it, and
  // "nobody checked this" nagging under a field being actively typed into
  // reads as a bug. The server clears the flag on save either way
  // (members.ts:update), so this is presentation only.
  const [dobConfirmed, setDobConfirmed] = useState(false);
  const [confirmingDob, setConfirmingDob] = useState(false);
  const dobUnverified =
    !!member?.dobUnverified && !dobConfirmed && dob === (member?.dob ?? "");

  const trimmedPhone = phone.trim();
  const originalPhone = member?.phone ?? "";
  const alreadyConfirmedForThisPhone =
    !!member?.smsConsentConfirmed && trimmedPhone === originalPhone;
  const needsConsent = trimmedPhone !== "" && !alreadyConfirmedForThisPhone;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (needsConsent && !smsConsent) {
      setConsentError(true);
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      const smsConsentConfirmed = trimmedPhone === "" ? false : true;
      const smsConsentConfirmedAt =
        trimmedPhone === ""
          ? undefined
          : needsConsent
          ? Date.now()
          : member?.smsConsentConfirmedAt;

      const fields = {
        name,
        plan,
        status,
        email: email || undefined,
        phone: trimmedPhone || undefined,
        beltRank: beltRank || undefined,
        // Sent as "" rather than undefined when empty, ON PURPOSE. Convex
        // strips undefined properties at the client boundary, so `undefined`
        // means "I didn't mention this field" and leaves the stored value
        // alone — an owner clearing a wrong date of birth and saving would
        // watch it come straight back. "" is what convex/members.ts's
        // normalizedDocumentFields reads as an explicit clear.
        dob,
        address,
        smsConsentConfirmed,
        smsConsentConfirmedAt,
      };
      if (member) {
        await update({ id: member._id, ...fields });
      } else {
        await add(fields);
      }
      onClose();
    } catch (err) {
      setSaveError(getErrorMessage(err, "Couldn't save this member — try refreshing the page."));
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ backgroundColor: "rgba(0,0,0,0.75)" }}>
      <div className="w-full max-w-md rounded-xl p-8 max-h-[90vh] overflow-y-auto" style={{ backgroundColor: "#222222", border: "1px solid #333333" }}>
        <h2 className="text-xl mb-6" style={{ color: "#FFFFFF", fontWeight: 500 }}>
          {member ? "Edit Member" : "Add Member"}
        </h2>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <Field label="Full Name">
            <input required value={name} onChange={(e) => setName(e.target.value)} className="input" placeholder="John Smith" />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Email">
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="input" placeholder="john@email.com" />
            </Field>
            <Field label="Phone">
              <input
                type="tel"
                value={phone}
                onChange={(e) => {
                  setPhone(e.target.value);
                  setConsentError(false);
                }}
                className="input"
                placeholder="(720) 555-0100"
              />
            </Field>
          </div>

          {needsConsent && (
            <div className="flex flex-col gap-1.5 rounded-lg p-3" style={{ backgroundColor: "#1A1A1A", border: "0.5px solid #333333" }}>
              <label className="flex items-start gap-2 text-sm cursor-pointer" style={{ color: "#CCCCCC" }}>
                <input
                  type="checkbox"
                  checked={smsConsent}
                  onChange={(e) => {
                    setSmsConsent(e.target.checked);
                    if (e.target.checked) setConsentError(false);
                  }}
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
                    onClick={(e) => e.stopPropagation()}
                    className="underline"
                    style={{ color: "#CCCCCC" }}
                  >
                    Terms of Service
                  </a>
                  .
                </span>
              </label>
              {consentError && (
                <p className="text-xs" style={{ color: "#E02020" }}>
                  You must confirm SMS consent before saving a phone number.
                </p>
              )}
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            <Field label="Plan">
              <input required value={plan} onChange={(e) => setPlan(e.target.value)} className="input" placeholder="BJJ Monthly" />
            </Field>
            <Field label="Belt Rank">
              <input value={beltRank} onChange={(e) => setBeltRank(e.target.value)} className="input" placeholder="Blue Belt" />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Date of Birth">
              <input
                type="date"
                value={dob}
                onChange={(e) => setDob(e.target.value)}
                className="input"
              />
            </Field>
            <Field label="Address">
              <input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                className="input"
                placeholder="1200 N Nevada Ave"
              />
            </Field>
          </div>
          {/* Not decoration on a signup form: convex/documents.ts:signDocument
              refuses to sign a guardian-requiring waiver for a member whose
              age it can't determine, so a blank date of birth becomes a member
              stuck at the kiosk. Worth an owner filling in from paper records
              before a kids' class. */}
          {!dob && (
            <p className="text-xs -mt-2" style={{ color: "#555555" }}>
              Without a date of birth we can&apos;t tell whether a guardian has to sign this
              member&apos;s waiver — they&apos;ll be asked for it at the kiosk.
            </p>
          )}
          {/* The only place the unverified-DOB gap is closeable. This date came
              off the tablet, typed by whoever was holding it, and it is the
              single input to the guardian rule — see the schema comment on
              members.dobUnverified. Deliberately a prompt and not a block:
              every kiosk signup starts out flagged, so blocking anything on it
              would break the front door. */}
          {dobUnverified && (
            <div
              className="rounded-lg p-3 -mt-2 flex flex-wrap items-center gap-x-4 gap-y-2"
              style={{ backgroundColor: "#2A1F0A", border: "1px solid #FBBF24" }}
            >
              <p className="text-xs flex-1 min-w-[14rem]" style={{ color: "#FBBF24" }}>
                This date of birth was typed on the tablet and nobody here has checked it.
                It decides whether a guardian has to sign — correct it above, or confirm it.
              </p>
              <button
                type="button"
                disabled={confirmingDob}
                onClick={async () => {
                  if (!member) return;
                  setConfirmingDob(true);
                  setSaveError(null);
                  try {
                    await confirmDob({ memberId: member._id });
                    setDobConfirmed(true);
                  } catch (err) {
                    setSaveError(
                      getErrorMessage(err, "Couldn't confirm that — try refreshing the page.")
                    );
                  } finally {
                    setConfirmingDob(false);
                  }
                }}
                className="rounded-lg text-xs font-semibold px-3 py-1.5 transition-colors disabled:opacity-50 shrink-0"
                style={{ backgroundColor: "#FBBF24", color: "#0D0D0D" }}
              >
                {confirmingDob ? "Confirming…" : "It's correct"}
              </button>
            </div>
          )}
          <Field label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value as "active" | "inactive")} className="input">
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </Field>
          {saveError && <ErrorToast message={saveError} />}
          <div className="flex gap-3 mt-2">
            <button
              type="submit"
              disabled={saving}
              className="flex-1 rounded-lg font-semibold py-2 transition-colors disabled:opacity-50"
              style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
              onMouseEnter={e => { if (!saving) e.currentTarget.style.backgroundColor = "#B91C1C"; }}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = "#E02020")}
            >
              {saving ? "Saving…" : member ? "Save Changes" : "Add Member"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-lg font-semibold py-2 transition-colors"
              style={{ backgroundColor: "#1A1A1A", color: "#FFFFFF", border: "0.5px solid #333333" }}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = "#222222")}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = "#1A1A1A")}
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs uppercase tracking-wider" style={{ color: "#555555" }}>{label}</label>
      {children}
    </div>
  );
}
