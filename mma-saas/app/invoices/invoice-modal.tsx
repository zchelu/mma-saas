"use client";
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";

type Invoice = {
  _id: Id<"invoices">;
  memberId: Id<"members">;
  amount: number;
  status: "paid" | "unpaid";
  dueDate: string;
};

type Props = {
  invoice?: Invoice;
  onClose: () => void;
};

export default function InvoiceModal({ invoice, onClose }: Props) {
  const add = useMutation(api.invoices.add);
  const update = useMutation(api.invoices.update);
  const members = useQuery(api.members.getAll);

  const [memberId, setMemberId] = useState<string>(invoice?.memberId ?? "");
  const [amount, setAmount] = useState(String(invoice?.amount ?? ""));
  const [status, setStatus] = useState<"paid" | "unpaid">(invoice?.status ?? "unpaid");
  const [dueDate, setDueDate] = useState(invoice?.dueDate ?? "");
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!memberId) return;
    setSaving(true);
    const fields = { memberId: memberId as Id<"members">, amount: Number(amount), status, dueDate };
    if (invoice) {
      await update({ id: invoice._id, ...fields });
    } else {
      await add(fields);
    }
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: "rgba(0,0,0,0.75)" }}>
      <div className="w-full max-w-md rounded-xl p-8" style={{ backgroundColor: "#222222", border: "1px solid #333333" }}>
        <h2 className="text-xl mb-6" style={{ color: "#FFFFFF", fontWeight: 500 }}>
          {invoice ? "Edit Invoice" : "New Invoice"}
        </h2>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <Field label="Member">
            <select required value={memberId} onChange={(e) => setMemberId(e.target.value)} className="input">
              <option value="">Select a member...</option>
              {(members ?? []).map((m) => (
                <option key={m._id} value={m._id}>{m.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Amount ($)">
            <input required type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="input" placeholder="150.00" />
          </Field>
          <Field label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value as "paid" | "unpaid")} className="input">
              <option value="unpaid">Unpaid</option>
              <option value="paid">Paid</option>
            </select>
          </Field>
          <Field label="Due Date">
            <input required type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="input" />
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
              {saving ? "Saving…" : invoice ? "Save Changes" : "Create Invoice"}
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
