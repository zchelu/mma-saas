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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
      <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900 p-8 max-h-[90vh] overflow-y-auto">
        <h2 className="text-xl font-bold mb-6 text-white">
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
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as "active" | "inactive")}
              className="input"
            >
              <option value="active" style={{ background: "#27272a", color: "#fff" }}>Active</option>
              <option value="inactive" style={{ background: "#27272a", color: "#fff" }}>Inactive</option>
            </select>
          </Field>
          <div className="flex gap-3 mt-2">
            <button type="submit" disabled={saving} className="flex-1 rounded-lg bg-white text-black font-semibold py-2 hover:bg-zinc-200 transition-colors disabled:opacity-50">
              {saving ? "Saving…" : member ? "Save Changes" : "Add Member"}
            </button>
            <button type="button" onClick={onClose} className="flex-1 rounded-lg border border-zinc-700 text-zinc-300 font-semibold py-2 hover:bg-zinc-800 transition-colors">
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
      <label className="text-xs text-zinc-400 uppercase tracking-wider">{label}</label>
      {children}
    </div>
  );
}
