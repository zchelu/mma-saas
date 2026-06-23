"use client";
import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";

type Member = {
  _id: Id<"members">;
  name: string;
  plan: string;
  status: "active" | "inactive";
  email?: string;
  phone?: string;
  beltRank?: string;
};

type Props = {
  member?: Member;
  onClose: () => void;
};

export default function MemberModal({ member, onClose }: Props) {
  const add = useMutation(api.members.add);
  const update = useMutation(api.members.update);

  const [name, setName] = useState(member?.name ?? "");
  const [plan, setPlan] = useState(member?.plan ?? "");
  const [status, setStatus] = useState<"active" | "inactive">(member?.status ?? "active");
  const [email, setEmail] = useState(member?.email ?? "");
  const [phone, setPhone] = useState(member?.phone ?? "");
  const [beltRank, setBeltRank] = useState(member?.beltRank ?? "");
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const fields = {
        name,
        plan,
        status,
        email: email || undefined,
        phone: phone || undefined,
        beltRank: beltRank || undefined,
      };
      if (member) {
        await update({ id: member._id, ...fields });
      } else {
        await add(fields);
      }
      onClose();
    } catch (err) {
      console.error("Failed to save member:", err);
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
              <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className="input" placeholder="(720) 555-0100" />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Plan">
              <input required value={plan} onChange={(e) => setPlan(e.target.value)} className="input" placeholder="BJJ Monthly" />
            </Field>
            <Field label="Belt Rank">
              <input value={beltRank} onChange={(e) => setBeltRank(e.target.value)} className="input" placeholder="Blue Belt" />
            </Field>
          </div>
          <Field label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value as "active" | "inactive")} className="input">
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </Field>
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
