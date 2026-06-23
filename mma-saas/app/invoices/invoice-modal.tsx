"use client";
import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";

type Invoice = {
  _id: Id<"invoices">;
  memberName: string;
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

  const [memberName, setMemberName] = useState(invoice?.memberName ?? "");
  const [amount, setAmount] = useState(String(invoice?.amount ?? ""));
  const [status, setStatus] = useState<"paid" | "unpaid">(invoice?.status ?? "unpaid");
  const [dueDate, setDueDate] = useState(invoice?.dueDate ?? "");
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const fields = { memberName, amount: Number(amount), status, dueDate };
    if (invoice) {
      await update({ id: invoice._id, ...fields });
    } else {
      await add(fields);
    }
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900 p-8">
        <h2 className="text-xl font-bold mb-6 text-white">
          {invoice ? "Edit Invoice" : "New Invoice"}
        </h2>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <Field label="Member Name">
            <input required value={memberName} onChange={(e) => setMemberName(e.target.value)} className="input" placeholder="John Smith" />
          </Field>
          <Field label="Amount ($)">
            <input required type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="input" placeholder="150.00" />
          </Field>
          <Field label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value as "paid" | "unpaid")} className="input">
              <option value="unpaid" style={{ background: "#27272a", color: "#fff" }}>Unpaid</option>
              <option value="paid" style={{ background: "#27272a", color: "#fff" }}>Paid</option>
            </select>
          </Field>
          <Field label="Due Date">
            <input required value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="input" placeholder="2026-07-01" />
          </Field>
          <div className="flex gap-3 mt-2">
            <button type="submit" disabled={saving} className="flex-1 rounded-lg bg-white text-black font-semibold py-2 hover:bg-zinc-200 transition-colors disabled:opacity-50">
              {saving ? "Saving…" : invoice ? "Save Changes" : "Create Invoice"}
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
